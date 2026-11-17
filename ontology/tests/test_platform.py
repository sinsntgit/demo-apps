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
    items = {i["id"]: i for i in t["items"]}
    assert set(items) == {"add:classes:Warranty", "add:properties:coveredBy"} and items["add:properties:coveredBy"]["needs"] == ["add:classes:Warranty"]
    # choosing only the relationship brings the class it needs along
    a = c.post(f"/api/ontologies/{oid}/changes/apply", headers=H, json={"source": "test", "ref": t["id"], "items": ["add:properties:coveredBy"]}).json()
    assert a["added"] == 2 and a["applied"] == 2
    # "Test again" re-checks the SAME requirements, so the two scores compare
    r2 = c.post(f"/api/ontologies/{oid}/tests", headers=H, json={"text": "ignored on a re-test", "model_id": mid, "baseline_id": t["id"]}).json()
    wait_job(c, r2["job"]["id"])
    t2 = c.get(f"/api/ontologies/{oid}/tests/{r2['test']['id']}").json()
    assert t2["text"] == t["text"] and t2["version"] == a["version"]
    assert [x["text"] for x in t2["result"]["requirements"]] == [x["text"] for x in res["requirements"]]
    assert t2["score"] == 1.0 and t2["result"]["compare"] == {"baseline_id": t["id"], "previous_score": 0.25, "previous_version": t["version"], "improved": 3, "worse": 0}
    assert [x["before"] for x in t2["result"]["requirements"]] == ["covered", "missing", "missing", "missing"]
    assert t2["items"] == []                                          # nothing left to propose
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
    assert j["result"]["sources"] == {"schemas": 1, "documents": 2, "skipped": [], "distilled": True, "data_sources": 0, "tables": 0}
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


def test_gap_review_proposes_items_and_applies_only_the_chosen(built):
    c, mid, oid, _ = built
    v = c.get(f"/api/ontologies/{oid}").json()["version"]
    c.post(f"/api/ontologies/{oid}/edit", headers=H, json={"patch": {"remove_classes": ["GiftCard"]}})
    j = wait_job(c, c.post(f"/api/ontologies/{oid}/run/gaps", headers=H, json={"model_id": mid}).json()["id"])
    assert j["status"] == "done" and j["result"]["findings"] and "proposed" not in j["result"]
    rv = c.get(f"/api/ontologies/{oid}/review/gaps").json()
    items = {i["id"]: i for i in rv["items"]}
    assert {"add:classes:GiftCard", "add:properties:redeems", "add:properties:cardBalance"} <= set(items) and not rv["stale"]
    assert items["add:classes:GiftCard"]["reason"] == "Gift cards are a payment means the scope mentions."
    assert items["add:properties:redeems"]["needs"] == ["add:classes:GiftCard"]
    o = c.get(f"/api/ontologies/{oid}").json()
    assert o["version"] == v + 1 and not any(k["id"] == "GiftCard" for k in o["content"]["classes"])     # nothing applied yet
    assert c.post(f"/api/ontologies/{oid}/changes/apply", headers=H, json={"source": "review", "ref": j["id"], "items": ["nope"]}).status_code == 409
    a = c.post(f"/api/ontologies/{oid}/changes/apply", headers=H, json={"source": "review", "ref": j["id"], "items": ["add:classes:GiftCard"]}).json()
    o = c.get(f"/api/ontologies/{oid}").json()
    assert a["applied"] == 1 and any(k["id"] == "GiftCard" for k in o["content"]["classes"]) and not any(p["id"] == "redeems" for p in o["content"]["properties"])
    left = c.get(f"/api/ontologies/{oid}/review/gaps").json()       # what was not chosen is still on offer, against the new version
    assert not left["stale"] and "add:classes:GiftCard" not in {i["id"] for i in left["items"]} and "add:properties:redeems" in {i["id"] for i in left["items"]}


