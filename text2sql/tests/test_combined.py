"""Combined data models (phase 2): set-up, matching fields across data models, the value check, access and isolation."""
import json
from pathlib import Path

import pytest

from tests.conftest import H


def _sign_in(email, password, new="Combined-Passw0rd-1"):
    from fastapi.testclient import TestClient
    from app import security
    from app.main import app
    security.limiter._hits.pop("login:testclient", None)
    c = TestClient(app)
    assert c.post("/api/auth/login", headers=H, json={"email": email, "password": password}).status_code == 200
    c.post("/api/auth/change-password", headers=H, json={"current": password, "new": new})
    return c


def _by_name(client, name):
    return next(c for c in client.get("/api/connections").json() if c["name"] == name)


def _match(view, lt, lc, rt, rc):
    for m in view["matches"]:
        if (m["raw_left_table"], m["left_columns"], m["raw_right_table"], m["right_columns"]) in ((lt, lc, rt, rc), (rt, rc, lt, lc)):
            return m
    return None


def test_key_rules_match_between_python_and_duckdb():
    import duckdb
    from app import matching
    vals = ["0000100001", "  0000100002 ", "100003", "ABC-12", "", None, "00000", "Kd 7"]
    con = duckdb.connect()
    con.execute("CREATE TABLE t (v VARCHAR)")
    con.executemany("INSERT INTO t VALUES (?)", [[v] for v in vals])
    for rule in matching.NORMALISATIONS:
        if rule == "to_number":
            continue
        py = [matching.normalise(rule, v) for v in vals]
        duck = [r[0] for r in con.execute(f"SELECT {matching.duck_expr(rule, 'v')} FROM t").fetchall()]
        assert [None if x is None else str(x) for x in py] == duck, rule
    o = matching.overlap(["0000100001", "0000100002", "0000100003"], [100001, 100002, 999])
    assert o["rule"] == "strip_zeros" and o["matched"] == 2 and o["left_pct"] == 66.7
    assert set(o) == {"rule", "matched", "left_distinct", "right_distinct", "left_pct", "right_pct"}       # counts, never values


def test_samples_crm_and_the_combined_model(admin):
    client = admin[0]
    spec = json.loads((Path(__file__).parent.parent / "sample_data" / "crm_training.json").read_text(encoding="utf-8"))
    crm = _by_name(client, "Sample: CRM")
    assert crm["table_count"] == 3
    from app import engine
    from app.db import SessionLocal
    from app.deps import get_settings
    from app.models import Connection, User
    with SessionLocal() as db:                       # every verified CRM example runs and returns rows
        conn, user, cfg = db.get(Connection, crm["id"]), db.query(User).filter(User.role == "admin").first(), get_settings(db)
        for e in spec["examples"]:
            assert engine.run_sql(db, conn, e["sql"], cfg, user)["row_count"] > 0, e["question"]

    comb = _by_name(client, "Sample: SAP + CRM")
    assert comb["db_type"] == "combined" and [m["alias"] for m in comb["members"]] == ["sap", "crm"] and comb["ready"]
    v = client.get(f"/api/combined/{comb['id']}").json()
    m = _match(v, "kna1", ["KUNNR"], "accounts", ["sap_no"])
    assert m["status"] == "confirmed" and m["normalisation"] == "strip_zeros" and m["cardinality"] in ("1:1",)
    assert v["ready"] and v["overlap_check"] and v["tables"] and any(t["name"] == "crm.accounts" for t in v["tables"])
    assert any(e.get("inside") for e in v["edges"])                            # each model's own joins, for the diagram
    from app.main import add_combined_sample                                    # added once: no duplicate on restart
    add_combined_sample(1)
    assert sum(c["name"] == "Sample: SAP + CRM" for c in client.get("/api/connections").json()) == 1


def test_suggestions_and_the_value_check_never_reach_the_model(admin, fake_llm):
    client = admin[0]
    comb = _by_name(client, "Sample: SAP + CRM")
    n_requests = len(fake_llm.REQUESTS)
    r = client.post(f"/api/combined/{comb['id']}/find-matches", headers=H)
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["result"]["checked"] > 0                                           # values were checked (the sample has it on)
    sugg = [m for m in v["matches"] if m["status"] == "suggested"]
    assert sugg and all(m["origin"] == "matching" for m in sugg)
    checked = [m for m in sugg if m["stats"]]
    assert checked and all(set(m["stats"]) <= {"rule", "matched", "left_distinct", "right_distinct", "left_pct", "right_pct",
                                               "left_truncated", "right_truncated", "checked_at", "left_unique", "right_unique", "masked"}
                           for m in checked)
    key = _match(v, "kna1", ["KUNNR"], "accounts", ["sap_no"])
    out = client.post(f"/api/combined/{comb['id']}/matches/{key['id']}/check", headers=H).json()
    key = _match(out, "kna1", ["KUNNR"], "accounts", ["sap_no"])
    pct = key["stats"]["left_pct"] if key["raw_left_table"] == "accounts" else key["stats"]["right_pct"]
    assert key["stats"]["rule"] == "strip_zeros" and pct == 100.0               # every CRM customer number is an SAP customer
    assert key["status"] == "confirmed"                                         # a check never changes a decision
    assert len(fake_llm.REQUESTS) == n_requests                                 # no AI model is involved in matching
    acts = [a["action"] for a in client.get("/api/admin/audit?action=combined").json()["items"]]
    assert "combined.matches_found" in acts and "combined.overlap_checked" in acts


