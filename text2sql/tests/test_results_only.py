"""'Results only' accounts (no SQL, no code - enforced by the server) and 'this answer is incorrect' -> review -> training."""
import io
import json
from types import SimpleNamespace

import pytest

from tests.conftest import H
from tests.test_platform import ask
from tests.test_reports import _login


@pytest.fixture(scope="module")
def people(admin):
    client, conn, model = admin
    biz, biz_id = _login(client, "business.user@test.local", name="Bea Business")
    client.put(f"/api/admin/users/{biz_id}", headers=H, json={"email": "business.user@test.local", "name": "Bea Business",
                                                               "role": "analyst", "is_active": True, "show_sql": False})
    stew, stew_id = _login(client, "steward.rev@test.local", role="steward", name="Sid Steward")
    client.put(f"/api/admin/users/{stew_id}", headers=H, json={"email": "steward.rev@test.local", "name": "Sid Steward",
                                                                "role": "steward", "is_active": True, "show_sql": False})
    return {"admin": client, "conn": conn, "model": model, "biz": biz, "biz_id": biz_id, "stew": stew}


def _no_sql(payload):
    text = json.dumps(payload)
    return "SELECT" not in text.upper() and '"code":' not in text and "import pandas" not in text


def test_results_only_account_never_receives_sql_or_code(people):
    a, conn, model, biz, stew = (people[k] for k in ("admin", "conn", "model", "biz", "stew"))
    assert biz.get("/api/auth/me").json()["sees_sql"] is False
    assert stew.get("/api/auth/me").json()["sees_sql"] is True              # stewards always see SQL - they fix it
    user = next(u for u in a.get("/api/admin/users").json() if u["id"] == people["biz_id"])
    assert user["show_sql"] is False

    out = ask(biz, conn, model, "revenue and orders by region", review_first=True)     # review needs SQL: ignored
    run = out["run"]
    assert run["status"] == "success" and run["rows"] and run["technical"] is False
    assert run["final_sql"] == run["generated_sql"] == "" and "tables" not in run["context"] and _no_sql(out)

    assert biz.post(f"/api/chat/runs/{run['id']}/execute", headers=H, json={"sql": "SELECT 1"}).status_code == 403
    again = biz.post(f"/api/chat/runs/{run['id']}/execute", headers=H, json={}).json()           # "Run again" is fine
    assert again["status"] == "success" and _no_sql(again)

    conv = biz.get(f"/api/chat/conversations/{out['conversation']['id']}").json()
    assert _no_sql(conv)
    assert biz.get("/api/chat/history?q=SELECT").json() == []                                   # cannot search SQL either
    assert biz.get("/api/chat/history?q=region").json()

    pred = ask(biz, conn, model, "forecast revenue for the next 6 months", predictive=True)["run"]
    assert pred["analysis"]["result"]["metrics"] and "code" not in pred["analysis"]["result"] and _no_sql(pred)

    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(biz.get(f"/api/chat/runs/{run['id']}/export.xlsx").content))
    assert "SELECT" not in json.dumps([[c.value for c in r] for r in wb["Query"].iter_rows()], default=str).upper()

    # a report shared with them: no SQL and no code, on screen or in the PDF
    owner_run = ask(a, conn, model, "forecast revenue for the next 6 months", predictive=True)["run"]
    rep = a.post("/api/reports", headers=H, json={"title": "For Bea", "components": [{"type": "result", "run_id": owner_run["id"]}]}).json()
    a.put(f"/api/reports/{rep['id']}/shares", headers=H, json={"shares": [{"scope": "user", "user_id": people["biz_id"]}]})
    seen = biz.get(f"/api/reports/{rep['id']}/render").json()
    comp = next(c for c in seen["components"] if c["type"] == "result")
    assert comp["status"] == "ok" and "sql" not in comp and "code" in comp["hide"] and _no_sql(seen)
    assert b"Code that produced" not in biz.get(f"/api/reports/{rep['id']}/pdf").content          # (compressed text: checked below)
    from pypdf import PdfReader
    text = "".join(p.extract_text() for p in PdfReader(io.BytesIO(biz.get(f"/api/reports/{rep['id']}/pdf").content)).pages)
    assert "Code that produced" not in text and "import " not in text
    owner_text = "".join(p.extract_text() for p in PdfReader(io.BytesIO(a.get(f"/api/reports/{rep['id']}/pdf").content)).pages)
    assert "Code that produced" in owner_text                                                     # the owner still gets it
    a.delete(f"/api/reports/{rep['id']}", headers=H)

    # accounts from before this setting existed (NULL) keep seeing everything
    from app.deps import sees_sql
    assert sees_sql(SimpleNamespace(role="analyst", show_sql=None)) and not sees_sql(SimpleNamespace(role="analyst", show_sql=False))