def test_reasoner_fixes_and_ai_fix_proposals(admin):
    c, mid = admin
    sample = next(o for o in c.get("/api/library").json()["ontologies"] if o["name"].startswith("Sample:"))
    oid = c.post(f"/api/ontologies/{sample['id']}/duplicate", headers=H, json={"name": "Fix me"}).json()["id"]
    c.post(f"/api/ontologies/{oid}/edit", headers=H, json={"patch": {
        "rules": [{"id": "R9", "kind": "disjoint", "statement": "A store is never a sales channel.", "applies_to": ["Store", "SalesChannel"]}],
        "properties": [{"id": "operates", "kind": "object", "domain": "Party", "range": "Store", "inverse": "operatedBy", "definition": "x"},
                       {"id": "operatedBy", "kind": "object", "domain": "Party", "range": "Party", "inverse": "operates", "definition": "y"}]}})
    r = c.post(f"/api/ontologies/{oid}/reason/owlrl", headers=H).json()
    assert r["problems"] and {f["group"] for f in r["fixes"]} == {"inv:operatedBy:operates", "disj:R9:Store"}
    rec = [f for f in r["fixes"] if f["recommended"]]
    assert len(rec) == 2 and any(f["id"].endswith(":mirror:operatedBy") for f in rec)      # keep the more specific "operates -> Store"
    alts = [f["id"] for f in r["fixes"] if f["group"] == "disj:R9:Store"]
    bad = c.post(f"/api/ontologies/{oid}/changes/apply", headers=H, json={"source": "reasoner", "items": alts})
    assert bad.status_code == 400 and "alternatives" in bad.json()["detail"]
    ok = c.post(f"/api/ontologies/{oid}/changes/apply", headers=H, json={"source": "reasoner", "items": [f["id"] for f in rec]}).json()
    assert ok["applied"] == 2
    again = c.post(f"/api/ontologies/{oid}/reason/owlrl", headers=H).json()
    assert again["consistent"] and not again["problems"] and not again["fixes"]
    o = c.get(f"/api/ontologies/{oid}").json()
    assert next(p for p in o["content"]["properties"] if p["id"] == "operates")["range"] == "Store"
    # AI proposals for what the reasoner and the checks found: itemised with reasons, nothing applied until chosen
    j = wait_job(c, c.post(f"/api/ontologies/{oid}/run/fix", headers=H, json={"model_id": mid}).json()["id"])
    assert j["status"] == "done", j
    rv = c.get(f"/api/ontologies/{oid}/review/fix").json()
    items = {i["id"]: i for i in rv["items"]}
    assert set(items) >= {"add:properties:brandName", "modify:classes:Brand", "add:rules:R10", "delete:properties:appliedPromotion"}
    assert items["delete:properties:appliedPromotion"]["reason"] == "Promotions are out of scope for this test."
    assert "definition:" in items["modify:classes:Brand"]["details"] and items["add:rules:R10"]["kind"] == "rule"
    assert c.get(f"/api/ontologies/{oid}").json()["version"] == o["version"]
    a = c.post(f"/api/ontologies/{oid}/changes/apply", headers=H, json={"source": "review", "ref": j["id"],
                                                                         "items": ["add:rules:R10", "modify:classes:Brand"]}).json()
    o2 = c.get(f"/api/ontologies/{oid}").json()
    assert a["applied"] == 2 and any(x["id"] == "R10" for x in o2["content"]["rules"])
    assert any(p["id"] == "appliedPromotion" for p in o2["content"]["properties"])            # not chosen, not deleted
    assert next(k for k in o2["content"]["classes"] if k["id"] == "Brand")["definition"].endswith("to customers.")
    vic = make_user(c, "fix-vic@test.local", "viewer")
    assert vic.post(f"/api/ontologies/{oid}/changes/apply", headers=H, json={"source": "reasoner"}).status_code == 404
    c.delete(f"/api/ontologies/{oid}", headers=H)
    c.delete(f"/api/admin/users/{next(u['id'] for u in c.get('/api/admin/users').json() if u['email'] == 'fix-vic@test.local')}", headers=H)


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


def test_diagram_collapse_and_attribute_toggle(admin):
    c, _ = admin
    sample = next(o for o in c.get("/api/library").json()["ontologies"] if o["name"].startswith("Sample:"))
    full = c.get(f"/api/ontologies/{sample['id']}/diagram").json()
    party = next(n for n in full["nodes"] if n["id"] == "Party")
    assert party["kids"] == 3 and party["collapsed"] is False
    folded = c.get(f"/api/ontologies/{sample['id']}/diagram?collapsed=Party,SalesChannel,Nope").json()
    ids = {n["id"] for n in folded["nodes"]}
    assert "Person" not in ids and "Retailer" not in ids and "Store" not in ids and "Party" in ids
    p = next(n for n in folded["nodes"] if n["id"] == "Party")
    assert p["collapsed"] is True and p["sub"] == "+5 more" and len(folded["nodes"]) == len(full["nodes"]) - 7
    with_attrs = c.get(f"/api/ontologies/{sample['id']}/diagram?view=class&cls=Order").json()
    without = c.get(f"/api/ontologies/{sample['id']}/diagram?view=class&cls=Order&attrs=0").json()
    assert any(n["attrs"] for n in with_attrs["nodes"]) and not any(n["attrs"] for n in without["nodes"])
    t = c.get("/api/templates/lending/diagram?collapsed=Party").json()
    assert next(n for n in t["nodes"] if n["id"] == "Party")["collapsed"] is True


def test_hermit_steps_down_when_java_cannot_reserve_memory(monkeypatch):
    """Windows with a 32-bit Java cannot reserve owlready2's default 2000 MB; the run must step down, not fail."""
    import owlready2
    import owlready2.reasoning
    from app import reasoner, sample
    if not reasoner.engines()["hermit"]["available"]:
        pytest.skip("Java is not installed here")
    tried, real = [], owlready2.sync_reasoner_hermit

    def fake(world, **kw):
        tried.append(owlready2.reasoning.JAVA_MEMORY)
        if owlready2.reasoning.JAVA_MEMORY > 256:
            raise owlready2.OwlReadyJavaError("Java error message is:\nError occurred during initialization of VM\n"
                                              "Could not reserve enough space for 2048000KB object heap")
        return real(world, **kw)
    monkeypatch.setattr(owlready2, "sync_reasoner_hermit", fake)
    r = reasoner.run(sample.content(), "hermit")
    assert tried == [1024, 512, 256] and r["error"] == "" and r["consistent"]
    assert any("ran with 256 MB" in n for n in r["notes"])

    def never(world, **kw):
        raise owlready2.OwlReadyJavaError("Error occurred during initialization of VM Could not reserve enough space for 262144KB object heap")
    monkeypatch.setattr(owlready2, "sync_reasoner_hermit", never)
    r = reasoner.run(sample.content(), "hermit")
    assert "64-bit Java" in r["error"]


