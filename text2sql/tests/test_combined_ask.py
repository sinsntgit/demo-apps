"""Asking a combined data model (phase 3): a plan of steps, one per data model, combined on the server.

The rules: the right totals; each step guarded, row-filtered and masked for the person asking, on every path (ask,
edited plan, shared chat, report); row limits fail with a message, never an approximate answer; the combine step can
only read the step results; no data ever reaches the AI model; results-only people never see the plan."""
import csv
import json
from pathlib import Path

import pytest

from tests.conftest import H
from tests.test_reports import _login

SAMPLE = Path(__file__).parent.parent / "sample_data"
Q = "Which of our top SAP customers have the most open CRM tickets?"


def _by_name(client, name):
    return next(c for c in client.get("/api/connections").json() if c["name"] == name)


def _ask(client, conn, model, question, status=200, **kw):
    r = client.post("/api/chat/ask", headers=H, json={"connection_id": conn, "model_id": model, "question": question, **kw})
    assert r.status_code == status, r.text
    return r.json()


def _col(run, name):
    i = [c["name"] for c in run["columns"]].index(name)
    return [r[i] for r in run["rows"]]


def _expected():
    """Top 10 SAP customers by 2025 net sales with their open CRM tickets - worked out here from the CSV files."""
    kna1 = {r["KUNNR"]: r["NAME1"] for r in csv.DictReader(open(SAMPLE / "sap" / "KNA1.csv", encoding="utf-8"))}
    sales = {}
    for r in csv.DictReader(open(SAMPLE / "sap" / "VBRK.csv", encoding="utf-8")):
        if "2025-01-01" <= r["FKDAT"][:10] <= "2025-12-31" and r["KUNRG"] in kna1:
            v = float(r["NETWR"]) * (1 if r["VBTYP"] == "M" else -1)
            sales[r["KUNRG"]] = sales.get(r["KUNRG"], 0) + v
    acc = {r["account_id"]: r["sap_no"] for r in csv.DictReader(open(SAMPLE / "crm" / "accounts.csv", encoding="utf-8")) if r["sap_no"]}
    open_t = {}
    for r in csv.DictReader(open(SAMPLE / "crm" / "tickets.csv", encoding="utf-8")):
        if r["status"] != "Closed" and r["account_id"] in acc:
            open_t[int(acc[r["account_id"]])] = open_t.get(int(acc[r["account_id"]]), 0) + 1
    top = sorted(sales.items(), key=lambda kv: -kv[1])[:10]
    return [(kna1[k], round(v, 2), open_t.get(int(k), 0)) for k, v in top]


@pytest.fixture(scope="module")
def setup(admin):
    client, _, model = admin
    combo = _by_name(client, "Sample: SAP + CRM")
    crm = _by_name(client, "Sample: CRM")
    sap = _by_name(client, "Sample: SAP Sales & Finance")
    return {"client": client, "model": model, "combo": combo["id"], "crm": crm, "sap": sap}


def test_a_question_across_sap_and_crm_gives_the_right_totals(setup, fake_llm):
    c, model, combo = setup["client"], setup["model"], setup["combo"]
    before = len(fake_llm.REQUESTS)
    run = _ask(c, combo, model, Q)["run"]
    assert run["status"] == "success", run["error"]
    got = list(zip(_col(run, "customer_name"), _col(run, "net_sales_2025"), _col(run, "open_tickets")))
    exp = _expected()
    assert [g[0] for g in got] == [e[0] for e in exp]
    assert all(abs(g[1] - e[1]) < 0.05 and g[2] == e[2] for g, e in zip(got, exp)), (got, exp)
    assert any(e[2] for e in exp)                                   # the CRM side really contributed
    plan = run["plan"]
    assert [s["source"] for s in plan["steps"]] == ["sap", "crm"] and all(s["rows"] > 0 for s in plan["steps"])
    assert plan["steps"][0]["data_model"] == "Sample: SAP Sales & Finance" and "LEFT JOIN s2" in plan["combine"]
    assert "-- combine" in run["final_sql"] and run["summary"]["headline"]
    # what the model was sent: both data models' knowledge and the match with its key rule - and no data
    sent = json.dumps(fake_llm.REQUESTS[before:])
    assert "Data model `sap`" in sent and "Data model `crm`" in sent and "Strip leading zeros" in sent
    assert "sap.kna1.KUNNR = crm.accounts.sap_no" in sent
    for name, value, _ in exp[:5]:
        assert name not in sent and f"{value:.2f}" not in sent and str(value) not in sent


def test_one_data_model_is_enough_and_clarifications_work(setup):
    c, model, combo = setup["client"], setup["model"], setup["combo"]
    run = _ask(c, combo, model, "How many tickets by priority?")["run"]
    assert run["status"] == "success" and len(run["plan"]["steps"]) == 1 and run["row_count"] == 4
    run = _ask(c, combo, model, "What was the weather?")["run"]
    assert run["status"] == "clarification" and "weather" in run["explanation"]