def test_metadata_alone_suggests_the_customer_number(admin):
    """Without reading any data: the CRM dictionary says sap_no is the SAP KUNNR, so the pair is suggested."""
    from app import matching
    from app.db import SessionLocal
    from app.models import Connection
    client = admin[0]
    sap, crm = _by_name(client, "Sample: SAP Sales & Finance"), _by_name(client, "Sample: CRM")
    with SessionLocal() as db:
        found = matching.candidates(db, db.get(Connection, sap["id"]), db.get(Connection, crm["id"]))
    top = next(f for f in found if (f["a"]["table"], f["a"]["column"], f["b"]["table"], f["b"]["column"]) == ("kna1", "KUNNR", "accounts", "sap_no"))
    assert top["score"] >= 0.5 and top["rule"] == "strip_zeros" and any("names KUNNR" in w for w in top["why"])


def test_create_validate_decide_and_delete(admin):
    client = admin[0]
    retail, crm = _by_name(client, "Sample: Retail sales"), _by_name(client, "Sample: CRM")
    sap_combined = _by_name(client, "Sample: SAP + CRM")
    body = lambda **kw: {"name": "Retail + CRM", "members": [{"id": retail["id"], "alias": "shop"}, {"id": crm["id"], "alias": "crm"}], **kw}
    for bad, why in ((body(members=[{"id": retail["id"], "alias": "shop"}]), "Pick between 2"),
                     (body(members=[{"id": retail["id"], "alias": "shop"}, {"id": sap_combined["id"], "alias": "both"}]), "nested"),
                     (body(members=[{"id": retail["id"], "alias": "x"}, {"id": crm["id"], "alias": "x"}]), "used twice"),
                     (body(members=[{"id": retail["id"], "alias": "Shop Data"}, {"id": crm["id"], "alias": "crm"}]), "short name"),
                     (body(name="Sample: CRM"), "already exists")):
        r = client.post("/api/combined", headers=H, json=bad)
        assert r.status_code == 400 and why in r.json()["detail"], (why, r.text)
    client.put("/api/admin/settings", headers=H, json={"combined_max_sources": 2})
    three = body(members=[{"id": retail["id"], "alias": "shop"}, {"id": crm["id"], "alias": "crm"},
                          {"id": _by_name(client, "Sample: SAP Sales & Finance")["id"], "alias": "sap"}])
    assert "between 2 and 2" in client.post("/api/combined", headers=H, json=three).json()["detail"]
    client.put("/api/admin/settings", headers=H, json={"combined_max_sources": 4})

    v = client.post("/api/combined", headers=H, json=body()).json()
    assert v["name"] == "Retail + CRM" and not v["ready"]                        # nothing confirmed yet
    assert client.post("/api/chat/ask", headers=H, json={"connection_id": v["id"], "question": "x"}).json()["detail"].startswith("Questions across a combined")
    # a steward's own match, then reject / restore on a suggestion
    added = client.post(f"/api/combined/{v['id']}/matches", headers=H, json={
        "left_member": retail["id"], "left_table": "customers", "left_columns": ["customer_name"], "right_member": crm["id"],
        "right_table": "accounts", "right_columns": ["account_name"], "normalisation": "lower", "cardinality": "1:1"}).json()
    mine = _match(added, "customers", ["customer_name"], "accounts", ["account_name"])
    assert mine["status"] == "confirmed" and mine["origin"] == "steward" and added["ready"]
    bad = client.post(f"/api/combined/{v['id']}/matches", headers=H, json={
        "left_member": retail["id"], "left_table": "customers", "left_columns": ["nope"], "right_member": crm["id"],
        "right_table": "accounts", "right_columns": ["account_id"], "normalisation": "rot13"})
    assert bad.status_code == 400
    s = next((m for m in added["matches"] if m["status"] == "suggested"), None)
    if s:
        client.put(f"/api/graph/edges/{s['id']}", headers=H, json={"action": "reject"})
        again = client.post(f"/api/combined/{v['id']}/find-matches", headers=H).json()
        assert next(m for m in again["matches"] if m["id"] == s["id"])["status"] == "rejected"
        assert client.put(f"/api/graph/edges/{s['id']}", headers=H, json={"action": "restore"}).json()["status"] == "suggested"
    upd = client.put(f"/api/graph/edges/{mine['id']}", headers=H, json={"normalisation": "upper"}).json()
    assert upd["status"] == "confirmed"
    assert client.put(f"/api/graph/edges/{mine['id']}", headers=H, json={"normalisation": "made-up"}).status_code == 400
    assert client.post(f"/api/connections/{v['id']}/sync", headers=H).status_code == 400

    # a member deleted: the combined model is switched off with a notice, the other data model is untouched
    files = client.post("/api/connections", headers=H, json={"name": "Combined test files", "db_type": "files", "config": {}}).json()
    client.post(f"/api/connections/{files['id']}/files", headers=H, files=[("uploads", ("t.csv", b"id,name\n1,a\n", "text/csv"))])
    client.post(f"/api/connections/{files['id']}/sync", headers=H)
    c2 = client.post("/api/combined", headers=H, json={"name": "Files + CRM", "members": [{"id": files["id"], "alias": "f"},
                                                                                         {"id": crm["id"], "alias": "crm"}]}).json()
    client.delete(f"/api/connections/{files['id']}", headers=H)
    after = _by_name(client, "Files + CRM")
    assert not after["is_active"] and "was deleted" in after["notice"] and [m["alias"] for m in after["members"]] == ["crm"]
    assert _by_name(client, "Sample: CRM")["is_active"]
    for cid in (v["id"], c2["id"]):
        assert client.delete(f"/api/combined/{cid}", headers=H).status_code == 200
    acts = [a["action"] for a in client.get("/api/admin/audit?action=combined").json()["items"]]
    assert {"combined.created", "combined.deleted", "combined.member_removed"} <= set(acts)