def _lending_db(path):
    import random
    con = sqlite3.connect(path)
    con.executescript("""create table customers(id integer primary key, full_name text not null, email text, region text);
        create table loans(id integer primary key, customer_id integer references customers(id), amount numeric, status text, applied_on date);
        create table etl_log(id integer primary key, run_at text, message text);""")
    random.seed(7)
    for i in range(1, 201):
        con.execute("insert into customers values (?,?,?,?)", (i, f"SECRET-NAME-{i}", f"secret{i}@mail.example", random.choice(["North", "South"])))
    for i in range(1, 601):
        con.execute("insert into loans values (?,?,?,?,?)", (i, random.randint(1, 200), random.randint(50000, 900000),
                                                             random.choice(["Approved", "Rejected", "Pending"]), f"2025-0{random.randint(1, 9)}-1{random.randint(0, 9)}"))
    con.execute("insert into etl_log values (1, '2025-01-01', 'loaded')")
    con.commit(); con.close()


def test_data_source_library_profiles_and_builds(admin, fake_llm):
    c, mid = admin
    path = tempfile.mktemp(suffix=".db")
    _lending_db(path)
    # a data source of uploaded files: a SQLite database, two CSVs that join, a document, and a file that cannot be read
    ds = c.post("/api/datasources", headers=H, json={"name": "Lending files", "kind": "files", "description": "Tractor lending data"}).json()
    dealers = b"id,name,region\n" + b"".join(f"{i},Dealer {i},{'N' if i % 2 else 'S'}\n".encode() for i in range(1, 41))
    apps = b"app_no;dealer_id;amount;stage\n" + b"".join(f"A{i};{i % 40 + 1};{1000 * i};{['open', 'closed'][i % 2]}\n".encode() for i in range(1, 201))
    up = c.post(f"/api/datasources/{ds['id']}/files", headers=H, files=[
        ("files", ("lending.sqlite", open(path, "rb").read(), "application/octet-stream")), ("files", ("dealers.csv", dealers, "text/csv")),
        ("files", ("applications.csv", apps, "text/csv")), ("files", ("policy/credit.md", b"# Credit policy\nEvery loan needs a sanction.", "text/markdown")),
        ("files", ("photo.png", b"\x89PNG", "image/png"))]).json()
    assert {a["name"]: a["kind"] for a in up["added"]} == {"lending.sqlite": "dataset", "dealers.csv": "dataset", "applications.csv": "dataset", "policy/credit.md": "document"}
    assert [f["name"] for f in up["failed"]] == ["photo.png"]
    d = c.get(f"/api/datasources/{ds['id']}").json()
    tables = {i["name"]: i for i in d["items"] if i["kind"] == "table"}
    assert set(tables) == {"customers", "loans", "etl_log", "dealers", "applications"} and d["documents"] == 1
    assert tables["etl_log"]["include"] is False                       # technical tables are left out by default
    cols = {x["name"]: x for x in tables["loans"]["profile"]["columns"]}
    assert cols["customer_id"]["ref"] == "customers.id" and cols["status"]["role"] == "code" and {v for v, _ in cols["status"]["top"]} == {"Approved", "Rejected", "Pending"}
    assert cols["amount"]["role"] == "measure" and cols["applied_on"]["role"] == "date"
    pers = {x["name"]: x for x in tables["customers"]["profile"]["columns"]}
    assert pers["email"]["personal"] and pers["email"]["examples"] == [] and pers["full_name"]["personal"]
    acols = {x["name"]: x for x in tables["applications"]["profile"]["columns"]}
    assert acols["dealer_id"]["ref"] == "dealers.id"                   # inferred across two separately uploaded files
    # people describe tables and columns; that becomes part of what the model reads
    c.put(f"/api/datasources/{ds['id']}/items/{tables['loans']['id']}", headers=H, json={"description": "Loans booked after sanction",
                                                                                        "columns": {"status": "Credit decision on the application"}})
    # build an ontology from scratch from the data source alone
    oid = c.post("/api/ontologies", headers=H, json={"name": "From the library"}).json()["id"]
    assert c.post(f"/api/ontologies/{oid}/build", headers=H, json={"model_id": mid}).status_code == 400       # nothing to build from yet
    c.post(f"/api/ontologies/{oid}/datasources", headers=H, json={"data_source_id": ds["id"]})
    n = len(fake_llm.REQUESTS)
    j = wait_job(c, c.post(f"/api/ontologies/{oid}/build", headers=H, json={"model_id": mid, "use_cases": 0}).json()["id"])
    assert j["status"] == "done", j
    assert j["result"]["sources"]["data_sources"] == 1 and j["result"]["sources"]["tables"] == 4
    sent = json.dumps(fake_llm.REQUESTS[n:])
    assert "TABLE loans" in sent and "Loans booked after sanction" in sent and "Credit decision on the application" in sent
    assert "Approved (" in sent and "-> customers.id" in sent and "-> dealers.id (inferred)" in sent and "Every loan needs a sanction" in sent
    assert "SECRET-NAME" not in sent and "secret1@mail" not in sent and "etl_log" not in sent
    assert next(k for k in c.get(f"/api/ontologies/{oid}").json()["content"]["classes"] if k["id"] == "Loan")["derived_from"] == "loans"
    # statistics only: no values at all reach the model
    s = c.get(f"/api/datasources/{ds['id']}").json()
    c.put(f"/api/datasources/{ds['id']}", headers=H, json={"name": s["name"], "description": s["description"], "kind": "files", "sample_values": False})
    n = len(fake_llm.REQUESTS)
    wait_job(c, c.post(f"/api/ontologies/{oid}/build", headers=H, json={"model_id": mid, "use_cases": 0}).json()["id"])
    sent = json.dumps(fake_llm.REQUESTS[n:])
    assert "TABLE loans" in sent and "Approved (" not in sent and "statistics only" in sent
    c.delete(f"/api/ontologies/{oid}", headers=H)
    c.delete(f"/api/datasources/{ds['id']}", headers=H)


