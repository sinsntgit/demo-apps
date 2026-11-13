"""Predictive analysis: each method end to end through the chat API, plus the engine's own rules."""
import json

import pytest

from tests.conftest import H
from tests.test_platform import ask


def _tables(a):
    return {t["key"]: t for t in a["result"]["tables"] + a["result"]["stats"]}


def test_forecast_runs_on_server_and_shows_the_code(admin, fake_llm):
    client, conn, model = admin
    run = ask(client, conn, model, "Forecast revenue for the next 6 months", predictive=True)["run"]
    a = run["analysis"]
    assert run["status"] == "success" and a["spec"] == {"type": "forecast", "date": "month", "target": "revenue", "horizon": 6}
    r = a["result"]
    assert r["type"] == "forecast" and r["params"] == {"horizon": 6} and len(r["metrics"]) == 4
    plot = r["plots"][0]
    assert plot["kind"] == "line" and [d["role"] for d in plot["datasets"]] == ["actual", "forecast", "upper", "lower"]
    assert len(plot["labels"]) == 21 + 6 and plot["labels"][-1] == "2026-03"
    t = _tables(a)
    assert t["forecast"]["row_count"] == 6 and all(row[1] >= 0 and row[2] <= row[1] <= row[3] for row in t["forecast"]["rows"])
    assert [row[2] for row in t["models"]["rows"]].count("✓") == 1 and len(t["models"]["rows"]) == 3
    # the code shown is the code that ran: it names the real columns and is valid Python
    code = r["code"]
    assert "DATE, TARGET, HORIZON = 'month', 'revenue', 6" in code and "ExponentialSmoothing" in code and "__" not in code
    compile(code, "<shown>", "exec")
    # the model was asked for a method, and still never saw a single figure
    sent = json.dumps(fake_llm.REQUESTS[-1])
    assert "Predictive questions" in sent
    for value in [row[1] for row in t["forecast"]["rows"]] + [run["rows"][0][1]]:
        assert all(str(value) not in json.dumps(req) for req in fake_llm.REQUESTS), "figures leaked to the model"

    # change the horizon: data is fetched again and the analysis re-run
    again = client.post(f"/api/chat/runs/{run['id']}/analysis", headers=H, json={"horizon": 3}).json()
    assert again["analysis"]["result"]["params"] == {"horizon": 3} and _tables(again["analysis"])["forecast"]["row_count"] == 3
    # reopening the chat shows the stored analysis
    saved = client.get(f"/api/chat/conversations/{run['conversation_id']}").json()["runs"][0]
    assert saved["analysis"]["result"]["params"] == {"horizon": 3}
    # confirming it keeps the method with the training example, and it is offered to the model next time
    client.post(f"/api/chat/runs/{run['id']}/feedback", headers=H, json={"verdict": "correct"})
    pair = next(p for p in client.get(f"/api/training/{conn}?kind=sql_pair").json()["items"] if "Forecast revenue" in p["question"])
    assert json.loads(pair["content"])["type"] == "forecast"
    ask(client, conn, model, "Forecast revenue for the next 6 months please", predictive=True)
    assert 'Analysis: {\\"type\\": \\"forecast\\"' in json.dumps(fake_llm.REQUESTS[-1])


@pytest.mark.parametrize("question,kind,plots,tables", [
    ("Segment our customers", "clustering", ["scatter", "hbar"], {"segments", "profile", "k"}),
    ("Which orders are likely to be returned?", "classification", ["hbar", "bar"], {"predictions", "classes", "confusion", "models", "importance"}),
    ("Predict order value", "regression", ["hbar", "scatter"], {"predictions", "models", "importance"}),
    ("What drives order value?", "drivers", ["hbar"], {"predictions", "models", "importance"}),
    ("Any unusual days in revenue?", "anomaly", ["line"], {"anomalies", "scores"}),
    ("Show unusual orders", "anomaly", ["scatter", "hbar"], {"anomalies"}),
])
def test_each_method(admin, question, kind, plots, tables):
    client, conn, model = admin
    run = ask(client, conn, model, question, predictive=True)["run"]
    assert run["status"] == "success", run["error"]
    a = run["analysis"]
    assert "error" not in a, a.get("error")
    r = a["result"]
    assert r["type"] == kind and [p["kind"] for p in r["plots"]] == plots and set(_tables(a)) == tables
    assert r["narrative"] and r["metrics"] and r["method"] and r["rows_used"] == run["row_count"]
    compile(r["code"], "<shown>", "exec")
    assert len(run["rows"]) <= 1000                       # the data table stays capped; the analysis used every row
    json.dumps(run)


