"""Metadata graph (phase 1): joins from foreign keys and verified SQL, suggestions a steward decides on, join paths in the
prompt - and nothing changes for a data model whose graph has nothing confirmed."""
import pytest

from tests.conftest import H


def _sign_in(email, password, new="Graph-Passw0rd-1"):
    from fastapi.testclient import TestClient
    from app import security
    from app.main import app
    security.limiter._hits.pop("login:testclient", None)
    c = TestClient(app)
    assert c.post("/api/auth/login", headers=H, json={"email": email, "password": password}).status_code == 200
    c.post("/api/auth/change-password", headers=H, json={"current": password, "new": new})
    return c


def _conn(name):
    """The first company's copy of a bundled sample (other tests add companies with their own copies)."""
    from app.db import SessionLocal
    from app.models import Connection
    with SessionLocal() as db:
        return db.query(Connection).filter(Connection.name == name).order_by(Connection.id).first().id


def _prompt(conn_id, question):
    from app import engine
    from app.db import SessionLocal
    from app.models import Connection
    with SessionLocal() as db:
        c = db.get(Connection, conn_id)
        return engine.build_prompt(db, c, question, [], 1000)


def _find(edges, left, lcols, right, rcols):
    for e in edges:
        if (e["left_table"], e["left_columns"], e["right_table"], e["right_columns"]) == (left, lcols, right, rcols) or \
           (e["right_table"], e["right_columns"], e["left_table"], e["left_columns"]) == (left, lcols, right, rcols):
            return e
    return None


def test_foreign_keys_become_confirmed_joins():
    from app import graph
    tables = {"orders": {"schema": None, "name": "orders", "columns": [{"name": "id", "pk": True}, {"name": "customer_id"}],
                         "fks": [{"columns": ["customer_id"], "ref_table": "customers", "ref_columns": ["id"]}]},
              "customers": {"schema": None, "name": "customers", "columns": [{"name": "id", "pk": True}], "fks": []}}
    [e] = graph.fk_edges(tables)
    assert (e["left_table"], e["left_columns"], e["right_table"], e["right_columns"]) == ("orders", ["customer_id"], "customers", ["id"])
    assert e["origin"] == "schema" and e["cardinality"] == "N:1"
    # joins inside a CTE body count; joins to a CTE, literal conditions and unknown tables do not
    sql = ("WITH x AS (SELECT o.customer_id FROM orders o JOIN customers c ON c.id = o.customer_id AND c.id > 3) "
           "SELECT * FROM x JOIN customers k ON k.id = x.customer_id JOIN nowhere n ON n.a = k.id")
    found = [(graph.connectors.table_fqn(a), b, graph.connectors.table_fqn(c), d) for a, b, c, d in graph.sql_joins(sql, "postgres", tables)]
    assert found == [("customers", ["id"], "orders", ["customer_id"])]


def test_verified_sql_and_suggestions_on_the_sap_sample(admin):
    client = admin[0]
    sap = _conn("Sample: SAP Sales & Finance")
    g = client.get(f"/api/graph/{sap}").json()
    edges = g["edges"]
    confirmed = [e for e in edges if e["status"] == "confirmed"]
    assert len(confirmed) >= 15 and all(e["origin"] == "verified_sql" for e in confirmed)
    assert _find(confirmed, "vbrk", ["VBELN"], "vbrp", ["VBELN"])
    assert _find(confirmed, "kna1", ["KUNNR"], "vbrk", ["KUNRG"])
    composite = _find(confirmed, "bkpf", ["GJAHR", "BUKRS", "BELNR"], "bseg", ["GJAHR", "BUKRS", "BELNR"])
    assert composite and "Verified example" in composite["evidence"][0]
    sugg = [e for e in edges if e["status"] == "suggested"]
    assert _find(sugg, "vbap", ["MATNR"], "mara", ["MATNR"]) and all(e["origin"] == "names" for e in sugg)
    assert not any("SPRAS" in e["left_columns"] for e in sugg)                 # a language field is not a join key
    assert g["counts"]["confirmed"] == len(confirmed)

    from app import graph
    from app.db import SessionLocal
    from app.models import Connection
    with SessionLocal() as db:
        path = graph.shortest_path(graph.confirmed_edges(db, db.get(Connection, sap)), "vbrp", "kna1")
        assert [sorted([e.left_table, e.right_table]) for e in path] == [["vbrk", "vbrp"], ["kna1", "vbrk"]]


