"""Passing keys between steps (phase 5): a step filtered by the values an earlier step returned, e.g.
`LTRIM(k.KUNRG, '0') IN ({{s1.sap_no|to_text}})`.

The rules: the right answer; keys are inserted as literals of the receiving dialect and can never change the SQL around
them; the earlier step runs with the person's filters and masking first (a filtered person passes fewer keys, a masked
column cannot be passed); a limit on the number of keys fails with a message; the AI model never sees the keys."""
import csv
import json
from pathlib import Path

import pytest

from app import planner, sqlguard
from tests.conftest import H
from tests.test_combined_ask import _ask, _by_name
from tests.test_reports import _login

SAMPLE = Path(__file__).parent.parent / "sample_data"
Q = "SAP invoices in 2025 for customers with open urgent CRM tickets"
HOSTILE = ["x' OR '1'='1", "O'Brien", "a ; DROP TABLE t; --", "/* c */ 1", "') OR 1=1 --", "ü 😀", "line\nbreak", 100001, 2.5]


@pytest.fixture(scope="module")
def ctx(admin):
    client, _, model = admin
    return {"c": client, "model": model, "combo": _by_name(client, "Sample: SAP + CRM")["id"], "crm": _by_name(client, "Sample: CRM")}


def _expected():
    acc = {r["account_id"]: r["sap_no"] for r in csv.DictReader(open(SAMPLE / "crm" / "accounts.csv", encoding="utf-8")) if r["sap_no"]}
    keys = {acc[r["account_id"]] for r in csv.DictReader(open(SAMPLE / "crm" / "tickets.csv", encoding="utf-8"))
            if r["status"] != "Closed" and r["priority"] == "Urgent" and r["account_id"] in acc}
    out = {}
    for r in csv.DictReader(open(SAMPLE / "sap" / "VBRK.csv", encoding="utf-8")):
        if "2025-01-01" <= r["FKDAT"][:10] <= "2025-12-31" and r["KUNRG"].lstrip("0") in keys:
            k = (r["KUNRG"], r["WAERK"])
            n, v = out.get(k, (0, 0.0))
            out[k] = (n + 1, v + float(r["NETWR"]) * (1 if r["VBTYP"] == "M" else -1))
    return keys, out


def test_keys_from_one_data_model_filter_the_other(ctx, fake_llm):
    c, combo, model = ctx["c"], ctx["combo"], ctx["model"]
    keys, exp = _expected()
    assert keys and exp
    before = len(fake_llm.REQUESTS)
    run = _ask(c, combo, model, Q)["run"]
    assert run["status"] == "success", run["error"]
    s2 = run["plan"]["steps"][1]
    assert s2["keys"] == [{"from": "s1.sap_no", "rule": "to_text", "count": len(keys)}]
    assert "{{s1.sap_no|to_text}}" in s2["sql"] and "{{s1.sap_no|to_text}}" in run["final_sql"]      # the plan keeps the placeholder
    got = {(r[1], r[0]): (r[2], r[3]) for r in run["rows"]}
    names = {r["KUNNR"]: r["NAME1"] for r in csv.DictReader(open(SAMPLE / "sap" / "KNA1.csv", encoding="utf-8"))}
    assert len(got) == len(exp) == run["row_count"]
    for (kunnr, cur), (n, v) in exp.items():
        assert got[(cur, names[kunnr])][0] == n and abs(got[(cur, names[kunnr])][1] - v) < 0.05
    sent = json.dumps(fake_llm.REQUESTS[before:])
    assert "{{s1.sap_no" in sent or "Data model `crm`" in sent
    for k in keys:                                        # the keys themselves never reach the model
        assert f"'{k}'" not in sent and f"\\u0027{k}\\u0027" not in sent


def test_a_filtered_person_passes_only_their_keys(ctx):
    c, combo, model, crm = ctx["c"], ctx["combo"], ctx["model"], ctx["crm"]
    u, uid = _login(c, "keys-filtered@test.local")
    f = c.post("/api/admin/filters", headers=H, json={"connection_id": crm["id"], "table_name": "accounts", "condition": "country = 'XX'",
                                                       "scope": "user", "user_id": uid}).json()["id"]
    try:
        run = _ask(u, combo, model, Q)["run"]
        assert run["status"] == "success", run["error"]
        assert run["plan"]["steps"][1]["keys"][0]["count"] == 0 and run["row_count"] == 0       # no keys: nothing from SAP
    finally:
        c.delete(f"/api/admin/filters/{f}", headers=H)