def test_database_data_source_and_access(admin):
    c, _ = admin
    path = tempfile.mktemp(suffix=".db")
    _lending_db(path)
    from app import datasources as dsrc, sources as srcmod
    real = srcmod.db_url
    srcmod.db_url = lambda *a, **k: f"sqlite:///{path}"                # a live-database data source, pointed at a local file
    try:
        r = c.post("/api/datasources", headers=H, json={"name": "Core lending DB", "kind": "database", "db_type": "postgresql", "host": "db.internal",
                                                        "database": "lending", "user": "reader", "password": "hunter2-secret"})
        assert r.status_code == 200, r.text
        ds = r.json()
        assert ds["tables"] == 3 and ds["connection"]["has_password"] and "password" not in ds["connection"]
        assert "hunter2-secret" not in json.dumps(c.get(f"/api/datasources/{ds['id']}").json())
        assert "hunter2-secret" not in json.dumps(c.get("/api/admin/audit?q=lending").json())
        con = sqlite3.connect(path); con.execute("create table dealers(id integer primary key, name text)"); con.commit(); con.close()
        assert c.post(f"/api/datasources/{ds['id']}/refresh", headers=H).json()["tables"] == 4        # re-read with the stored password
        # access: private to its owner; shared or granted to use; viewers never
        ann = make_user(c, "ds-ann@test.local", "ontologist")
        vic = make_user(c, "ds-vic@test.local", "viewer")
        assert ann.get(f"/api/datasources/{ds['id']}").status_code == 404 and ds["id"] not in [x["id"] for x in ann.get("/api/datasources").json()["items"]]
        oid = ann.post("/api/ontologies", headers=H, json={"name": "Ann's"}).json()["id"]
        assert ann.post(f"/api/ontologies/{oid}/datasources", headers=H, json={"data_source_id": ds["id"]}).status_code == 404
        uid = next(u["id"] for u in c.get(f"/api/datasources/{ds['id']}/access").json()["users"] if u["email"] == "ds-ann@test.local")
        c.put(f"/api/datasources/{ds['id']}/access", headers=H, json={"visibility": "private", "users": [uid]})
        assert ann.get(f"/api/datasources/{ds['id']}").json()["level"] == "use"
        assert ann.post(f"/api/datasources/{ds['id']}/refresh", headers=H).status_code == 403          # use, not manage
        assert ann.post(f"/api/ontologies/{oid}/datasources", headers=H, json={"data_source_id": ds["id"]}).status_code == 200
        c.put(f"/api/datasources/{ds['id']}/access", headers=H, json={"visibility": "shared", "users": []})
        assert vic.get(f"/api/datasources/{ds['id']}").status_code == 404 and vic.get("/api/datasources").json()["can_create"] is False
        c.put(f"/api/datasources/{ds['id']}/access", headers=H, json={"visibility": "private", "users": []})
        b = ann.post(f"/api/ontologies/{oid}/build", headers=H, json={})    # access withdrawn: the build refuses, naming the source
        assert b.status_code == 403 and "Core lending DB" in b.json()["detail"]
        ann.delete(f"/api/ontologies/{oid}", headers=H)
        for email in ("ds-ann@test.local", "ds-vic@test.local"):
            c.delete(f"/api/admin/users/{next(u['id'] for u in c.get('/api/admin/users').json() if u['email'] == email)}", headers=H)
        c.delete(f"/api/datasources/{ds['id']}", headers=H)
    finally:
        srcmod.db_url = real


def test_every_database_driver_gets_settings_it_accepts():
    """SQL Server once failed with "unexpected keyword argument 'connect_timeout'": each driver names its timeout differently."""
    import importlib.util
    from app import profiling, sources
    assert set(sources.DB_TYPES) == {"postgresql", "mysql", "singlestore", "mssql", "oracle", "snowflake"}
    mods = {"postgresql": "psycopg2", "mysql": "pymysql", "singlestore": "pymysql", "mssql": "pymssql", "oracle": "oracledb"}
    tried = 0
    for typ, mod in mods.items():
        if importlib.util.find_spec(mod) is None:
            continue
        tried += 1
        with pytest.raises(profiling.ProfileError) as e:            # nothing listens on port 1: a connection error, not a settings error
            profiling.profile_database(sources.db_url(typ, "127.0.0.1", 1, "x", "u", "p"))
        assert "unexpected keyword" not in str(e.value) and "Could not read the database" in str(e.value), (typ, str(e.value))
    if tried == 0:
        pytest.skip("no database drivers installed here")
    url = sources.db_url("snowflake", "orgname-acct", None, "SALES", "u", "p@ss", {"warehouse": "COMPUTE_WH", "role": "ANALYST", "schema": "PUBLIC"})
    assert url == "snowflake://u:p%40ss@orgname-acct/SALES/PUBLIC?role=ANALYST&warehouse=COMPUTE_WH"
    assert sources.connect_args("mssql+pymssql://x") == {"login_timeout": 10} and "connect_timeout" not in sources.connect_args("oracle+oracledb://x")
    assert sources.db_url("singlestore", "h", None, "d", "u", "p").startswith("mysql+pymysql://u:p@h:3306/d")


