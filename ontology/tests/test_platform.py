"""API-level tests. Each one would fail if the rule it names broke."""
import io
import json
import sqlite3
import tempfile

import pytest
from rdflib import Graph

from tests.conftest import H, make_user, wait_job


@pytest.fixture(scope="module")
def built(admin):
    """An ontology built end to end by the stand-in model, with required use cases."""
    c, mid = admin
    oid = c.post("/api/ontologies", headers=H, json={"name": "Retail test", "domain": "Retail order management", "scope": "Orders and returns",
                                                    "requirements": "Must track gift cards.", "use_cases": ["Which customers ordered twice this month?"]}).json()["id"]
    j = wait_job(c, c.post(f"/api/ontologies/{oid}/build", headers=H, json={"model_id": mid, "use_cases": 4}).json()["id"])
    assert j["status"] == "done", j
    return c, mid, oid, j


def test_first_run_has_sample_and_no_secrets(admin):
    c, mid = admin
    lib = c.get("/api/library").json()
    assert any(o["name"].startswith("Sample:") and o["status"] == "ready" for o in lib["ontologies"])
    models = c.get("/api/admin/models").json()["models"]
    assert all("api_key" not in m and "api_key_enc" not in m for m in models)
    assert "sk-secret-value" not in json.dumps(models)
    assert c.post(f"/api/admin/models/{mid}/test", headers=H).json()["ok"] is True


def test_csrf_and_auth_required(app_client):
    from fastapi.testclient import TestClient
    from app.main import app
    anon = TestClient(app)
    assert anon.get("/api/library").status_code == 401
    assert anon.post("/api/auth/login", json={"email": "a", "password": "b"}).status_code == 403      # no X-Requested-With


def test_build_pipeline(built, fake_llm):
    c, mid, oid, job = built
    o = c.get(f"/api/ontologies/{oid}").json()
    ct = o["content"]
    ids = {k["id"] for k in ct["classes"]}
    assert o["status"] == "ready" and o["version"] == 1
    assert {"Order", "Customer", "GiftCard"} <= ids                 # GiftCard comes from the completeness review
    assert "GhostClass" in ids and next(k for k in ct["classes"] if k["id"] == "GhostClass")["parent"] is None   # dangling parent repaired
    assert not any(p["id"] == "dangling" for p in ct["properties"])  # a property to a class that does not exist is dropped
    assert job["result"]["review"]["added"] >= 3 and job["calls"] == 6 and job["cost"] > 0
    # facts about a catalogued standard come from the catalogue; an unknown one is flagged and its bad link dropped
    st = {s["id"]: s for s in ct["standards"]}
    assert st["schema"]["in_catalogue"] and st["schema"]["namespace"] == "https://schema.org/"
    assert st["arts"]["in_catalogue"] is False and st["arts"]["url"] == ""
    # the owner's use case comes first and is marked as required
    assert ct["use_cases"][0]["source"] == "required" and "twice this month" in ct["use_cases"][0]["question"]
    assert len(ct["use_cases"]) == 5
    sent = json.dumps(fake_llm.REQUESTS)
    assert "Must track gift cards." in sent and "sk-secret-value" not in sent


def test_exports_are_valid(built):
    c, _, oid, _ = built
    for fmt, rd in (("ttl", "turtle"), ("owl", "xml"), ("jsonld", "json-ld")):
        r = c.get(f"/api/ontologies/{oid}/export/{fmt}")
        assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
        g = Graph().parse(data=r.content, format=rd)
        assert len(g) > 500
        q = "ASK { ?c a <http://www.w3.org/2002/07/owl#Class> ; <http://www.w3.org/2000/01/rdf-schema#label> 'Order'@en }"
        assert g.query(q).askAnswer
    doc = c.get(f"/api/ontologies/{oid}/export/json").json()
    assert doc["format"] == "ontostudio-ontology" and doc["stats"]["classes"] == len(doc["classes"])
    pdf = c.get(f"/api/ontologies/{oid}/export/pdf")
    assert pdf.content[:5] == b"%PDF-" and len(pdf.content) > 50000
    from pypdf import PdfReader
    text = " ".join(p.extract_text() for p in PdfReader(io.BytesIO(pdf.content)).pages)
    assert "Industry standards it builds on" in text and "Schema.org" in text and "Gift card" in text
    ppt = c.get(f"/api/ontologies/{oid}/export/pptx")
    from pptx import Presentation
    prs = Presentation(io.BytesIO(ppt.content))
    assert len(prs.slides) >= 12
    assert any(sh.shape_type == 13 for s in prs.slides for sh in s.shapes)      # diagrams are embedded as pictures