def test_join_paths_and_entities_reach_the_prompt(admin):
    client = admin[0]
    sap = _conn("Sample: SAP Sales & Finance")
    client.get(f"/api/graph/{sap}")
    system, _, ctx = _prompt(sap, "Net sales and gross margin by product line for our top customers")
    assert "## Join paths" in system and ctx["join_paths"] > 0
    assert "kna1.KUNNR = vbrk.KUNRG" in system                                 # customer to billing header
    assert "vbrk.VBELN = vbrp.VBELN" in system                                 # header to items, where the product line is
    assert "~" not in system.split("## Join paths")[1].split("##")[0]          # suggestions are never sent
    r = client.post(f"/api/graph/{sap}/entities", headers=H, json={
        "name": "Customer", "synonyms": ["client", "sold-to party"], "description": "Someone we invoice",
        "bindings": [{"table": "KNA1", "key_columns": ["kunnr"], "source_of_truth": True}]})
    assert r.status_code == 200, r.text
    ent = next(x for x in client.get(f"/api/graph/{sap}").json()["entities"] if x["name"] == "Customer")
    assert ent["bindings"] == [{"table": "kna1", "key_columns": ["KUNNR"], "source_of_truth": True}]
    system, _, ctx = _prompt(sap, "How many invoices per client last year?")
    assert "Customer (also called: client, sold-to party): kna1 (key KUNNR)" in system and ctx["entities"] == ["Customer"]
    assert client.post(f"/api/graph/{sap}/entities", headers=H, json={"name": "Customer", "bindings": [{"table": "nope"}]}).status_code == 400
    assert client.delete(f"/api/graph/{sap}/entities/{ent['id']}", headers=H).status_code == 200
    assert not any(x["name"] == "Customer" for x in client.get(f"/api/graph/{sap}").json()["entities"])


def test_a_model_without_confirmed_joins_is_unchanged(admin):
    client = admin[0]
    c = client.post("/api/connections", headers=H, json={"name": "Graph test files", "db_type": "files", "config": {}}).json()
    files = [("uploads", ("shops.csv", b"shop_id,city\n1,Pune\n2,Delhi\n", "text/csv")),
             ("uploads", ("visits.csv", b"visit_id,shop_id,visitors\n1,1,30\n2,2,12\n", "text/csv"))]
    assert client.post(f"/api/connections/{c['id']}/files", headers=H, files=files).status_code == 200
    client.post(f"/api/connections/{c['id']}/sync", headers=H)
    g = client.get(f"/api/graph/{c['id']}").json()
    assert not [e for e in g["edges"] if e["status"] == "confirmed"]          # CSV files: no keys, no verified SQL yet
    assert _find(g["edges"], "visits", ["shop_id"], "shops", ["shop_id"])["status"] == "suggested"
    system, _, ctx = _prompt(c["id"], "visitors by city")
    assert "## Join paths" not in system and ctx["join_paths"] == 0 and ctx["entities"] == []
    assert sorted(ctx["tables"]) == ["shops", "visits"]                        # small schema: every table, as before
    client.delete(f"/api/connections/{c['id']}", headers=H)