def test_segments_can_be_set_and_reset(admin):
    client, conn, model = admin
    run = ask(client, conn, model, "Segment our customers", predictive=True)["run"]
    four = client.post(f"/api/chat/runs/{run['id']}/analysis", headers=H, json={"k": 4}).json()["analysis"]
    assert four["result"]["params"] == {"k": 4} and len(_tables(four)["profile"]["rows"]) == 5       # 4 segments + all rows
    assert "k" not in _tables(four)
    auto = client.post(f"/api/chat/runs/{run['id']}/analysis", headers=H, json={"k": None}).json()["analysis"]
    assert "k" in _tables(auto)


def test_unsuitable_data_gives_a_clear_message_not_a_crash(admin):
    client, conn, model = admin
    run = ask(client, conn, model, "run the bad analysis", predictive=True)["run"]
    assert run["status"] == "success" and run["row_count"] == 4          # the data itself is still shown
    assert "no column called 'nope'" in run["analysis"]["error"]
    # user edits the SQL into something that cannot be forecast
    other = ask(client, conn, model, "Forecast revenue", review_first=True, predictive=True)["run"]
    done = client.post(f"/api/chat/runs/{other['id']}/execute", headers=H,
                       json={"sql": "SELECT DATE '2025-01-01' AS month, 5 AS revenue"}).json()
    assert "at least 6 time periods" in done["analysis"]["error"]


def test_opt_in_per_question_admin_switch_and_no_storage(admin, fake_llm):
    client, conn, model = admin
    # "Use predictive capability" not ticked (the default): an ordinary answer, and the model is not even told about it
    run = ask(client, conn, model, "Forecast revenue next quarter")["run"]
    assert run["status"] == "success" and run["analysis"] is None
    assert "Predictive questions" not in json.dumps(fake_llm.REQUESTS[-1])
    # ticked, but the question is not a predictive one: nothing extra happens
    plain = ask(client, conn, model, "What is revenue by category?", predictive=True)["run"]
    assert plain["analysis"] is None and plain["row_count"] == 5
    # an administrator can switch the capability off for everyone
    client.put("/api/admin/settings", headers=H, json={"predictive_enabled": False})
    run = ask(client, conn, model, "Forecast revenue next quarter", predictive=True)["run"]
    assert run["analysis"] is None and "Predictive questions" not in json.dumps(fake_llm.REQUESTS[-1])
    client.put("/api/admin/settings", headers=H, json={"predictive_enabled": True, "store_results": False})
    run = ask(client, conn, model, "Segment our customers", predictive=True)["run"]
    assert run["analysis"]["result"]["tables"] and run["rows"]            # shown now...
    saved = client.get(f"/api/chat/conversations/{run['conversation_id']}").json()["runs"][0]
    assert saved["rows"] is None and saved["analysis"] == {"spec": run["analysis"]["spec"]}      # ...but nothing kept
    client.put("/api/admin/settings", headers=H, json={"store_results": True})