def test_test_bed_checks_the_models_claims(built):
    c, mid, oid, _ = built
    r = c.post(f"/api/ontologies/{oid}/tests", headers=H, json={"text": "Track warranty claims for products customers bought", "model_id": mid}).json()
    wait_job(c, r["job"]["id"])
    t = c.get(f"/api/ontologies/{oid}/tests/{r['test']['id']}").json()
    res = t["result"]
    by = {x["text"]: x for x in res["requirements"]}
    # the model claimed "covered" pointing at an element that does not exist: the server does not believe it
    assert by["Imaginary element"]["claimed"] == "covered" and by["Imaginary element"]["status"] == "missing" and by["Imaginary element"]["check"]
    assert res["counts"] == {"covered": 1, "partial": 0, "missing": 3} and t["score"] == 0.25 and t["verdict"] == "not_addressed"
    assert [k["id"] for k in res["suggestions"]["classes"]] == ["Warranty"]
    assert [p["id"] for p in res["suggestions"]["properties"]] == ["coveredBy"]      # the proposal to a non-existent class is dropped
    assert any(n["style"] == "gap" for n in t["diagram"]["nodes"]) and any(e["style"] == "gap" for e in t["diagram"]["edges"])
    # close the gap, test again: coverage rises
    a = c.post(f"/api/ontologies/{oid}/tests/{t['id']}/apply", headers=H).json()
    assert a["added"] == 2
    r2 = c.post(f"/api/ontologies/{oid}/tests", headers=H, json={"text": "Track warranty claims for products customers bought", "model_id": mid}).json()
    wait_job(c, r2["job"]["id"])
    t2 = c.get(f"/api/ontologies/{oid}/tests/{r2['test']['id']}").json()
    assert t2["score"] == 1.0 and t2["verdict"] == "addressed" and t2["version"] == a["version"]
    # a "covered" attribute with only a class as evidence is downgraded to partial
    r3 = c.post(f"/api/ontologies/{oid}/tests", headers=H, json={"text": "Does the weather affect store sales?", "model_id": mid}).json()
    wait_job(c, r3["job"]["id"])
    t3 = c.get(f"/api/ontologies/{oid}/tests/{r3['test']['id']}").json()
    assert t3["result"]["counts"] == {"covered": 0, "partial": 1, "missing": 1} and t3["score"] == 0.25
    s = c.get(f"/api/ontologies/{oid}/tests").json()["summary"]
    assert s["tested"] == 2 and s["addressed"] == 1          # latest result per distinct use case


def test_refine_edit_versions_restore(built):
    c, mid, oid, _ = built
    v0 = c.get(f"/api/ontologies/{oid}").json()["version"]
    j = wait_job(c, c.post(f"/api/ontologies/{oid}/run/refine", headers=H, json={"model_id": mid, "instruction": "Add a loyalty programme"}).json()["id"])
    assert j["status"] == "done" and j["result"]["added"] == 2
    j = wait_job(c, c.post(f"/api/ontologies/{oid}/run/refine", headers=H, json={"model_id": mid, "instruction": "change nothing please"}).json()["id"])
    assert j["status"] == "error" and "no change" in j["error"]
    assert c.get(f"/api/ontologies/{oid}").json()["status"] == "ready"         # a failed job does not leave it stuck on "building"
    # manual edit, as the diagram editor sends it
    e = c.post(f"/api/ontologies/{oid}/edit", headers=H, json={"note": "Added Wishlist", "patch": {
        "classes": [{"id": "wish list", "label": "Wish list", "parent": "Order", "definition": "Products a customer saved for later.", "module": "Sales"}],
        "properties": [{"id": "savedBy", "kind": "object", "domain": "WishList", "range": "Customer"}, {"id": "broken", "kind": "object", "domain": "WishList", "range": "Nope"}]}}).json()
    ids = {k["id"] for k in e["content"]["classes"]}
    assert "WishList" in ids and any(p["id"] == "savedBy" for p in e["content"]["properties"]) and not any(p["id"] == "broken" for p in e["content"]["properties"])
    # removing a class drops the properties that hang on it and moves its children up
    c.post(f"/api/ontologies/{oid}/edit", headers=H, json={"patch": {"classes": [{"id": "SubWish", "parent": "WishList", "module": "Sales", "definition": "A child class."}]}})
    e = c.post(f"/api/ontologies/{oid}/edit", headers=H, json={"patch": {"remove_classes": ["WishList"]}}).json()
    assert not any(p["id"] == "savedBy" for p in e["content"]["properties"])
    assert next(k for k in e["content"]["classes"] if k["id"] == "SubWish")["parent"] == "Order"
    vs = c.get(f"/api/ontologies/{oid}/versions").json()
    assert vs[0]["number"] == e["version"] and "WishList" in vs[0]["diff"]["classes_removed"]
    r = c.post(f"/api/ontologies/{oid}/versions/{v0}/restore", headers=H).json()
    after = c.get(f"/api/ontologies/{oid}").json()
    assert after["version"] == r["version"] and not any(k["id"] == "LoyaltyProgram" for k in after["content"]["classes"])


