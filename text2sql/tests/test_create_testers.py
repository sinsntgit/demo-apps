"""tools/create_testers.py: people and companies from a CSV, a shared model, and safe re-runs."""
import csv
import importlib.util
import pathlib

import pytest

from tests.conftest import H

_spec = importlib.util.spec_from_file_location("create_testers", pathlib.Path(__file__).parent.parent / "tools" / "create_testers.py")
ct = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ct)


class ClientApi:
    """The script's API object, backed by the test client instead of HTTP."""
    def __init__(self, client):
        self.c = client

    def call(self, method, path, body=None):
        r = self.c.request(method, path, json=body, headers=H)
        if r.status_code >= 400:
            raise ct.ApiError(r.status_code, r.json().get("detail", ""))
        return r.json()


def _sign_in(email, password):
    from fastapi.testclient import TestClient
    from app import security
    from app.main import app
    security.limiter._hits.pop("login:testclient", None)
    c = TestClient(app)
    return c.post("/api/auth/login", headers=H, json={"email": email, "password": password})


def test_csv_is_checked_with_line_numbers(tmp_path):
    def write(text):
        p = tmp_path / "t.csv"
        p.write_text(text, encoding="utf-8")
        return str(p)
    rows = ct.read_rows(write("email,name,company,role,results_only\nA@x.test,Ann,Co,admin,\nb@x.test,Bob,,analyst,yes\n"))
    assert rows[0]["email"] == "a@x.test" and rows[1]["results_only"] is True and rows[1]["company"] == ""
    for bad, msg in (("email\nnot-an-email\n", "Line 2"), ("email\na@x.test\na@x.test\n", "twice"),
                     ("email,role\na@x.test,boss\n", "role must be"), ("email,role,results_only\na@x.test,admin,yes\n", "only applies to analysts"),
                     ("name\nAnn\n", "at least the column: email"), ("email\n", "no people")):
        with pytest.raises(ValueError, match=msg):
            ct.read_rows(write(bad))


def test_provision_creates_people_companies_and_shares_a_model(admin, tmp_path):
    client = admin[0]
    api = ClientApi(client)
    shared = client.post("/api/admin/models", headers=H, json={"name": "Trial shared model", "provider": "openai_compatible", "model_id": "fake-1",
                                                               "base_url": "http://127.0.0.1:8765/v1", "scope": "platform"}).json()
    rows = [{"email": "ann@trialco.test", "name": "Ann Trial", "company": "Trial Co (script test)", "role": "admin", "results_only": False},
            {"email": "bob@trialco.test", "name": "Bob Trial", "company": "Trial Co (script test)", "role": "analyst", "results_only": True},
            {"email": "own@trialco.test", "name": "Own Company", "company": "", "role": "steward", "results_only": False}]
    log = []
    plan = ct.provision(api, rows, "Trial shared model", dry_run=True, log=log.append)
    assert [r["status"] for r in plan] == ["would be created"] * 3
    assert "Trial Co (script test)" not in [c["name"] for c in client.get("/api/admin/companies").json()]      # a dry run changes nothing

    out = ct.provision(api, rows, "Trial shared model", log=log.append)
    assert [r["status"] for r in out] == ["created"] * 3 and all(r["temporary_password"] for r in out)
    co = next(c for c in client.get("/api/admin/companies").json() if c["name"] == "Trial Co (script test)")
    assert co["users"] == 2 and co["data_models"] == 4                              # sample data models came with it
    ann, bob = out[0], out[1]
    assert _sign_in(ann["email"], ann["temporary_password"]).status_code == 200
    assert _sign_in(bob["email"], bob["temporary_password"]).status_code == 200
    users = {u["email"]: u for u in client.get(f"/api/admin/companies/{co['id']}/users").json()}
    assert users["ann@trialco.test"]["role"] == "admin" and users["bob@trialco.test"]["show_sql"] is False
    own = next(u for u in client.get("/api/admin/users").json() if u["email"] == "own@trialco.test")
    assert own["role"] == "steward"
    model = next(m for m in client.get("/api/admin/models").json()["platform"] if m["id"] == shared["id"])
    assert co["id"] in model["shared_companies"]
    assert not any("no administrator" in line for line in log)                       # the company has one

    again = ct.provision(api, rows, "Trial shared model", log=log.append)           # safe to run twice
    assert [r["status"] for r in again] == ["skipped - already exists"] * 3 and not any(r["temporary_password"] for r in again)

    with pytest.raises(SystemExit, match="No shared"):
        ct.provision(api, rows, "No such model", log=log.append)
    path = ct.write_credentials(out, "https://trial.example/", folder=str(tmp_path))
    with open(path, newline="", encoding="utf-8") as f:
        saved = list(csv.DictReader(f))
    assert {x["email"] for x in saved} == {"ann@trialco.test", "bob@trialco.test", "own@trialco.test"}
    assert ct.write_credentials(again, "https://trial.example/", folder=str(tmp_path)) is None      # nothing new, nothing written
    client.delete(f"/api/admin/users/{own['id']}", headers=H)                                      # leave the shared test database as found