def test_row_limits_fail_with_a_message_and_are_not_repaired(setup):
    c, model, combo = setup["client"], setup["model"], setup["combo"]
    c.put("/api/admin/settings", headers=H, json={"combined_step_max_rows": 1000})
    try:
        run = _ask(c, combo, model, "List every billing item with its tickets")["run"]
        assert run["status"] == "error" and "more than 1,000 rows" in run["error"] and "Step s1" in run["error"]
        assert run["attempts"] == 1 and not run["rows"]
        c.put("/api/admin/settings", headers=H, json={"combined_step_max_rows": 200000, "combined_total_max_rows": 1000})
        run = _ask(c, combo, model, "Every posting joined to tickets")["run"]
        assert run["status"] == "error" and "Together the steps would read more than 1,000 rows" in run["error"]
    finally:
        c.put("/api/admin/settings", headers=H, json={"combined_step_max_rows": 200000, "combined_total_max_rows": 500000})


def test_a_failing_step_is_repaired_and_warnings_are_given(setup, fake_llm):
    c, model, combo = setup["client"], setup["model"], setup["combo"]
    before = len(fake_llm.REQUESTS)
    run = _ask(c, combo, model, "plan broken: top customers and open tickets")["run"]
    assert run["status"] == "success" and run["attempts"] == 2 and run["row_count"] == 10
    repair = json.dumps(fake_llm.REQUESTS[before + 1:])
    assert "previous plan failed" in repair and "no_such_column" in repair
    run = _ask(c, combo, model, "Customers and tickets without the key rule")["run"]
    assert run["status"] == "success" and run["row_count"] == 0
    assert any("No rows matched" in w for w in run["warnings"])
    run = _ask(c, combo, model, "Every posting joined to tickets")["run"]
    assert run["status"] == "success" and any("counted more than once" in w for w in run["warnings"])


def test_the_combine_step_reads_only_the_step_results(setup):
    c, model, combo = setup["client"], setup["model"], setup["combo"]
    run = _ask(c, combo, model, "Read outside the steps please")["run"]
    assert run["status"] == "blocked" and "step tables" in run["error"] and not run["rows"]
    from app import planner, sqlguard
    for bad in ("SELECT * FROM read_csv_auto('/etc/passwd')", "SELECT * FROM s1, main.kna1", "COPY s1 TO 'x.csv'",
                "SELECT * FROM s3", "SELECT 1; SELECT 2"):
        with pytest.raises(sqlguard.SQLBlocked):
            planner.check_combine(bad, ["s1", "s2"])
    planner.check_combine("WITH x AS (SELECT * FROM s1) SELECT * FROM x JOIN s2 USING (k)", ["s1", "s2"])


def test_row_filters_and_masking_apply_to_each_step(setup):
    c, model, combo, crm, sap = setup["client"], setup["model"], setup["combo"], setup["crm"], setup["sap"]
    u, uid = _login(c, "combo-north@test.local", name="Cora Combined")
    f = c.post("/api/admin/filters", headers=H, json={"connection_id": crm["id"], "table_name": "accounts", "condition": "country = 'XX'",
                                                       "scope": "user", "user_id": uid}).json()["id"]
    try:
        mine = _ask(u, combo, model, Q)["run"]
        assert mine["status"] == "success", mine["error"]
        assert _col(mine, "open_tickets") == [0] * 10                                       # the CRM step was filtered for them
        assert mine["context"]["filters"] == [f] and mine["plan"]["steps"][1]["filters"] == 1
        assert _col(mine, "customer_name") == [e[0] for e in _expected()]                  # the SAP side was not
        # an edited plan cannot get round it either
        go = u.post(f"/api/chat/runs/{mine['id']}/execute", headers=H, json={"plan": {
            "steps": [{"id": "s1", "source": "crm", "sql": "SELECT a.country, COUNT(*) AS n FROM tickets t JOIN (SELECT * FROM accounts) a ON a.account_id = t.account_id GROUP BY 1"}],
            "combine": "SELECT * FROM s1"}}).json()
        assert go["status"] == "success" and go["rows"] == [] and go["plan"]["edited"]
    finally:
        c.delete(f"/api/admin/filters/{f}", headers=H)
    c.put(f"/api/connections/{sap['id']}", headers=H, json={**sap, "masked_columns": ["NETWR"]})
    try:
        run = _ask(c, combo, model, Q)["run"]
        assert run["status"] == "success" and set(_col(run, "net_sales_2025")) == {"••••••"}
        assert any(_col(run, "open_tickets"))                       # the unmasked CRM side still answers
    finally:
        c.put(f"/api/connections/{sap['id']}", headers=H, json={**sap, "masked_columns": sap.get("masked_columns") or []})