def test_bad_json_is_retried_once(admin):
    c, mid = admin
    oid = c.post("/api/ontologies", headers=H, json={"name": "Retry", "domain": "Retail BROKEN-JSON"}).json()["id"]
    j = wait_job(c, c.post(f"/api/ontologies/{oid}/build", headers=H, json={"model_id": mid, "use_cases": 0}).json()["id"])
    assert j["status"] == "done" and j["calls"] == 10          # 5 steps, each answered properly on the second try
    c.delete(f"/api/ontologies/{oid}", headers=H)


def test_sources_documents_and_database_schema(admin, fake_llm):
    c, mid = admin
    oid = c.post("/api/ontologies", headers=H, json={"name": "From sources"}).json()["id"]
    r = c.post(f"/api/ontologies/{oid}/build", headers=H, json={"model_id": mid})
    assert r.status_code == 400                                 # nothing to build from yet
    path = tempfile.mktemp(suffix=".db")
    con = sqlite3.connect(path)
    con.executescript("create table customers(id integer primary key, name text); create table loans(id integer primary key, "
                      "customer_id integer references customers(id), amount numeric); insert into customers values (1, 'SECRET-ROW-VALUE');")
    con.close()
    big = ("The lending desk sanctions tractor loans. " * 2000).encode()
    files = [("files", ("lending.sqlite", open(path, "rb").read(), "application/octet-stream")),
             ("files", ("policy/credit-policy.txt", big, "text/plain")), ("files", ("policy/notes.md", b"Gift vouchers expire after 12 months.", "text/markdown")),
             ("files", ("photo.png", b"\x89PNG\r\n", "image/png")), ("files", ("empty.txt", b"", "text/plain"))]
    up = c.post(f"/api/ontologies/{oid}/sources", headers=H, files=files,
                data={"paths": json.dumps(["lending.sqlite", "policy/credit-policy.txt", "policy/notes.md", "photo.png", "empty.txt"])}).json()
    assert [s["kind"] for s in up["added"]] == ["schema", "document", "document"]
    assert {f["name"] for f in up["failed"]} == {"photo.png", "empty.txt"} and all(f["reason"] for f in up["failed"])
    assert "structure only, no rows read" in up["added"][0]["note"]
    assert "SECRET-ROW-VALUE" not in c.get(f"/api/ontologies/{oid}/sources/{up['added'][0]['id']}").json()["text"]
    n = len(fake_llm.REQUESTS)
    j = wait_job(c, c.post(f"/api/ontologies/{oid}/build", headers=H, json={"model_id": mid, "use_cases": 0}).json()["id"])
    assert j["status"] == "done", j
    assert j["result"]["sources"] == {"schemas": 1, "documents": 2, "skipped": [], "distilled": True}
    sent = json.dumps(fake_llm.REQUESTS[n:])
    assert "TABLE loans" in sent and "FK (customer_id) -> customers" in sent        # the schema reaches the model...
    assert "SECRET-ROW-VALUE" not in sent                                            # ...the rows never do
    assert "Gift voucher" in sent                                                     # findings distilled from the documents are used
    o = c.get(f"/api/ontologies/{oid}").json()
    assert o["domain"] == "Retail order management"                                   # inferred, since none was given
    assert next(k for k in o["content"]["classes"] if k["id"] == "Loan")["derived_from"] == "loans"
    # a wrong database connection fails with a readable message and stores nothing
    bad = c.post(f"/api/ontologies/{oid}/sources/database", headers=H, json={"db_type": "postgresql", "host": "127.0.0.1", "port": 1, "database": "x", "user": "u", "password": "hunter2-pw"})
    assert bad.status_code == 400 and "hunter2-pw" not in bad.text
    assert "hunter2-pw" not in json.dumps(c.get("/api/admin/audit?q=source").json())
    c.delete(f"/api/ontologies/{oid}", headers=H)