def test_data_source_documentation_and_ai_descriptions(admin, fake_llm):
    c, mid = admin
    path = tempfile.mktemp(suffix=".db")
    _lending_db(path)
    ds = c.post("/api/datasources", headers=H, json={"name": "Documented", "kind": "files",
                                                    "documentation": "Status codes: Approved means the credit desk sanctioned the loan."}).json()
    assert c.get(f"/api/datasources/{ds['id']}").json()["documentation"].startswith("Status codes")
    up = c.post(f"/api/datasources/{ds['id']}/files", headers=H, files=[("files", ("lending.sqlite", open(path, "rb").read(), "application/octet-stream")),
                                                                         ("files", ("dictionary.md", b"# Data dictionary\nregion: sales region of the branch.", "text/markdown"))]).json()
    assert len(up["added"]) == 2
    d = c.get(f"/api/datasources/{ds['id']}").json()
    loans = next(i for i in d["items"] if i["name"] == "loans")
    c.put(f"/api/datasources/{ds['id']}/items/{loans['id']}", headers=H, json={"description": "Written by a person.", "columns": {"status": "Person's words."}})
    # AI drafts descriptions from the documentation; it never replaces what people wrote
    n = len(fake_llm.REQUESTS)
    r = c.post(f"/api/datasources/{ds['id']}/describe", headers=H, json={"model_id": mid}).json()
    j = wait_job(c, r["id"])
    assert j["status"] == "done", j
    sent = json.dumps(fake_llm.REQUESTS[n:])
    assert "Approved means the credit desk" in sent and "sales region of the branch" in sent and "TABLE customers" in sent
    d = c.get(f"/api/datasources/{ds['id']}").json()
    assert d["job"]["result"]["questions"] and d["job"]["result"]["glossary"][0]["term"] == "Sanction"
    items = {i["name"]: i for i in d["items"]}
    assert items["loans"]["description"] == "Written by a person." and not items["loans"]["ai"]
    assert items["customers"]["description"].startswith("Drafted") and items["customers"]["ai"]
    cols = {x["name"]: x for x in items["loans"]["profile"]["columns"]}
    assert cols["status"]["description"] == "Person's words." and not cols["status"].get("ai")
    assert cols["amount"]["description"].startswith("Drafted") and cols["amount"]["ai"]
    # confirming a draft (saving it) makes it the person's
    c.put(f"/api/datasources/{ds['id']}/items/{items['customers']['id']}", headers=H, json={"description": "Customers of the lender."})
    assert not next(i for i in c.get(f"/api/datasources/{ds['id']}").json()["items"] if i["name"] == "customers")["ai"]
    # a database data source takes documentation files, but not datasets
    srcmod = __import__("app.sources", fromlist=["x"])
    real = srcmod.db_url
    srcmod.db_url = lambda *a, **k: f"sqlite:///{path}"
    try:
        dbs = c.post("/api/datasources", headers=H, json={"name": "Documented DB", "kind": "database", "db_type": "mssql", "host": "h", "database": "d"}).json()
    finally:
        srcmod.db_url = real
    up = c.post(f"/api/datasources/{dbs['id']}/files", headers=H, files=[("files", ("manual.txt", b"The loans table holds sanctioned loans.", "text/plain")),
                                                                          ("files", ("extra.csv", b"a,b\n1,2\n3,4\n", "text/csv"))]).json()
    assert [a["name"] for a in up["added"]] == ["manual.txt"] and "Datasets belong" in up["failed"][0]["reason"]
    c.put(f"/api/datasources/{dbs['id']}/documentation", headers=H, json={"documentation": "Owned by the credit team."})
    assert c.get(f"/api/datasources/{dbs['id']}").json()["documentation"] == "Owned by the credit team."
    for x in (ds["id"], dbs["id"]):
        c.delete(f"/api/datasources/{x}", headers=H)


def test_cost_is_captured_or_flagged(admin, fake_llm):
    from tests.conftest import FAKE_PORT
    c, _ = admin
    base = f"http://127.0.0.1:{FAKE_PORT}/v1"
    made = []
    for name, mid_, pin, pout in (("Unpriced", "fake-unpriced", 0, 0), ("No usage", "no-usage", 1, 2), ("New names", "new-usage-names", 1, 2)):
        made.append(c.post("/api/admin/models", headers=H, json={"name": name, "provider": "openai", "model_id": mid_, "base_url": base, "api_key": "k",
                                                               "price_in": pin, "price_out": pout}).json())
    oid = c.post("/api/ontologies", headers=H, json={"name": "Costs", "domain": "Retail"}).json()["id"]
    jobs = {}
    for m in made:
        jobs[m["name"]] = wait_job(c, c.post(f"/api/ontologies/{oid}/build", headers=H, json={"model_id": m["id"], "use_cases": 0}).json()["id"])
    assert all(j["status"] == "done" for j in jobs.values())
    assert jobs["New names"]["input_tokens"] > 0 and jobs["New names"]["cost"] > 0               # input/output token names are read
    assert jobs["No usage"]["input_tokens"] > 0 and jobs["No usage"]["cost"] > 0                 # no usage reported: estimated, not free
    assert jobs["Unpriced"]["input_tokens"] > 0 and jobs["Unpriced"]["cost"] == 0
    u = c.get("/api/usage?days=1").json()
    assert {"model": "Unpriced", "jobs": 1} in u["unpriced"] and u["estimated"] >= 1
    assert next(r for r in u["recent"] if r["model"] == "No usage")["estimated"] is True
    m = next(x for x in c.get("/api/admin/models").json()["models"] if x["name"] == "Unpriced")
    assert m["priced"] is False and m["unpriced_jobs"] == 1
    upd = c.put(f"/api/admin/models/{m['id']}", headers=H, json={"name": "Unpriced", "provider": "openai", "model_id": "fake-unpriced", "base_url": base,
                                                              "price_in": 2, "price_out": 8, "recalc": True}).json()
    assert upd["recalculated"] == 1 and upd["unpriced_jobs"] == 0
    j = c.get(f"/api/jobs/{jobs['Unpriced']['id']}").json()
    assert j["cost"] == round((j["input_tokens"] * 2 + j["output_tokens"] * 8) / 1e6, 4)
    assert not c.get("/api/usage?days=1").json()["unpriced"]
    c.delete(f"/api/ontologies/{oid}", headers=H)
    for x in made:
        c.delete(f"/api/admin/models/{x['id']}", headers=H)