def test_masked_columns_cannot_be_passed_and_limits_apply(ctx):
    c, combo, model, crm = ctx["c"], ctx["combo"], ctx["model"], ctx["crm"]
    c.put(f"/api/connections/{crm['id']}", headers=H, json={**crm, "masked_columns": ["sap_no"]})
    try:
        run = _ask(c, combo, model, Q)["run"]
        assert run["status"] == "error" and "masked" in run["error"] and not run["rows"]
    finally:
        c.put(f"/api/connections/{crm['id']}", headers=H, json={**crm, "masked_columns": crm.get("masked_columns") or []})
    c.put("/api/admin/settings", headers=H, json={"combined_max_keys": 10})
    try:
        run = _ask(c, combo, model, "Pass keys from every ticket to SAP")["run"]
        assert run["status"] == "error" and "more than 10 different values of sap_no" in run["error"] and run["attempts"] == 1
    finally:
        c.put("/api/admin/settings", headers=H, json={"combined_max_keys": 1000})
    run = _ask(c, combo, model, "Use the keys out of order")["run"]
    assert run["status"] == "error" and "must be an earlier step" in run["error"]


def test_edited_plans_and_training_check_the_placeholders(ctx):
    c, combo, model = ctx["c"], ctx["combo"], ctx["model"]
    run = _ask(c, combo, model, Q, review_first=True)["run"]
    plan = {"steps": [{k: s[k] for k in ("id", "source", "sql")} for s in run["plan"]["steps"]], "combine": run["plan"]["combine"]}
    go = lambda p: c.post(f"/api/chat/runs/{run['id']}/execute", headers=H, json={"plan": p})   # noqa: E731
    bad = {**plan, "steps": [plan["steps"][0], {**plan["steps"][1], "sql": plan["steps"][1]["sql"].replace(
        "LTRIM(k.KUNRG, '0') IN ({{s1.sap_no|to_text}})", "k.KUNRG = {{s1.sap_no}}")}]}
    out = go(bad).json()
    assert out["status"] == "error" and "whole list of an IN" in out["error"]
    assert go({**plan, "combine": "SELECT * FROM s2 WHERE customer IN ({{s1.sap_no}})"}).status_code == 400
    assert go({**plan, "steps": [plan["steps"][0], {**plan["steps"][1], "sql": plan["steps"][1]["sql"].replace("|to_text", "|shout")}]}).status_code == 400
    assert go(plan).json()["status"] == "success"
    add = lambda p: c.post(f"/api/training/{combo}", headers=H, json={"kind": "sql_pair", "question": "Urgent keys (training test)", "plan": p})  # noqa: E731
    assert add(bad).status_code == 400
    item = add(plan).json()
    assert "{{s1.sap_no|to_text}}" in item["plan"]["steps"][1]["sql"]
    assert c.post(f"/api/training/{combo}/test-sql", headers=H, json={"plan": plan}).json()["row_count"] > 0
    c.delete(f"/api/training/item/{item['id']}", headers=H)


@pytest.mark.parametrize("db_type", ["postgres", "mysql", "singlestore", "mssql", "oracle", "snowflake", "files"])
def test_keys_cannot_change_the_sql_around_them(db_type):
    sql = planner.fill_keys("SELECT a FROM t WHERE a IN ({{s1.k}}) AND b NOT IN ({{s1.k|trim}})", db_type, {0: HOSTILE, 1: []})
    checked = sqlguard.check(sql, db_type)
    import sqlglot
    from sqlglot import exp
    tree = sqlglot.parse_one(sql, read=sqlguard.SQLGLOT_DIALECT[db_type])
    lits = [lit.this for i in tree.find_all(exp.In) for lit in i.expressions]
    assert lits == [str(v) for v in HOSTILE]                       # exactly the values, nothing more
    assert len(list(tree.find_all(exp.Or))) == 0 and len(list(tree.find_all(exp.Drop))) == 0
    assert checked.tables == ["t"]


def test_hostile_keys_match_only_themselves_in_duckdb():
    import duckdb
    con = duckdb.connect()
    con.execute("CREATE TABLE t AS SELECT * FROM (VALUES ('O''Brien'), ('secret'), ('x')) v(a)")
    sql = planner.fill_keys("SELECT a FROM t WHERE a IN ({{s1.k}})", "files", {0: [v for v in HOSTILE if isinstance(v, str)]})
    assert con.execute(sql).fetchall() == [("O'Brien",)]
    assert con.execute(planner.fill_keys("SELECT a FROM t WHERE a NOT IN ({{s1.k}})", "files", {0: []})).fetchall() == [("O'Brien",), ("secret",), ("x",)]


def test_unsafe_keys_and_placements_are_refused():
    step = {"id": "s1", "columns": [{"name": "k"}], "_rows": [["fine"], ["back\\slash"]]}
    with pytest.raises(planner.PlanError, match="backslash"):
        planner._key_values(step, "k", "", 1000, "s2")
    for sql in ("SELECT * FROM t WHERE a = {{s1.k}}", "SELECT '{{s1.k}}' AS x FROM t", "SELECT * FROM t WHERE a IN ({{s1.k}}, 5)",
                "SELECT * FROM t WHERE a IN (SELECT {{s1.k}})"):
        with pytest.raises(planner.PlanError):
            planner.fill_keys(sql, "postgres", {0: [1]})