def test_folders_and_access_levels(admin):
    c, mid = admin
    ann = make_user(c, "ann@test.local", "ontologist")
    bob = make_user(c, "bob@test.local", "ontologist")
    vic = make_user(c, "vic@test.local", "viewer")
    fid = ann.post("/api/folders", headers=H, json={"name": "Lending"}).json()["id"]
    sub = ann.post("/api/folders", headers=H, json={"name": "Drafts", "parent_id": fid}).json()["id"]
    oid = ann.post("/api/ontologies", headers=H, json={"name": "Ann's loans", "domain": "Lending", "folder_id": sub}).json()["id"]
    ann.post(f"/api/ontologies/{oid}/edit", headers=H, json={"patch": {"classes": [{"id": "Loan", "definition": "Money lent to a borrower."}]}})
    names = lambda cl: {o["name"] for o in cl.get("/api/library").json()["ontologies"]}   # noqa: E731
    # private by default: nobody else sees it, by listing or by id
    assert "Ann's loans" not in names(bob) and "Ann's loans" not in names(vic)
    for path in (f"/api/ontologies/{oid}", f"/api/ontologies/{oid}/export/ttl", f"/api/ontologies/{oid}/diagram", f"/api/ontologies/{oid}/versions",
                 f"/api/ontologies/{oid}/sources", f"/api/ontologies/{oid}/tests"):
        assert bob.get(path).status_code == 404, path
    assert vic.post("/api/folders", headers=H, json={"name": "x"}).status_code == 403          # viewers cannot create
    assert vic.post("/api/ontologies", headers=H, json={"name": "x"}).status_code == 403
    assert bob.put(f"/api/folders/{fid}/access", headers=H, json={"everyone": "edit"}).status_code == 404   # not his folder
    users = {u["email"]: u["id"] for u in ann.get(f"/api/folders/{fid}/access").json()["users"]}
    # view access on the parent folder reaches the ontology in the sub-folder - read only
    ann.put(f"/api/folders/{fid}/access", headers=H, json={"grants": [{"user_id": users["bob@test.local"], "level": "view"}, {"user_id": users["vic@test.local"], "level": "edit"}]})
    assert bob.get(f"/api/ontologies/{oid}").json()["level"] == "view"
    assert bob.post(f"/api/ontologies/{oid}/edit", headers=H, json={"patch": {"classes": [{"id": "Hack"}]}}).status_code == 403
    assert bob.post(f"/api/ontologies/{oid}/run/refine", headers=H, json={"instruction": "add things"}).status_code == 403
    assert bob.delete(f"/api/ontologies/{oid}", headers=H).status_code == 403
    assert bob.get(f"/api/ontologies/{oid}/export/ttl").status_code == 200
    assert bob.post("/api/ontologies", headers=H, json={"name": "Sneak", "folder_id": sub}).status_code == 403
    # the Viewer role stays read-only even where a folder grants edit
    assert vic.get(f"/api/ontologies/{oid}").json()["level"] == "view"
    assert vic.post(f"/api/ontologies/{oid}/edit", headers=H, json={"patch": {"classes": [{"id": "Hack"}]}}).status_code == 403
    # edit access: may change the ontology, may not delete it, move it or change who sees it
    ann.put(f"/api/folders/{fid}/access", headers=H, json={"grants": [{"user_id": users["bob@test.local"], "level": "edit"}]})
    assert bob.post(f"/api/ontologies/{oid}/edit", headers=H, json={"patch": {"classes": [{"id": "Borrower", "definition": "The party that takes a loan."}]}}).status_code == 200
    assert bob.delete(f"/api/ontologies/{oid}", headers=H).status_code == 403
    cur = bob.get(f"/api/ontologies/{oid}").json()
    body = {"name": cur["name"], "domain": cur["domain"], "folder_id": cur["folder_id"]}
    assert bob.put(f"/api/ontologies/{oid}", headers=H, json={**body, "visibility": "shared"}).status_code == 403
    assert bob.put(f"/api/ontologies/{oid}", headers=H, json={**body, "folder_id": None}).status_code == 403
    assert vic.get(f"/api/ontologies/{oid}").status_code == 404                                 # his grant was replaced
    # revoked: gone again
    ann.put(f"/api/folders/{fid}/access", headers=H, json={"grants": []})
    assert bob.get(f"/api/ontologies/{oid}").status_code == 404
    # "shared" visibility: everyone can read
    assert ann.put(f"/api/ontologies/{oid}", headers=H, json={**body, "visibility": "shared"}).status_code == 200
    assert vic.get(f"/api/ontologies/{oid}").json()["level"] == "view"
    # folders: not deletable while they hold something; cannot be moved into themselves
    assert ann.delete(f"/api/folders/{sub}", headers=H).status_code == 400
    assert ann.put(f"/api/folders/{fid}", headers=H, json={"name": "Lending", "parent_id": sub}).status_code == 400
    assert c.get(f"/api/ontologies/{oid}").json()["level"] == "manage"                           # administrators see everything
    assert ann.delete(f"/api/ontologies/{oid}", headers=H).status_code == 200
    assert ann.delete(f"/api/folders/{sub}", headers=H).status_code == 200 and ann.delete(f"/api/folders/{fid}", headers=H).status_code == 200
    actions = {a["action"] for a in c.get("/api/admin/audit?q=Lending").json()["items"]}
    assert {"folder.created", "folder.access", "folder.deleted"} <= actions
    for email in ("ann@test.local", "bob@test.local", "vic@test.local"):
        uid = next(u["id"] for u in c.get("/api/admin/users").json() if u["email"] == email)
        c.delete(f"/api/admin/users/{uid}", headers=H)