def test_engine_rules():
    from app import predict
    from app.connectors import _package

    def data(names, rows):
        r = _package(names, rows, 50000, 1)
        return r["columns"], r["rows"]

    # a count can never be forecast below zero, and the range brackets the forecast
    cols, rows = data(["month", "orders"], [(f"2024-{m:02d}", v) for m, v in enumerate([50, 40, 30, 20, 12, 8, 5, 3, 2, 1, 1, 0], 1)])
    out = predict.run({"type": "forecast"}, cols, rows)
    fc = {t["key"]: t for t in out["tables"]}["forecast"]["rows"]
    assert all(r[1] >= 0 and r[2] >= 0 for r in fc) and out["params"]["horizon"] == 4

    # identifiers and free text never become model inputs; a leaked answer is called out
    cols, rows = data(["customer_id", "email", "plan", "spend", "churned", "cancel_reason"],
                      [(i, f"u{i}@x.com", "pro" if i % 3 else "free", 100 + i % 7 * 10, "yes" if i % 4 == 0 else "no",
                        "price" if i % 4 == 0 else None) for i in range(1, 201)])
    out = predict.run({"type": "classification", "target": "churned", "id": "customer_id"}, cols, rows)
    text = " ".join(out["narrative"])
    assert "email (identifier" in text and "NUMERIC, CATEGORICAL, DATES = ['spend'], ['plan', 'cancel_reason'], []" in out["code"]
    assert any("almost perfect" in w and "cancel_reason" in w for w in out["warnings"])
    assert "POSITIVE = 'churned', 'yes'" in out["code"]

    # rows without an outcome are scored and listed first
    rows2 = [list(r) for r in rows]
    for r in rows2[:10]:
        r[4] = None
    out = predict.run({"type": "classification", "target": "churned", "id": "customer_id", "features": ["plan", "spend"]}, cols, rows2)
    preds = {t["key"]: t for t in out["tables"]}["predictions"]["rows"]
    assert all(p[1] is None and p[2] in ("yes", "no") for p in preds[:10]) and preds[10][1] is not None

    # clear, actionable refusals
    for spec, c, r, msg in [
        ({"type": "classification", "target": "plan"}, *data(["plan", "x"], [("a", float(i)) for i in range(40)]), "same value in every row"),
        ({"type": "clustering"}, *data(["name", "v"], [("a", 1), ("b", 2)]), "at least 10"),
        ({"type": "regression", "target": "v"}, *data(["k", "v"], [("a", 1.5), ("b", 2.5)] * 5), "at least 30"),
    ]:
        with pytest.raises(predict.AnalysisError, match=msg):
            predict.run(spec, c, r)

    # what the model sends is reduced to known keys and safe values; column names are only ever inserted via repr()
    assert predict.clean_spec({"type": "forecast", "horizon": 9999, "evil": "x", "date": "d"}) == {"type": "forecast", "date": "d", "horizon": 120}
    assert predict.clean_spec({"type": "exec"}) is None
    cols, rows = data(["weird'); import os #", "v"], [(f"2024-{m:02d}", m * 2.0) for m in range(1, 13)])
    out = predict.run({"type": "forecast", "date": "weird'); import os #", "target": "v"}, cols, rows)
    assert 'DATE, TARGET, HORIZON = "weird\'); import os #", \'v\', 4' in out["code"]


def test_predictive_answer_in_a_report(admin):
    """A report re-fits the model on fresh data for whoever opens it, and the PDF carries the output."""
    import io
    from pypdf import PdfReader
    client, conn, model = admin
    run = ask(client, conn, model, "Forecast revenue for the next 6 months", predictive=True)["run"]
    plain = ask(client, conn, model, "What is revenue by category?")["run"]
    rep = client.post("/api/reports", headers=H, json={"title": "Outlook", "components": [
        {"type": "result", "run_id": run["id"], "title": "Revenue outlook", "hide": ["stats", "nonsense"],
         "analysis": {"type": "clustering"}},                                   # the browser cannot change the method
        {"type": "result", "run_id": plain["id"]}]}).json()
    first, second = rep["components"]
    assert first["analysis"] == run["analysis"]["spec"] and first["hide"] == ["stats"] and second["analysis"] is None
    out = client.get(f"/api/reports/{rep['id']}/render").json()["components"]
    a = out[0]["analysis"]
    assert a["result"]["type"] == "forecast" and a["result"]["params"] == {"horizon": 6} and out[1]["analysis"] is None
    assert out[0]["row_count"] == 21 and len(out[0]["rows"]) == 21
    pdf = PdfReader(io.BytesIO(client.get(f"/api/reports/{rep['id']}/pdf").content))
    text = " ".join(p.extract_text() for p in pdf.pages)
    assert "Revenue outlook" in text and "Forecast —" in text and "Forecast values" in text and "ExponentialSmoothing" in text
    assert "Methods compared" not in text                                       # hidden part stays out of the PDF
    assert sum(len(p.images) for p in pdf.pages) >= 2                           # forecast plot + the category chart
    # switched off for this component: plain data only
    comps = [{**c, "show_analysis": False} if c["id"] == first["id"] else c for c in rep["components"]]
    client.put(f"/api/reports/{rep['id']}", headers=H, json={"title": "Outlook", "components": comps})
    assert client.get(f"/api/reports/{rep['id']}/render").json()["components"][0]["analysis"] is None
    client.delete(f"/api/reports/{rep['id']}", headers=H)
