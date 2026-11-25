"""Training for combined data models (phase 4): verified question -> plan examples, business notes, the review queue for
answers reported incorrect, and the dashboard's view of questions across data models."""
import json
from pathlib import Path

import pytest

from tests.conftest import H
from tests.test_combined_ask import Q, _ask, _by_name
from tests.test_reports import _login


@pytest.fixture(scope="module")
def ctx(admin):
    client, _, model = admin
    return {"c": client, "model": model, "combo": _by_name(client, "Sample: SAP + CRM")["id"],
            "crm": _by_name(client, "Sample: CRM")["id"]}


def _items(c, combo, kind="sql_pair", status=""):
    return [i for i in c.get(f"/api/training/{combo}").json()["items"] if i["kind"] == kind and (not status or i["status"] == status)]


def test_the_sample_comes_with_verified_plans_that_run(ctx):
    c, combo = ctx["c"], ctx["combo"]
    bundled = json.load(open(Path(__file__).parent.parent / "sample_data" / "combined_training.json", encoding="utf-8"))
    wanted = {e["question"] for e in bundled["examples"]}
    examples = [i for i in _items(c, combo) if i["question"] in wanted]            # other tests add confirmed answers too
    notes = [i for i in _items(c, combo, "documentation") if i["title"] in {d["title"] for d in bundled["documentation"]}]
    assert len(examples) == 4 and len(notes) == 2 and all(e["plan"] and e["status"] == "approved" for e in examples)
    for e in examples:
        r = c.post(f"/api/training/{combo}/test-sql", headers=H, json={"plan": e["plan"]})
        assert r.status_code == 200, (e["question"], r.text)
        assert r.json()["row_count"] > 0, e["question"]
        assert "-- combine" in e["sql"]
    # Germany only, in EUR, as the currency note says
    german = next(e for e in examples if "German" in e["question"])
    top = c.post(f"/api/training/{combo}/test-sql", headers=H, json={"plan": german["plan"]}).json()
    assert [col["name"] for col in top["columns"]] == ["customer_name", "net_sales_eur", "open_tickets"]


def test_examples_and_notes_reach_the_plan_prompt(ctx, fake_llm):
    c, combo, model = ctx["c"], ctx["combo"], ctx["model"]
    before = len(fake_llm.REQUESTS)
    _ask(c, combo, model, "Which customers with overdue SAP receivables have open urgent tickets? (open tickets)")
    sent = json.dumps(fake_llm.REQUESTS[before:])
    assert "Verified example plans" in sent and "overdue SAP receivables have open urgent or high-priority" in sent
    assert "Currencies when combining with SAP amounts" in sent


def test_confirming_an_answer_saves_its_plan(ctx):
    c, combo, model = ctx["c"], ctx["combo"], ctx["model"]
    q = "Which of our top SAP customers have the most open CRM tickets? (open tickets, confirmed)"
    run = _ask(c, combo, model, q)["run"]
    fb = c.post(f"/api/chat/runs/{run['id']}/feedback", headers=H, json={"verdict": "correct"}).json()
    assert fb["training"] == "approved"                                    # an administrator's verdict counts at once
    item = next(i for i in _items(c, combo) if i["question"] == q)
    assert [s["source"] for s in item["plan"]["steps"]] == ["sap", "crm"] and item["source"] == "confirmed"
    assert item["plan"]["combine"] == run["plan"]["combine"] and "rows" not in item["plan"]["steps"][0]
    # an analyst's confirmation waits for a steward
    u, _ = _login(c, "combo-trainee@test.local")
    q2 = "Which of our top SAP customers have the most open CRM tickets? (open tickets, analyst)"
    run = _ask(u, combo, model, q2)["run"]
    assert u.post(f"/api/chat/runs/{run['id']}/feedback", headers=H, json={"verdict": "correct"}).json()["training"] == "pending"
    pending = next(i for i in _items(c, combo, status="pending") if i["question"] == q2)
    assert c.post(f"/api/training/item/{pending['id']}/approve", headers=H).json()["status"] == "approved"