def test_reasoner_finds_planted_contradictions(admin):
    c, _ = admin
    sample = next(o for o in c.get("/api/library").json()["ontologies"] if o["name"].startswith("Sample:"))
    ok = c.post(f"/api/ontologies/{sample['id']}/reason/owlrl", headers=H).json()
    assert ok["consistent"] and not ok["unsatisfiable"] and not ok["problems"] and ok["inferred"]["subclass"] >= 2
    raw = c.get(f"/api/ontologies/{sample['id']}/export/json").content
    oid = c.post("/api/ontologies/import", headers=H, files={"file": ("broken.json", raw, "application/json")}).json()["id"]
    # a kiosk that is both a store and an online channel, which rule R4 says never overlap
    c.post(f"/api/ontologies/{oid}/edit", headers=H, json={"patch": {
        "classes": [{"id": "Kiosk", "parent": "Store", "module": "Sales", "definition": "An unattended sales point."}],
        "rules": [{"id": "R9", "kind": "disjoint", "statement": "A party is never a sales channel.", "applies_to": ["Party", "SalesChannel"]}],
        "properties": [{"id": "operates", "kind": "object", "domain": "Party", "range": "Store", "inverse": "operatedBy"},
                       {"id": "operatedBy", "kind": "object", "domain": "Party", "range": "Party", "inverse": "operates"}]}})
    bad = c.post(f"/api/ontologies/{oid}/reason/owlrl", headers=H).json()
    text = " ".join(p["text"] for p in bad["problems"])
    assert "operatedBy" in text and "do not mirror" in text and "cannot hold between anything" in text
    assert c.get(f"/api/ontologies/{oid}").json()["reasoners"]["owlrl"]["available"]
    c.delete(f"/api/ontologies/{oid}", headers=H)


def test_import_turtle_round_trip(admin):
    c, _ = admin
    sample = next(o for o in c.get("/api/library").json()["ontologies"] if o["name"].startswith("Sample:"))
    ttl = c.get(f"/api/ontologies/{sample['id']}/export/ttl").content
    r = c.post("/api/ontologies/import", headers=H, files={"file": ("retail.ttl", ttl, "text/turtle")}).json()
    assert r["classes"] == 24 and r["properties"] == 57
    o = c.get(f"/api/ontologies/{r['id']}").json()
    assert next(k for k in o["content"]["classes"] if k["id"] == "Carrier")["parent"] == "Organization"
    assert c.post("/api/ontologies/import", headers=H, files={"file": ("x.ttl", b"this is not turtle <", "text/turtle")}).status_code == 400
    c.delete(f"/api/ontologies/{r['id']}", headers=H)