def test_access_needs_every_member_and_stays_in_the_company(admin):
    client = admin[0]
    retail, crm = _by_name(client, "Sample: Retail sales"), _by_name(client, "Sample: CRM")
    v = client.post("/api/combined", headers=H, json={"name": "Access test", "members": [{"id": retail["id"], "alias": "shop"},
                                                                                        {"id": crm["id"], "alias": "crm"}]}).json()
    made = client.post("/api/admin/users", headers=H, json={"email": "comb-steward@test.local", "role": "steward"}).json()
    steward = _sign_in("comb-steward@test.local", made["temporary_password"])
    assert steward.get(f"/api/combined/{v['id']}").status_code == 200
    client.put(f"/api/admin/access/{crm['id']}", headers=H, json={"is_active": True, "restricted": True})       # CRM restricted
    assert steward.get(f"/api/combined/{v['id']}").status_code == 404                                         # no CRM, no combined
    assert "Access test" not in [c["name"] for c in steward.get("/api/connections").json()]
    assert steward.post("/api/combined", headers=H, json={"name": "Sneaky", "members": [{"id": retail["id"], "alias": "a"},
                                                                                       {"id": crm["id"], "alias": "b"}]}).status_code == 400
    client.put(f"/api/admin/access/{crm['id']}", headers=H, json={"is_active": True, "restricted": False})
    analyst = client.post("/api/admin/users", headers=H, json={"email": "comb-analyst@test.local", "role": "analyst"}).json()
    an = _sign_in("comb-analyst@test.local", analyst["temporary_password"])
    assert an.get(f"/api/combined/{v['id']}").status_code == 403 and an.post("/api/combined", headers=H, json={}).status_code in (403, 422)

    co = client.post("/api/admin/companies", headers=H, json={"name": "Combined Other Co", "admin_email": "boss@comb-other.test",
                                                              "samples": False}).json()
    other = _sign_in("boss@comb-other.test", co["temporary_password"])
    assert other.get(f"/api/combined/{v['id']}").status_code == 404
    assert other.post("/api/combined", headers=H, json={"name": "Theirs", "members": [{"id": retail["id"], "alias": "a"},
                                                                                     {"id": crm["id"], "alias": "b"}]}).status_code == 400
    m = client.get(f"/api/combined/{v['id']}").json()["matches"]
    if m:
        assert other.put(f"/api/graph/edges/{m[0]['id']}", headers=H, json={"action": "confirm"}).status_code == 404
    client.delete(f"/api/combined/{v['id']}", headers=H)
    for u in (made, analyst):
        client.delete(f"/api/admin/users/{u['id']}", headers=H)