def _shop_files():
    import random
    random.seed(11)
    cust = "customer_id,full_name,email,since,tier\n" + "".join(
        f"{i},Person-{i:03d},p{i}@mail.example,2023-0{i % 9 + 1}-1{i % 9},{['Gold', 'Silver'][i % 2]}\n" for i in range(1, 41))
    status = ["Placed", "Paid", "Shipped", "lost in transit"]
    orders = "order_id,order_no,customer_id,order_date,total,status\n" + "".join(
        f"{i},{'ZZ-SENTINEL-0099' if i == 77 else f'O-{i:04d}'},{999 if i == 5 else random.randint(1, 40)},2025-03-{i % 28 + 1:02d} 10:30,{i * 10.5},{status[i % 4]}\n"
        for i in range(1, 121))
    lines = "line_id,order_id,product_id,qty,price\n" + "".join(f"{i},{i % 120 + 1},{i % 15 + 1},{i % 4 + 1},{9.99 + i}\n" for i in range(1, 301))
    prods = "product_id,sku,product_name\n" + "".join(f"{i},SKU{i:03d},Product {i}\n" for i in range(1, 16))
    return [("files", (n, d.encode(), "text/csv")) for n, d in
            (("customers.csv", cust), ("orders.csv", orders), ("order_lines.csv", lines), ("products.csv", prods))]