def test_gap_review_proposes_without_changing(built):
    c, mid, oid, _ = built
    v = c.get(f"/api/ontologies/{oid}").json()["version"]
    c.post(f"/api/ontologies/{oid}/edit", headers=H, json={"patch": {"remove_classes": ["GiftCard"]}})
    j = wait_job(c, c.post(f"/api/ontologies/{oid}/run/gaps", headers=H, json={"model_id": mid}).json()["id"])
    assert j["status"] == "done" and j["result"]["findings"] and "proposed" not in j["result"]
    assert [k["id"] for k in j["result"]["added"]["classes"]] == ["GiftCard"]
    o = c.get(f"/api/ontologies/{oid}").json()
    assert o["version"] == v + 1 and not any(k["id"] == "GiftCard" for k in o["content"]["classes"])     # nothing applied yet
    a = c.post(f"/api/ontologies/{oid}/gaps/{j['id']}/apply", headers=H)
    assert a.status_code == 200
    assert any(k["id"] == "GiftCard" for k in c.get(f"/api/ontologies/{oid}").json()["content"]["classes"])
    assert c.post(f"/api/ontologies/{oid}/gaps/{j['id']}/apply", headers=H).status_code == 400


def test_schema_upgrade_of_an_older_database():
    """New columns are added to an existing database at start-up (the owner keeps their data folder)."""
    from sqlalchemy import inspect, text
    from app.db import engine
    from app.main import upgrade_schema
    with engine.begin() as con:
        con.execute(text("ALTER TABLE ontologies DROP COLUMN material"))
    assert "material" not in {c["name"] for c in inspect(engine).get_columns("ontologies")}
    upgrade_schema()
    assert "material" in {c["name"] for c in inspect(engine).get_columns("ontologies")}


def test_usage_is_per_user_and_admin_sees_all(built):
    c, mid, oid, _ = built
    ann = make_user(c, "usage-ann@test.local", "ontologist")
    aid = ann.post("/api/ontologies", headers=H, json={"name": "Ann usage", "domain": "Retail"}).json()["id"]
    wait_job(ann, ann.post(f"/api/ontologies/{aid}/build", headers=H, json={"model_id": mid, "use_cases": 0}).json()["id"])
    mine = ann.get("/api/usage?days=7").json()
    assert mine["totals"]["jobs"] == 1 and mine["totals"]["calls"] == 5 and mine["totals"]["cost"] > 0
    assert mine["by_user"] == [] and mine["users"] == [] and not mine["is_admin"]
    assert {j["user"] for j in mine["recent"]} == {"usage-ann@test.local"}
    admin_id = next(u["id"] for u in c.get("/api/admin/users").json() if u["email"] == "admin@test.local")
    # asking for somebody else's usage is ignored for a non-admin
    assert ann.get(f"/api/usage?days=7&user_id={admin_id}").json()["totals"]["jobs"] == 1
    assert "admin@test.local" not in ann.get("/api/usage.csv?days=7").text
    everyone = c.get("/api/usage?days=7").json()
    assert everyone["totals"]["jobs"] > 1 and {"usage-ann@test.local", "admin@test.local"} <= {u["key"] for u in everyone["by_user"]}
    ann_id = next(u["id"] for u in everyone["users"] if u["email"] == "usage-ann@test.local")
    only = c.get(f"/api/usage?days=7&user_id={ann_id}").json()
    assert only["totals"]["jobs"] == 1 and len(only["by_day"]) == 7 and only["by_day"][-1]["jobs"] == 1
    assert c.get(f"/api/usage?days=7&kind=test").json()["totals"]["jobs"] == sum(k["jobs"] for k in everyone["by_kind"] if k["key"] == "test")
    ann.delete(f"/api/ontologies/{aid}", headers=H)
    c.delete(f"/api/admin/users/{ann_id}", headers=H)