def test_steward_decisions_survive_rebuilds(admin):
    client = admin[0]
    retail = _conn("Sample: Retail sales")
    edges = client.get(f"/api/graph/{retail}").json()["edges"]
    s = _find(edges, "orders", ["customer_id"], "customers", ["customer_id"])
    r = client.put(f"/api/graph/edges/{s['id']}", headers=H, json={"action": "confirm", "cardinality": "N:1"
                                                                   if s["left_table"] == "orders" else "1:N"})
    assert r.json()["status"] == "confirmed" and r.json()["decided"]
    rej = _find(edges, "products", ["product_id"], "order_items", ["product_id"])
    client.put(f"/api/graph/edges/{rej['id']}", headers=H, json={"action": "reject"})
    client.post(f"/api/graph/{retail}/rebuild", headers=H)
    after = client.get(f"/api/graph/{retail}").json()["edges"]
    assert _find(after, "orders", ["customer_id"], "customers", ["customer_id"])["status"] == "confirmed"
    assert _find(after, "products", ["product_id"], "order_items", ["product_id"])["status"] == "rejected"   # remembered
    system, _, ctx = _prompt(retail, "revenue by customer")
    assert "orders.customer_id = customers.customer_id  (N:1)" in system or "customers.customer_id = orders.customer_id  (1:N)" in system
    assert "product_id" not in system.split("## Join paths")[1].split("##")[0]

    # a steward's own join; adding the same pair again confirms the existing row instead of duplicating it
    bad = client.post(f"/api/graph/{retail}/edges", headers=H, json={"left_table": "orders", "left_columns": ["nope"],
                                                                      "right_table": "customers", "right_columns": ["customer_id"]})
    assert bad.status_code == 400 and "nope" in bad.json()["detail"]
    mine = client.post(f"/api/graph/{retail}/edges", headers=H, json={"left_table": "order_items", "left_columns": ["order_id"],
                                                                       "right_table": "orders", "right_columns": ["order_id"], "cardinality": "N:1"}).json()
    again = client.post(f"/api/graph/{retail}/edges", headers=H, json={"left_table": "ORDERS", "left_columns": ["ORDER_ID"],
                                                                        "right_table": "order_items", "right_columns": ["order_id"]}).json()
    assert again["id"] == mine["id"] and again["status"] == "confirmed"
    assert client.delete(f"/api/graph/edges/{s['id']}", headers=H).status_code == 400        # not the steward's: reject it
    restored = client.put(f"/api/graph/edges/{rej['id']}", headers=H, json={"action": "restore"}).json()
    assert rej["origin"] == "verified_sql" and restored["status"] == "confirmed" and not restored["decided"]   # back to automatic
    sug = client.put(f"/api/graph/edges/{s['id']}", headers=H, json={"action": "restore"}).json()
    assert sug["status"] == "suggested" and not sug["decided"]
    acts = [a["action"] for a in client.get("/api/admin/audit?action=graph").json()["items"]]
    assert {"graph.edge_confirmed", "graph.edge_rejected", "graph.rebuilt", "graph.edge_restored"} <= set(acts)
    if mine.get("origin") == "steward":
        client.delete(f"/api/graph/edges/{mine['id']}", headers=H)


def test_new_verified_sql_updates_the_graph(admin):
    client = admin[0]
    retail = _conn("Sample: Retail sales")
    before = _find(client.get(f"/api/graph/{retail}").json()["edges"], "orders", ["customer_id"], "customers", ["customer_id"])
    assert before["status"] == "suggested"
    pair = client.post(f"/api/training/{retail}", headers=H, json={
        "kind": "sql_pair", "question": "Orders per customer segment for the graph test",
        "sql": "SELECT c.segment, COUNT(*) FROM orders o JOIN customers c USING (customer_id) GROUP BY 1"}).json()
    e = _find(client.get(f"/api/graph/{retail}").json()["edges"], "orders", ["customer_id"], "customers", ["customer_id"])
    assert e["status"] == "confirmed" and e["origin"] == "verified_sql" and "Orders per customer segment" in e["evidence"][0]
    client.delete(f"/api/training/item/{pair['id']}", headers=H)
    e = _find(client.get(f"/api/graph/{retail}").json()["edges"], "orders", ["customer_id"], "customers", ["customer_id"])
    assert e["status"] == "suggested" and e["origin"] == "names"              # back to a suggestion


def test_only_stewards_of_the_same_company(admin):
    client = admin[0]
    sap = _conn("Sample: SAP Sales & Finance")
    edge = next(e for e in client.get(f"/api/graph/{sap}").json()["edges"] if e["status"] == "confirmed")
    made = client.post("/api/admin/users", headers=H, json={"email": "graph-analyst@test.local", "role": "analyst"}).json()
    analyst = _sign_in("graph-analyst@test.local", made["temporary_password"])
    assert analyst.get(f"/api/graph/{sap}").status_code == 403
    co = client.post("/api/admin/companies", headers=H, json={"name": "Graph Other Co", "admin_email": "boss@graph-other.test",
                                                              "samples": False}).json()
    other = _sign_in("boss@graph-other.test", co["temporary_password"])
    assert other.get(f"/api/graph/{sap}").status_code == 404
    assert other.put(f"/api/graph/edges/{edge['id']}", headers=H, json={"action": "reject"}).status_code == 404
    assert other.post(f"/api/graph/{sap}/rebuild", headers=H).status_code == 404
    client.delete(f"/api/admin/users/{made['id']}", headers=H)