def test_review_and_edit_a_plan(setup):
    c, model, combo = setup["client"], setup["model"], setup["combo"]
    run = _ask(c, combo, model, Q, review_first=True)["run"]
    assert run["status"] == "pending_review" and len(run["plan"]["steps"]) == 2 and not run["rows"]
    plan = {"steps": [{k: s[k] for k in ("id", "source", "sql")} for s in run["plan"]["steps"]],
            "combine": run["plan"]["combine"].replace("LIMIT 10", "LIMIT 3")}
    go = lambda body, code=200: (lambda r: (r.status_code == code or print(r.text)) and r.json())(        # noqa: E731
        c.post(f"/api/chat/runs/{run['id']}/execute", headers=H, json=body))
    out = go({"plan": plan})
    assert out["status"] == "success" and out["row_count"] == 3 and out["edited"] and out["plan"]["edited"]
    assert go({"plan": {**plan, "steps": [{**plan["steps"][0], "source": "retail"}]}}, 400)
    assert go({"sql": "SELECT 1"}, 400)
    assert go({"plan": {**plan, "steps": [{**plan["steps"][0], "sql": "DELETE FROM kna1"}]}})["status"] == "blocked"
    assert go({"plan": plan})["status"] == "success"
    fb = c.post(f"/api/chat/runs/{run['id']}/feedback", headers=H, json={"verdict": "correct"}).json()
    assert fb["training"] == "recorded"


def test_results_only_people_never_see_the_plan(setup):
    c, model, combo = setup["client"], setup["model"], setup["combo"]
    u, uid = _login(c, "combo-results@test.local")
    me = c.get("/api/admin/users").json()
    row = next(x for x in me if x["id"] == uid)
    c.put(f"/api/admin/users/{uid}", headers=H, json={**row, "show_sql": False})
    out = _ask(u, combo, model, Q, review_first=True)
    run = out["run"]
    assert run["status"] == "success" and run["plan"] is None and run["final_sql"] == "" and run["generated_sql"] == ""
    assert "kna1" not in json.dumps(out)
    r = u.post(f"/api/chat/runs/{run['id']}/execute", headers=H, json={"plan": {"steps": [{"id": "s1", "source": "crm", "sql": "SELECT 1"}]}})
    assert r.status_code == 403


def test_shared_chats_and_reports_rerun_the_plan_for_each_viewer(setup):
    c, model, combo, crm = setup["client"], setup["model"], setup["combo"], setup["crm"]
    v, vid = _login(c, "combo-viewer@test.local", name="Vic Viewer")
    out = _ask(c, combo, model, Q)
    cid, run = out["conversation"]["id"], out["run"]
    assert any(_col(run, "open_tickets"))
    c.put(f"/api/chat/conversations/{cid}/shares", headers=H, json={"shares": [{"scope": "user", "user_id": vid}]})
    rep = c.post("/api/reports", headers=H, json={"title": "SAP + CRM", "components": [
        {"type": "result", "run_id": run["id"], "plan": {"steps": [{"id": "s1", "source": "crm", "sql": "SELECT * FROM contacts"}], "combine": "SELECT * FROM s1"}}]}).json()
    stored = c.get(f"/api/reports/{rep['id']}").json()
    assert "plan" not in json.dumps(stored["components"][0])           # the editor never receives (or sends) a plan
    c.put(f"/api/reports/{rep['id']}/shares", headers=H, json={"shares": [{"scope": "user", "user_id": vid, "can_edit": False}]})
    f = c.post("/api/admin/filters", headers=H, json={"connection_id": crm["id"], "table_name": "accounts", "condition": "country = 'XX'",
                                                       "scope": "user", "user_id": vid}).json()["id"]
    try:
        conv = v.get(f"/api/chat/conversations/{cid}").json()
        seen = conv["runs"][0]
        assert seen["shared_view"] and seen["status"] == "success" and _col(seen, "open_tickets") == [0] * 10
        assert seen["plan"]["steps"][1]["filters"] == 1
        page = v.get(f"/api/reports/{rep['id']}/render").json()
        comp = next(x for x in page["components"] if x["type"] == "result")
        assert comp["status"] == "ok" and _col(comp, "open_tickets") == [0] * 10    # rendered with the viewer's filters
        mine = c.get(f"/api/reports/{rep['id']}/render").json()
        comp = next(x for x in mine["components"] if x["type"] == "result")
        assert comp["status"] == "ok" and any(_col(comp, "open_tickets")) and len(_col(comp, "customer_name")) == 10
        pdf = c.get(f"/api/reports/{rep['id']}/pdf")
        assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF"
        import pypdfium2
        text = "".join(pg.get_textpage().get_text_range() for pg in pypdfium2.PdfDocument(pdf.content))
        assert _expected()[0][0] in text and "open_tickets" in text           # the combined numbers made it into the PDF
    finally:
        c.delete(f"/api/admin/filters/{f}", headers=H)
        c.delete(f"/api/reports/{rep['id']}", headers=H)


def test_a_combined_model_without_confirmed_matches_cannot_be_asked(setup):
    c, model = setup["client"], setup["model"]
    retail = _by_name(c, "Sample: Retail sales")
    made = c.post("/api/combined", headers=H, json={"name": "Retail + SAP (test)", "members": [
        {"id": retail["id"], "alias": "shop"}, {"id": setup["sap"]["id"], "alias": "sap"}]}).json()
    try:
        assert not made["ready"] and not made["counts"]["confirmed"]
        r = c.post("/api/chat/ask", headers=H, json={"connection_id": made["id"], "model_id": model, "question": Q})
        assert r.status_code == 400 and "not ready" in r.json()["detail"]
    finally:
        c.delete(f"/api/combined/{made['id']}", headers=H)