def test_excel_workbook_and_appearance(built):
    c, _, oid, _ = built
    import openpyxl
    assert c.put("/api/admin/settings", headers=H, json={"accent": "pink"}).status_code == 400
    assert c.put("/api/admin/settings", headers=H, json={"accent": "teal", "app_title": "Acme Hub", "footer_text": "Confidential"}).status_code == 200
    from fastapi.testclient import TestClient
    from app.main import app
    b = TestClient(app).get("/api/auth/branding").json()          # public: needed by the sign-in page
    assert b["app_name"] == "Acme Hub" and b["accent_light"] == "#0e7c86"
    r = c.get(f"/api/ontologies/{oid}/export/xlsx")
    wb = openpyxl.load_workbook(io.BytesIO(r.content))
    assert wb.sheetnames == ["Overview", "Modules", "Classes", "Relationships", "Attributes", "Controlled values", "Rules", "Standards",
                             "Use cases", "Quality", "Test results"]
    classes = [row[0].value for row in wb["Classes"].iter_rows(min_row=5)]
    assert "Order" in classes and "Gift card" in classes
    rel = [[x.value for x in row[:3]] for row in wb["Relationships"].iter_rows(min_row=5)]
    assert ["Order", "placed by", "Customer"] in rel
    assert any("Warranty" in str(row[0].value) for row in wb["Test results"].iter_rows(min_row=5))
    assert wb["Classes"].oddFooter.center.text == "Confidential"
    assert "What it is" in [row[0].value for row in wb["Overview"].iter_rows()]
    c.put("/api/admin/settings", headers=H, json={"accent": "blue", "app_title": "", "footer_text": ""})


def test_claude_code_path_against_a_stand_in(admin, fake_llm):
    """The Anthropic SDK path (streaming, effort, token accounting) against an Anthropic-shaped stand-in server."""
    from tests.conftest import FAKE_PORT
    c, _ = admin
    m = c.post("/api/admin/models", headers=H, json={"name": "Claude stand-in", "provider": "anthropic", "model_id": "claude-opus-5-5", "api_key": "sk-ant-test",
                                                    "base_url": f"http://127.0.0.1:{FAKE_PORT}", "effort": "high", "price_in": 4, "price_out": 20}).json()
    assert c.post(f"/api/admin/models/{m['id']}/test", headers=H).json()["ok"] is True
    oid = c.post("/api/ontologies", headers=H, json={"name": "Via Claude path", "domain": "Retail"}).json()["id"]
    n = len(fake_llm.REQUESTS)
    j = wait_job(c, c.post(f"/api/ontologies/{oid}/build", headers=H, json={"model_id": m["id"], "use_cases": 2}).json()["id"])
    assert j["status"] == "done", j
    assert j["calls"] == 6 and j["input_tokens"] == 720 and j["output_tokens"] > 1000 and j["cost"] > 0
    req = fake_llm.REQUESTS[n]
    assert req["stream"] is True and req["output_config"] == {"effort": "high"} and req["max_tokens"] == 64000 and "temperature" not in req
    c.delete(f"/api/ontologies/{oid}", headers=H)
    c.delete(f"/api/admin/models/{m['id']}", headers=H)


def test_every_library_ontology_is_sound():
    """Each pre-built ontology parses without losing anything, scores well, exports to valid Turtle and is logically consistent."""
    from app import exports, library, onto, reasoner
    library.load.cache_clear()
    items = library.load()
    assert len(items) >= 22 and len({i["industry"] for i in items.values()}) >= 18
    for tid, item in items.items():
        c = item["content"]
        st = onto.stats(c)
        assert st["classes"] >= 18 and st["object_properties"] >= 15 and st["data_properties"] >= 25, (tid, st)
        assert st["use_cases"] >= 3 and st["rules"] >= 4 and st["standards"] >= 3 and st["modules"] >= 4, (tid, st)
        q = onto.quality(c)
        assert q["score"] >= 93 and not [f for f in q["findings"] if f["severity"] == "high"], (tid, q["score"], [f["title"] for f in q["findings"]])
        assert all(u["classes"] and u["properties"] for u in c["use_cases"]), tid
        assert all(s["in_catalogue"] for s in c["standards"]), tid
        g = Graph().parse(data=exports.export(c, "ttl")[0], format="turtle")
        assert len(g) > 400, tid
        r = reasoner.run(c, "owlrl")
        assert r["consistent"] and not r["problems"] and not r["unsatisfiable"], (tid, r["problems"])


def test_library_file_errors_are_reported_not_fatal():
    from app import library
    for bad, msg in (("id: x\nname: X\nindustry: I\ndomain: d\nsummary: s\n== M | M | m\nA | A thing that exists.\n  > points to > Nowhere *", "unknown class"),
                     ("id: x\nname: X\nindustry: I\ndomain: d\nsummary: s\nA | orphan", "needs a module"),
                     ("id: x\nname: X\nindustry: I\ndomain: d\nsummary: s\nstd: nope | high | x | y", "not in the standards catalogue")):
        with pytest.raises(library.LibraryError, match=msg):
            library.parse(bad, "bad.onto")