def test_incorrect_answer_goes_to_review_then_training(people):
    a, conn, model, biz, stew = (people[k] for k in ("admin", "conn", "model", "biz", "stew"))
    fb = lambda run_id, **kw: biz.post(f"/api/chat/runs/{run_id}/feedback", headers=H, json={"verdict": "incorrect", **kw})   # noqa: E731
    r1 = ask(biz, conn, model, "revenue by category")["run"]
    assert fb(r1["id"], note="wrong").status_code == 400                                          # what is wrong: required
    assert fb(r1["id"], issue_type="wrong_numbers", note="no").status_code == 400                 # and why: required
    out = fb(r1["id"], issue_type="wrong_numbers", note="Accessories look far too high - returns counted?").json()
    assert out["training"] == "review" and out["run"]["issue_status"] == "open" and _no_sql(out)

    issues = stew.get(f"/api/training/{conn}/issues").json()
    mine = next(i for i in issues if i["run_id"] == r1["id"])
    assert mine["issue_label"] == "The numbers are wrong" and mine["user"] == "Bea Business" and "SELECT" in mine["sql"]
    assert stew.get(f"/api/training/{conn}").json()["issues_open"] >= 1
    assert biz.get(f"/api/training/{conn}/issues").status_code == 403                             # analysts cannot see the queue

    # fix it: unsafe or broken SQL is refused; good SQL becomes an approved verified example
    resolve = lambda run_id, **kw: stew.post(f"/api/training/issues/{run_id}/resolve", headers=H, json=kw)    # noqa: E731
    assert resolve(r1["id"], action="example", sql="DELETE FROM orders").status_code == 400
    assert resolve(r1["id"], action="example", sql="SELECT nope FROM orders").status_code == 400
    fixed_sql = ("SELECT p.category, ROUND(SUM(oi.quantity * oi.unit_price * (1 - oi.discount)), 2) AS revenue FROM order_items oi "
                 "JOIN orders o ON o.order_id = oi.order_id JOIN products p ON p.product_id = oi.product_id "
                 "WHERE o.status = 'completed' GROUP BY 1 ORDER BY revenue DESC")
    t = stew.post(f"/api/training/{conn}/test-sql", headers=H, json={"sql": fixed_sql}).json()
    assert t["row_count"] == 5
    assert resolve(r1["id"], action="example", question="Revenue by product category, completed orders only", sql=fixed_sql,
                   comment="Fixed: only completed orders count.").json()["status"] == "fixed"
    pairs = stew.get(f"/api/training/{conn}?kind=sql_pair").json()["items"]
    p = next(x for x in pairs if x["question"] == "Revenue by product category, completed orders only")
    assert p["status"] == "approved" and p["source"] == "correction"
    seen = biz.get(f"/api/chat/conversations/{r1['conversation_id']}").json()["runs"][-1]
    assert seen["issue_status"] == "fixed" and seen["issue_resolution"] == "Fixed: only completed orders count."
    assert r1["id"] not in [i["run_id"] for i in stew.get(f"/api/training/{conn}/issues").json()]

    # a business rule instead
    r2 = ask(biz, conn, model, "top customers")["run"]
    fb(r2["id"], issue_type="extra", note="Includes cancelled orders, they should not count")
    assert resolve(r2["id"], action="note", content="").status_code == 400
    resolve(r2["id"], action="note", title="Cancelled orders", content="Cancelled orders never count towards revenue or rankings.")
    docs = stew.get(f"/api/training/{conn}?kind=documentation").json()["items"]
    assert any(d["title"] == "Cancelled orders" and d["status"] == "approved" for d in docs)

    # dismissed, and a report taken back by the user
    r3 = ask(biz, conn, model, "how many orders by status")["run"]
    fb(r3["id"], issue_type="other", note="Looks odd to me")
    resolve(r3["id"], action="dismiss", comment="Correct: pending orders are included on purpose.")
    assert biz.get(f"/api/chat/conversations/{r3['conversation_id']}").json()["runs"][-1]["issue_status"] == "dismissed"
    r4 = ask(biz, conn, model, "revenue by month")["run"]
    fb(r4["id"], issue_type="filter", note="Should be this year only")
    biz.post(f"/api/chat/runs/{r4['id']}/feedback", headers=H, json={"verdict": "withdraw"})
    assert r4["id"] not in [i["run_id"] for i in stew.get(f"/api/training/{conn}/issues").json()]
    assert any(e["action"] == "training.issue_resolved" for e in a.get("/api/admin/audit?action=training.issue_resolved").json()["items"])