def test_knowledge_graph_from_data(admin, fake_llm):
    """Mapping (AI-proposed, checked), building the graph from kept files, queries (read-only, time-limited),
    answers in the test bed, personal data held back, and data shown only to people who may use the data source."""
    from app import config
    c, mid = admin
    oid = c.post("/api/ontologies", headers=H, json={"name": "Shop graph", "domain": "Retail", "visibility": "shared"}).json()["id"]
    assert wait_job(c, c.post(f"/api/ontologies/{oid}/build", headers=H, json={"model_id": mid, "use_cases": 0}).json()["id"])["status"] == "done"
    ds = c.post("/api/datasources", headers=H, json={"name": "Shop data", "kind": "files"}).json()
    up = c.post(f"/api/datasources/{ds['id']}/files", headers=H, files=_shop_files()).json()
    assert len(up["added"]) == 4
    d = c.get(f"/api/datasources/{ds['id']}").json()
    assert all(i["kept"] for i in d["items"])                                        # dataset files are kept, to build graphs from
    assert len(list((config.DATASETS_DIR / str(ds["id"])).iterdir())) == 4
    g = c.get(f"/api/ontologies/{oid}/graph").json()
    assert g["status"] == "none" and g["tables"] == []                              # no data source linked yet
    c.post(f"/api/ontologies/{oid}/datasources", headers=H, json={"data_source_id": ds["id"]})
    assert c.post(f"/api/ontologies/{oid}/graph/build", headers=H).status_code == 400   # nothing mapped
    # names alone already find most of it
    m = c.post(f"/api/ontologies/{oid}/graph/match", headers=H, json={}).json()
    assert {x["class"] for x in m["mapping"]["maps"]} >= {"Customer", "Order", "Product"}
    c.put(f"/api/ontologies/{oid}/graph/mapping", headers=H, json={"mapping": {"maps": []}})
    # the AI proposal: everything that does not exist is dropped and reported
    n = len(fake_llm.REQUESTS)
    j = wait_job(c, c.post(f"/api/ontologies/{oid}/graph/propose", headers=H, json={"model_id": mid}).json()["id"])
    assert j["status"] == "done", j
    probs = " ".join(j["result"]["problems"])
    assert "Unicorn" in probs and "no_such_table" in probs and "no_such_column" in probs
    g = c.get(f"/api/ontologies/{oid}/graph").json()
    maps = {x["class"]: x for x in g["mapping"]["maps"]}
    assert set(maps) == {"Customer", "Order", "OrderLine", "Product"} and all(x["ai"] for x in maps.values())
    assert maps["Order"]["links"][0] == {**maps["Order"]["links"][0], "property": "placedBy", "to": maps["Customer"]["id"], "side": "from", "column": "customer_id"}
    assert not any(a["property"] == "gtin" for a in maps["Product"]["attributes"])
    assert "TABLE customers" in json.dumps(fake_llm.REQUESTS[n:])
    # build: the rows are loaded; personal columns stay out unless the owner allows them
    j = wait_job(c, c.post(f"/api/ontologies/{oid}/graph/build", headers=H).json()["id"])
    assert j["status"] == "done", j
    g = c.get(f"/api/ontologies/{oid}/graph").json()
    st = g["stats"]
    assert g["status"] == "ready" and st["classes"]["Order"] == 120 and st["classes"]["Customer"] == 40 and st["classes"]["Party"] == 40
    om = next(x for x in st["maps"] if x["class"] == "Order")
    assert om["links"]["placedBy"]["dangling"] == 1                                 # order 5 points at customer 999
    assert om["values"]["hasStatus"]["unmatched"] == 30 and om["values"]["hasStatus"]["examples"] == ["lost in transit"]
    cm = next(x for x in st["maps"] if x["class"] == "Customer")
    assert set(cm["masked"]) == {"full_name", "email"} and st["properties"]["email"] == 0
    assert st["properties"]["places"] == 119                                          # inverse added
    assert g["coverage"]["classes_with_data"] >= 4
    # queries: read-only, no other servers, results with the picture of the records
    q = c.post(f"/api/ontologies/{oid}/graph/query", headers=H, json={"sparql": "SELECT ?o ?t WHERE { ?o a :Order ; :orderTotal ?t ; :hasStatus :Paid } ORDER BY ?t"}).json()
    assert q["count"] == 30 and q["rows"][0][1]["v"] == "10.5" and q["picture"]["nodes"]
    assert any(e["label"] for e in q["picture"]["edges"]) and q["picture"]["legend"][0]["name"] == "Order"
    for bad in ("INSERT DATA { :x a :Order }", "SELECT * WHERE { SERVICE <http://example.org/sparql> { ?s ?p ?o } }", "SELECT ?x WHERE {"):
        r = c.post(f"/api/ontologies/{oid}/graph/query", headers=H, json={"sparql": bad})
        assert r.status_code == 400, bad
    agg = c.post(f"/api/ontologies/{oid}/graph/query", headers=H, json={"sparql": "SELECT (COUNT(?l) AS ?n) WHERE { ?o :hasLine ?l }"}).json()
    assert agg["rows"][0][0]["v"] == "300" and agg["picture"] is None
    # the test bed answers the use case from the data; the AI never sees the rows
    n = len(fake_llm.REQUESTS)
    r = c.post(f"/api/ontologies/{oid}/tests", headers=H, json={"text": "Show orders by customer with their totals", "model_id": mid, "data": True}).json()
    assert wait_job(c, r["job"]["id"])["status"] == "done"
    t = c.get(f"/api/ontologies/{oid}/tests/{r['test']['id']}").json()
    data = t["result"]["data"]
    assert data["status"] == "answered" and data["result"]["count"] == 89 and data["result"]["picture"]["nodes"]   # 119 linked orders minus 30 "lost"
    assert "ZZ-SENTINEL" in json.dumps(data) and "ZZ-SENTINEL" not in json.dumps(fake_llm.REQUESTS[n:])
    assert "placedBy" in json.dumps(fake_llm.REQUESTS[n:])                           # the shape of the graph was given
    # a broken query is corrected once from the engine's message; a query that writes is refused
    r = c.post(f"/api/ontologies/{oid}/tests", headers=H, json={"text": "BAD-QUERY: orders by customer", "model_id": mid, "data": True}).json()
    wait_job(c, r["job"]["id"])
    assert c.get(f"/api/ontologies/{oid}/tests/{r['test']['id']}").json()["result"]["data"]["status"] == "answered"
    r = c.post(f"/api/ontologies/{oid}/tests", headers=H, json={"text": "CHANGE-DATA orders by customer", "model_id": mid, "data": True}).json()
    wait_job(c, r["job"]["id"])
    bad = c.get(f"/api/ontologies/{oid}/tests/{r['test']['id']}").json()
    assert bad["status"] == "done" and bad["result"]["data"]["status"] == "error"          # the design result still stands
    # a test without data can be answered afterwards, and re-run without AI
    r = c.post(f"/api/ontologies/{oid}/tests", headers=H, json={"text": "Which warranty claims are open?", "model_id": mid}).json()
    wait_job(c, r["job"]["id"])
    tid = r["test"]["id"]
    assert "data" not in c.get(f"/api/ontologies/{oid}/tests/{tid}").json()["result"]
    wait_job(c, c.post(f"/api/ontologies/{oid}/tests/{tid}/answer", headers=H, json={"model_id": mid}).json()["job"]["id"])
    w = c.get(f"/api/ontologies/{oid}/tests/{tid}").json()["result"]["data"]
    assert w["status"] == "empty" and w["cannot_answer"]
    assert c.post(f"/api/ontologies/{oid}/tests/{tid}/rerun", headers=H).json()["status"] == "empty"
    # people without access to the data source see the design, never the rows
    assert c.put(f"/api/ontologies/{oid}", headers=H, json={"name": "Shop graph", "domain": "Retail", "visibility": "shared"}).status_code == 200
    bob = make_user(c, "kg-bob@test.local", "ontologist")
    vic = make_user(c, "kg-vic@test.local", "viewer")
    for who in (bob, vic):
        gg = who.get(f"/api/ontologies/{oid}/graph").json()
        assert gg["can_see_data"] is False and gg["tables"] == [] and gg["stats"]["classes"]["Order"] == 120
        assert all(not v["examples"] for x in gg["stats"]["maps"] for v in x["values"].values())
        assert who.post(f"/api/ontologies/{oid}/graph/query", headers=H, json={"sparql": "SELECT * WHERE { ?s ?p ?o } LIMIT 1"}).status_code == 403
        td = who.get(f"/api/ontologies/{oid}/tests/{t['id']}").json()["result"]["data"]
        assert td["hidden"] and "result" not in td and "ZZ-SENTINEL" not in json.dumps(td)
        assert who.post(f"/api/ontologies/{oid}/tests/{t['id']}/rerun", headers=H).status_code == 403
    assert bob.put(f"/api/ontologies/{oid}/graph/mapping", headers=H, json={"mapping": {"maps": []}}).status_code in (403, 404)
    # given access, Bob sees the data
    c.put(f"/api/datasources/{ds['id']}/access", headers=H, json={"visibility": "private", "users": [bob.get("/api/auth/me").json()["id"]]})
    assert bob.post(f"/api/ontologies/{oid}/graph/query", headers=H, json={"sparql": "SELECT * WHERE { ?s ?p ?o } LIMIT 1"}).status_code == 200
    # the owner allows personal data: names and e-mail addresses are loaded at the next build
    s = c.get(f"/api/datasources/{ds['id']}").json()
    c.put(f"/api/datasources/{ds['id']}", headers=H, json={"name": s["name"], "kind": "files", "graph_personal": True})
    old = c.get(f"/api/ontologies/{oid}/graph").json()
    wait_job(c, c.post(f"/api/ontologies/{oid}/graph/build", headers=H).json()["id"])
    g = c.get(f"/api/ontologies/{oid}/graph").json()
    assert g["stats"]["properties"]["email"] == 40
    q = c.post(f"/api/ontologies/{oid}/graph/query", headers=H, json={"sparql": "SELECT ?n WHERE { ?c a :Customer ; rdfs:label ?n } ORDER BY ?n LIMIT 1"}).json()
    assert q["rows"][0][0]["v"] == "Person-001"
    live = {p.name for p in config.GRAPHS_DIR.iterdir()}
    assert len([x for x in live if x.startswith(f"{oid}-")]) == 1                    # the previous build was removed
    # a dataset uploaded before files were kept: the build says what to do
    from app.db import SessionLocal
    from app.models import DataSourceItem
    with SessionLocal() as db:
        it = db.scalar(select_item(ds["id"], "products"))
        it.stored = ""
        db.commit()
    j = wait_job(c, c.post(f"/api/ontologies/{oid}/graph/build", headers=H).json()["id"])
    assert j["status"] == "done" and any("Upload it again" in x for x in j["result"]["notes"])
    # deleting: the graph goes with the ontology, kept files with the data source
    c.delete(f"/api/ontologies/{oid}", headers=H)
    assert not [p for p in config.GRAPHS_DIR.iterdir() if p.name.startswith(f"{oid}-")]
    c.delete(f"/api/datasources/{ds['id']}", headers=H)
    assert not (config.DATASETS_DIR / str(ds["id"])).exists()
    assert old["status"] == "ready"