def test_adding_and_editing_examples_checks_the_plan(ctx):
    c, combo = ctx["c"], ctx["combo"]
    plan = {"steps": [{"id": "s1", "source": "crm", "sql": "SELECT priority, COUNT(*) AS tickets FROM tickets GROUP BY 1"}],
            "combine": "SELECT * FROM s1 ORDER BY tickets DESC"}
    add = lambda body: c.post(f"/api/training/{combo}", headers=H, json={"kind": "sql_pair", "question": "Tickets by priority (training test)", **body})  # noqa: E731
    assert add({"sql": "SELECT 1"}).status_code == 400                     # a combined model needs a plan
    assert "Plan rejected" in add({"plan": {**plan, "steps": [{**plan["steps"][0], "sql": "DELETE FROM tickets"}]}}).json()["detail"]
    assert "Plan rejected" in add({"plan": {**plan, "combine": "SELECT * FROM kna1"}}).json()["detail"]
    assert "Plan rejected" in add({"plan": {**plan, "steps": [{**plan["steps"][0], "source": "shop"}]}}).json()["detail"]
    item = add({"plan": plan}).json()
    assert item["plan"]["steps"][0]["source"] == "crm" and "-- s1 · crm (Sample: CRM)" in item["sql"]
    edited = c.put(f"/api/training/item/{item['id']}", headers=H, json={"kind": "sql_pair", "question": item["question"],
                                                                        "plan": {**plan, "combine": "SELECT * FROM s1 ORDER BY 1"}}).json()
    assert edited["plan"]["combine"] == "SELECT * FROM s1 ORDER BY 1"
    assert c.post(f"/api/training/{combo}", headers=H, json={"kind": "ddl", "content": "CREATE VIEW x AS SELECT 1"}).status_code == 400
    note = c.post(f"/api/training/{combo}", headers=H, json={"kind": "documentation", "title": "Test note", "content": "Across both."})
    assert note.status_code == 200
    r = c.post(f"/api/training/{combo}/import-pairs", headers=H, files={"upload": ("x.csv", b"question,sql\nq,SELECT 1\n")})
    assert r.status_code == 400
    # an ordinary data model refuses plans
    r = c.post(f"/api/training/{ctx['crm']}", headers=H, json={"kind": "sql_pair", "question": "q", "sql": "SELECT 1", "plan": plan})
    assert r.status_code == 400
    for i in (item["id"], note.json()["id"]):
        c.delete(f"/api/training/item/{i}", headers=H)


def test_a_reported_answer_is_fixed_with_a_corrected_plan(ctx):
    c, combo, model = ctx["c"], ctx["combo"], ctx["model"]
    u, _ = _login(c, "combo-reporter@test.local", name="Rita Reporter")
    run = _ask(u, combo, model, "Customers and tickets without the key rule")["run"]
    assert run["row_count"] == 0
    r = u.post(f"/api/chat/runs/{run['id']}/feedback", headers=H, json={"verdict": "incorrect", "issue_type": "missing",
                                                                         "note": "Every customer has 0 rows - the numbers do not match."})
    assert r.json()["training"] == "review"
    issue = next(i for i in c.get(f"/api/training/{combo}/issues").json() if i["run_id"] == run["id"])
    assert issue["plan"] and issue["user"] == "Rita Reporter" and len(issue["plan"]["steps"]) == 2
    fixed = {**issue["plan"], "combine": issue["plan"]["combine"].replace("s1.customer = CAST(s2.sap_no AS VARCHAR)",
                                                                           "ltrim(s1.customer, '0') = CAST(s2.sap_no AS VARCHAR)")}
    bad = c.post(f"/api/training/issues/{run['id']}/resolve", headers=H, json={"action": "example", "plan": {**fixed, "combine": "SELECT nope FROM s1"}})
    assert bad.status_code == 400 and "did not run" in bad.json()["detail"]
    test = c.post(f"/api/training/{combo}/test-sql", headers=H, json={"plan": fixed}).json()
    assert test["row_count"] > 0
    ok = c.post(f"/api/training/issues/{run['id']}/resolve", headers=H, json={"action": "example", "plan": fixed, "comment": "Fixed the match."})
    assert ok.json()["status"] == "fixed"
    item = next(i for i in _items(c, combo) if i["question"] == run["question"])
    assert item["source"] == "correction" and "ltrim(s1.customer, '0')" in item["plan"]["combine"]
    mine = u.get(f"/api/chat/conversations/{run['conversation_id']}").json()["runs"][0]
    assert mine["issue_status"] == "fixed" and mine["issue_resolution"] == "Fixed the match."
    c.delete(f"/api/training/item/{item['id']}", headers=H)


def test_the_dashboard_compares_combined_questions_and_explains_failures(ctx):
    c, combo, model = ctx["c"], ctx["combo"], ctx["model"]
    c.put("/api/admin/settings", headers=H, json={"combined_step_max_rows": 1000})
    try:
        _ask(c, combo, model, "List every billing item with its tickets")
    finally:
        c.put("/api/admin/settings", headers=H, json={"combined_step_max_rows": 200000})
    s = c.get("/api/analytics/summary").json()["combined"]
    assert s["questions"] >= 5 and s["across"]["questions"] == s["questions"] and "first_time_rate" in s["single"]
    assert 0 <= s["across"]["first_time_rate"] <= 1
    reasons = {r["reason"]: r["count"] for r in s["reasons"]}
    assert reasons.get("Row limit reached - ask for totals, or raise the limit", 0) >= 1
    assert reasons.get("Nothing matched between the data models - check the key rule", 0) >= 1