def test_use_a_library_ontology_and_duplicate(admin, fake_llm):
    c, mid = admin
    lst = c.get("/api/templates").json()
    assert {"lending", "healthcare", "retail"} <= {t["id"] for t in lst["items"]} and "Insurance" in lst["industries"]
    t = c.get("/api/templates/lending").json()
    assert t["stats"]["classes"] >= 40 and any(k["id"] == "LoanApplication" for k in t["content"]["classes"])
    assert c.get("/api/templates/lending/diagram").json()["nodes"] and c.get("/api/templates/nope").status_code == 404
    # copy it - with an AI instruction, a refine job tailors the copy at once
    r = c.post("/api/templates/lending/use", headers=H, json={"name": "My tractor loans", "instruction": "Add a loyalty programme", "model_id": mid}).json()
    j = wait_job(c, r["job"]["id"])
    assert j["status"] == "done" and j["result"]["added"] == 1, j      # the class is added; its link to a retail-only class is dropped
    o = c.get(f"/api/ontologies/{r['id']}").json()
    assert o["version"] == 2 and any(k["id"] == "LoyaltyProgram" for k in o["content"]["classes"])
    assert o["name"] == "My tractor loans" and o["based_on"] == "Pre-built library: Lending and loan origination" and o["status"] == "ready"
    assert o["content"]["meta"]["namespace"].endswith("my-tractor-loans#") and o["visibility"] == "private" and o["level"] == "manage"
    assert len(o["content"]["classes"]) >= 42
    # the copy is independent: editing it does not touch the library
    c.post(f"/api/ontologies/{r['id']}/edit", headers=H, json={"patch": {"remove_classes": ["Guarantor"]}})
    assert any(k["id"] == "Guarantor" for k in c.get("/api/templates/lending").json()["content"]["classes"])
    plain = c.post("/api/templates/healthcare/use", headers=H, json={"name": "Clinic model"}).json()
    assert plain["job"] is None and c.get(f"/api/ontologies/{plain['id']}").json()["version"] == 1
    # roles: a viewer can browse the library but not copy; duplicating needs sight of the original
    vic = make_user(c, "lib-vic@test.local", "viewer")
    ann = make_user(c, "lib-ann@test.local", "ontologist")
    assert vic.get("/api/templates").status_code == 200 and vic.get("/api/templates/lending").status_code == 200
    assert vic.post("/api/templates/lending/use", headers=H, json={"name": "x"}).status_code == 403
    assert ann.post(f"/api/ontologies/{plain['id']}/duplicate", headers=H, json={"name": "Stolen"}).status_code == 404      # private to admin
    sample = next(x for x in c.get("/api/library").json()["ontologies"] if x["name"].startswith("Sample:"))
    assert vic.post(f"/api/ontologies/{sample['id']}/duplicate", headers=H, json={"name": "x"}).status_code == 403
    d = ann.post(f"/api/ontologies/{sample['id']}/duplicate", headers=H, json={"name": "Ann's retail"})
    assert d.status_code == 200
    mine = ann.get(f"/api/ontologies/{d.json()['id']}").json()
    assert mine["level"] == "manage" and mine["visibility"] == "private" and mine["based_on"].startswith("Copy of Sample:")
    assert len(mine["content"]["classes"]) == len(c.get(f"/api/ontologies/{sample['id']}").json()["content"]["classes"])
    assert ann.post(f"/api/ontologies/{d.json()['id']}/edit", headers=H, json={"patch": {"classes": [{"id": "Voucher", "definition": "A discount voucher."}]}}).status_code == 200
    assert not any(k["id"] == "Voucher" for k in c.get(f"/api/ontologies/{sample['id']}").json()["content"]["classes"])
    for oid in (r["id"], plain["id"]):
        c.delete(f"/api/ontologies/{oid}", headers=H)
    ann.delete(f"/api/ontologies/{d.json()['id']}", headers=H)
    for email in ("lib-vic@test.local", "lib-ann@test.local"):
        c.delete(f"/api/admin/users/{next(u['id'] for u in c.get('/api/admin/users').json() if u['email'] == email)}", headers=H)