def select_item(dsid, name):
    from sqlalchemy import select
    from app.models import DataSourceItem
    return select(DataSourceItem).where(DataSourceItem.data_source_id == dsid, DataSourceItem.name == name)


def test_knowledge_graph_from_a_database(admin):
    """Rows of a live database are read with SELECTs and a row limit per table; the graph says what was left out."""
    c, mid = admin
    path = tempfile.mktemp(suffix=".db")
    _lending_db(path)
    from app import sources as srcmod
    real = srcmod.db_url
    srcmod.db_url = lambda *a, **k: f"sqlite:///{path}"
    try:
        ds = c.post("/api/datasources", headers=H, json={"name": "Lending DB", "kind": "database", "db_type": "postgresql", "host": "db.internal",
                                                         "database": "lending", "user": "reader", "password": "pw-secret"}).json()
        oid = c.post("/api/ontologies", headers=H, json={"name": "Lending graph"}).json()["id"]
        c.post(f"/api/ontologies/{oid}/datasources", headers=H, json={"data_source_id": ds["id"]})
        assert wait_job(c, c.post(f"/api/ontologies/{oid}/build", headers=H, json={"model_id": mid, "use_cases": 0}).json()["id"])["status"] == "done"
        g = c.post(f"/api/ontologies/{oid}/graph/match", headers=H, json={}).json()
        maps = {m["class"]: m for m in g["mapping"]["maps"]}
        assert maps["Loan"]["table"] == "loans" and maps["Customer"]["table"] == "customers" and maps["Customer"]["key"] == "id"
        c.put("/api/admin/settings", headers=H, json={"graph_rows_per_table": 100})
        j = wait_job(c, c.post(f"/api/ontologies/{oid}/graph/build", headers=H).json()["id"])
        assert j["status"] == "done", j
        st = c.get(f"/api/ontologies/{oid}/graph").json()["stats"]
        assert st["classes"]["Loan"] == 100 and any(t["capped"] and t["total"] == 600 for t in st["tables"])
        assert any("first 100 of 600 rows" in n for n in st["notes"])
        assert "pw-secret" not in json.dumps(st)
        c.delete(f"/api/ontologies/{oid}", headers=H)
        c.delete(f"/api/datasources/{ds['id']}", headers=H)
    finally:
        srcmod.db_url = real
        c.put("/api/admin/settings", headers=H, json={"graph_rows_per_table": 10000})
