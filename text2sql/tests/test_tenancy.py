"""Multi-company: one company never sees or touches another's data; platform models/senders are shared only as chosen."""
import io
import struct
import zlib

import pytest

from tests.conftest import FAKE_PORT, H
from tests.test_platform import ask


def _png() -> bytes:
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    raw = b"".join(b"\x00" + b"\x2a\x78\xd6" * 8 for _ in range(8))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def _sign_in(email, password, new="Tenant-Passw0rd-1"):
    from fastapi.testclient import TestClient
    from app import security
    from app.main import app
    security.limiter._hits.pop("login:testclient", None)
    c = TestClient(app)
    assert c.post("/api/auth/login", headers=H, json={"email": email, "password": password}).status_code == 200
    c.post("/api/auth/change-password", headers=H, json={"current": password, "new": new})
    return c


@pytest.fixture(scope="module")
def two(admin):
    a, conn1, model1 = admin                                   # platform administrator of the first company
    made = a.post("/api/admin/companies", headers=H, json={"name": "Beta Ltd", "admin_email": "boss@beta.test",
                                                           "admin_name": "Bo Beta", "samples": True}).json()
    beta = _sign_in("boss@beta.test", made["temporary_password"])
    analyst = beta.post("/api/admin/users", headers=H, json={"email": "ana@beta.test", "name": "Ana Beta", "role": "analyst"}).json()
    ana = _sign_in("ana@beta.test", analyst["temporary_password"])
    return {"a": a, "conn1": conn1, "model1": model1, "beta": beta, "ana": ana, "company": made}


def test_companies_are_isolated(two, fake_llm):
    a, beta, ana, conn1, model1 = two["a"], two["beta"], two["ana"], two["conn1"], two["model1"]
    assert beta.get("/api/auth/me").json()["company"]["name"] == "Beta Ltd"
    assert not beta.get("/api/auth/me").json()["is_platform_admin"]
    assert beta.get("/api/admin/companies").status_code == 403
    listed = {c["name"]: c for c in a.get("/api/admin/companies").json()}
    assert listed["Beta Ltd"]["users"] == 2 and listed["Beta Ltd"]["data_models"] == 2

    # data models: the sample names exist in both companies; each sees only its own
    mine = beta.get("/api/connections").json()
    assert sorted(c["name"] for c in mine) == ["Sample: Retail sales", "Sample: SAP Sales & Finance"]
    assert conn1 not in [c["id"] for c in mine]
    for call in (lambda: beta.get(f"/api/connections/{conn1}/schema"), lambda: beta.get(f"/api/training/{conn1}"),
                 lambda: beta.post("/api/chat/ask", headers=H, json={"connection_id": conn1, "question": "revenue by region"}),
                 lambda: beta.put(f"/api/admin/access/{conn1}", headers=H, json={"is_active": False, "restricted": True}),
                 lambda: beta.delete(f"/api/connections/{conn1}", headers=H),
                 lambda: beta.post("/api/admin/filters", headers=H, json={"connection_id": conn1, "table_name": "customers", "condition": "1=1"})):
        assert call().status_code == 404
    assert all(c["id"] in [m["id"] for m in mine] for c in beta.get("/api/admin/access").json()["connections"])

    # people: another company's users do not exist for this admin
    u1 = next(u for u in a.get("/api/admin/users").json() if u["email"] == "admin@test.local")
    assert "admin@test.local" not in [u["email"] for u in beta.get("/api/admin/users").json()]
    assert beta.put(f"/api/admin/users/{u1['id']}", headers=H, json={"email": "x", "role": "analyst"}).status_code == 404
    assert beta.post(f"/api/admin/users/{u1['id']}/reset-password", headers=H).status_code == 404
    assert beta.delete(f"/api/admin/users/{u1['id']}", headers=H).status_code == 404
    g1 = a.post("/api/admin/groups", headers=H, json={"name": "Finance team"}).json()["id"]
    g2 = beta.post("/api/admin/groups", headers=H, json={"name": "Finance team", "user_ids": [u1["id"]]}).json()["id"]   # same name: fine
    assert next(g for g in beta.get("/api/admin/groups").json() if g["id"] == g2)["user_ids"] == []                  # other company's user dropped
    assert g1 not in [g["id"] for g in beta.get("/api/admin/groups").json()]

    # AI models: the first company's model is not available here
    assert beta.get("/api/models").json() == []
    assert ana.post("/api/chat/ask", headers=H, json={"connection_id": mine[0]["id"], "model_id": model1, "question": "x"}).status_code == 400

    # chats and reports shared "with all analysts" stay inside their company
    out = ask(a, conn1, model1, "revenue and orders by region")
    a.put(f"/api/chat/conversations/{out['conversation']['id']}/shares", headers=H, json={"shares": [{"scope": "role", "role": "analyst"}]})
    rep = a.post("/api/reports", headers=H, json={"title": "Company one pack", "components": [{"type": "result", "run_id": out["run"]["id"]}]}).json()
    a.put(f"/api/reports/{rep['id']}/shares", headers=H, json={"shares": [{"scope": "role", "role": "analyst"}]})
    assert out["conversation"]["id"] not in [c["id"] for c in ana.get("/api/chat/conversations").json()]
    assert ana.get(f"/api/chat/conversations/{out['conversation']['id']}").status_code == 404
    assert rep["id"] not in [r["id"] for r in beta.get("/api/reports").json()]
    for who in (beta, ana):
        assert who.get(f"/api/reports/{rep['id']}/render").status_code == 404
    directory = beta.get("/api/reports/people").json()
    assert [u["email"] for u in directory["users"]] == ["ana@beta.test", "boss@beta.test"]

    # audit log, email log, dashboard: own company only
    trail = beta.get("/api/admin/audit").json()["items"]
    assert trail and all("test.local" not in (e["user"] + e["target"]) for e in trail)
    assert beta.get("/api/analytics/summary").json()["totals"]["queries"] == 0
    assert a.get("/api/analytics/summary").json()["totals"]["queries"] > 0
    a.delete(f"/api/reports/{rep['id']}", headers=H)
    a.delete(f"/api/admin/groups/{g1}", headers=H)


def test_shared_models_settings_suspension_and_logo(two, fake_llm):
    a, beta, ana = two["a"], two["beta"], two["ana"]
    url = f"http://127.0.0.1:{FAKE_PORT}/v1"
    beta_conn = beta.get("/api/connections").json()[0]["id"]
    beta_cid = two["company"]["id"]

    # a platform model: offered to the first company only, then to Beta; Beta may switch it off
    assert beta.post("/api/admin/models", headers=H, json={"name": "X", "provider": "openai_compatible", "model_id": "m", "base_url": url,
                                                           "scope": "platform"}).status_code == 403
    shared = a.post("/api/admin/models", headers=H, json={"name": "Shared stand-in", "provider": "openai_compatible", "model_id": "fake-1",
                                                          "base_url": url, "scope": "platform", "price_in": 1, "price_out": 1}).json()
    assert shared["scope"] == "platform" and shared["shared_companies"] == [1]
    assert beta.get("/api/models").json() == []
    assert beta.put(f"/api/admin/models/{shared['id']}/sharing", headers=H, json={"company_ids": [beta_cid]}).status_code == 403
    a.put(f"/api/admin/models/{shared['id']}/sharing", headers=H, json={"company_ids": [1, beta_cid]})
    seen = beta.get("/api/models").json()
    assert [(m["name"], m["group"]) for m in seen] == [("Shared stand-in", "shared")]
    assert ask(ana, beta_conn, shared["id"], "revenue by category")["run"]["status"] == "success"
    admin_view = beta.get("/api/admin/models").json()
    assert admin_view["shared"][0]["id"] == shared["id"] and "base_url" not in admin_view["shared"][0] and "platform" not in admin_view
    assert beta.put(f"/api/admin/models/{shared['id']}", headers=H, json={"name": "Mine now", "provider": "openai_compatible",
                                                                          "model_id": "x", "base_url": url}).status_code == 404
    beta.put("/api/admin/company/models", headers=H, json={"hidden": [shared["id"]]})
    assert beta.get("/api/models").json() == []                                        # switched off for Beta only
    assert any(m["id"] == shared["id"] for m in a.get("/api/models").json())
    beta.put("/api/admin/company/models", headers=H, json={"hidden": []})

    # names never clash within what one company sees
    clash = beta.post("/api/admin/models", headers=H, json={"name": "shared stand-in", "provider": "openai_compatible", "model_id": "m", "base_url": url})
    assert clash.status_code == 400 and "Choose a different name" in clash.json()["detail"]
    own = beta.post("/api/admin/models", headers=H, json={"name": "Beta model", "provider": "openai_compatible", "model_id": "fake-1", "base_url": url}).json()
    other = a.post("/api/admin/models", headers=H, json={"name": "Beta model", "provider": "openai_compatible", "model_id": "fake-1",
                                                         "base_url": url, "scope": "platform"}).json()     # fine: only company one sees it so far
    assert a.put(f"/api/admin/models/{other['id']}/sharing", headers=H, json={"share_all": True}).status_code == 400
    beta.put("/api/admin/company/models", headers=H, json={"default_id": own["id"]})
    assert beta.get("/api/models").json()[0]["id"] == own["id"] and beta.get("/api/models").json()[0]["is_default"]

    # settings are per company; installation-wide ones only for the platform administrator
    beta.put("/api/admin/settings", headers=H, json={"rate_limit_per_min": 7, "session_hours": 1})
    assert beta.get("/api/admin/settings").json()["rate_limit_per_min"] == 7 and "session_hours" not in beta.get("/api/admin/settings").json()
    assert a.get("/api/admin/settings").json()["rate_limit_per_min"] != 7 and a.get("/api/admin/settings").json()["session_hours"] == 12

    # files data models: no server folders for company admins
    bad = beta.post("/api/connections", headers=H, json={"name": "Peek", "db_type": "files", "config": {"folder": "/"}})
    assert bad.status_code == 400 and "platform administrator" in bad.json()["detail"]
    from app import config
    inside = a.post("/api/connections", headers=H, json={"name": "Peek", "db_type": "files", "config": {"folder": str(config.DATA_DIR / "files")}})
    assert inside.status_code == 400

    # logo: own company only, images only, on the report PDF
    assert beta.post("/api/company/logo", headers=H, files={"upload": ("x.svg", b"<svg onload=alert(1)>", "image/svg+xml")}).status_code == 400
    assert beta.post("/api/company/logo", headers=H, files={"upload": ("logo.png", _png(), "image/png")}).json()["ok"]
    got = ana.get("/api/company/logo")
    assert got.status_code == 200 and got.headers["content-type"] == "image/png" and got.content == _png()
    assert a.get("/api/company/logo").status_code == 404                     # the first company has none
    run = ask(ana, beta_conn, own["id"], "revenue by category")["run"]
    r = ana.post("/api/reports", headers=H, json={"title": "Beta pack", "components": [{"type": "result", "run_id": run["id"]}]}).json()
    from pypdf import PdfReader
    page = PdfReader(io.BytesIO(ana.get(f"/api/reports/{r['id']}/pdf").content)).pages[0]
    assert len(page.images) >= 1 and "logo" not in ana.get(f"/api/reports/{r['id']}/render").json()

    # suspension: everyone in the company is signed out and cannot sign in; you cannot suspend your own company
    assert a.put("/api/admin/companies/1", headers=H, json={"name": "Default company", "is_active": False}).status_code == 400
    a.put(f"/api/admin/companies/{beta_cid}", headers=H, json={"name": "Beta Ltd", "is_active": False})
    assert ana.get("/api/chat/conversations").status_code == 401
    from app import security
    security.limiter._hits.pop("login:testclient", None)
    from fastapi.testclient import TestClient
    from app.main import app
    assert TestClient(app).post("/api/auth/login", headers=H, json={"email": "ana@beta.test", "password": "Tenant-Passw0rd-1"}).status_code == 403
    a.put(f"/api/admin/companies/{beta_cid}", headers=H, json={"name": "Beta Ltd", "is_active": True})
    reset = a.post(f"/api/admin/companies/{beta_cid}/admins/{beta.get('/api/auth/me').json().get('id', 0) or 0}/reset-password", headers=H)
    assert reset.status_code in (200, 401, 404)
    assert any(e["action"] == "company.updated" for e in a.get("/api/admin/audit?action=company").json()["items"])
    a.delete(f"/api/admin/models/{shared['id']}", headers=H)
    a.delete(f"/api/admin/models/{other['id']}", headers=H)


def test_single_company_database_upgrades_to_first_company(tmp_path):
    """A database from before companies: everything becomes the first company, admins manage the platform,
    and names that used to be unique installation-wide become unique per company - with the data kept."""
    import sqlite3
    import subprocess
    import sys
    db = tmp_path / "text2sql.db"
    con = sqlite3.connect(db)
    con.executescript("""
        CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(255) UNIQUE, name VARCHAR(255), password_hash VARCHAR(255), role VARCHAR(20),
            is_active BOOLEAN, must_change_password BOOLEAN, totp_secret_enc TEXT, totp_enabled BOOLEAN, totp_last_counter INTEGER,
            recovery_codes JSON, failed_attempts INTEGER, locked_until DATETIME, token_version INTEGER, last_login_at DATETIME, created_at DATETIME);
        CREATE TABLE connections (id INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, description TEXT, db_type VARCHAR(30), config_enc TEXT,
            is_active BOOLEAN, restricted BOOLEAN, allow_samples BOOLEAN, sample_columns JSON, masked_columns JSON, schema_json JSON,
            schema_synced_at DATETIME, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at DATETIME, updated_at DATETIME);
        CREATE TABLE user_groups (id INTEGER PRIMARY KEY, name VARCHAR(200) NOT NULL UNIQUE, description VARCHAR(500), created_at DATETIME);
        CREATE TABLE llm_models (id INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, provider VARCHAR(30), model_id VARCHAR(255), base_url VARCHAR(500),
            api_key_enc TEXT, effort VARCHAR(20), enabled BOOLEAN, is_default BOOLEAN, price_in FLOAT, price_out FLOAT, created_at DATETIME);
        CREATE TABLE training_items (id INTEGER PRIMARY KEY, connection_id INTEGER REFERENCES connections(id) ON DELETE CASCADE, kind VARCHAR(20),
            title VARCHAR(500), content TEXT, question TEXT, sql TEXT, source VARCHAR(30), status VARCHAR(20), document_name VARCHAR(500),
            created_by INTEGER, created_at DATETIME, updated_at DATETIME);
        INSERT INTO users VALUES (1, 'boss@old.test', 'Boss', 'x', 'admin', 1, 0, NULL, 0, 0, '[]', 0, NULL, 0, NULL, '2025-01-01'),
                                 (2, 'ann@old.test', 'Ann', 'x', 'analyst', 1, 0, NULL, 0, 0, '[]', 0, NULL, 0, NULL, '2025-01-01');
        INSERT INTO connections VALUES (1, 'Sales', '', 'files', '', 1, 0, 0, '[]', '[]', NULL, NULL, 1, '2025-01-01', '2025-01-01');
        INSERT INTO user_groups VALUES (1, 'Finance', '', '2025-01-01');
        INSERT INTO llm_models VALUES (1, 'Opus', 'anthropic', 'claude-opus-5-5', '', '', '', 1, 1, 4, 20, '2025-01-01');
        INSERT INTO training_items VALUES (1, 1, 'documentation', 'Rule', 'Keep me', '', '', 'manual', 'approved', '', 1, '2025-01-01', '2025-01-01');
    """)
    con.commit()
    con.close()
    code = r"""
from app.main import bootstrap; bootstrap(); bootstrap()
import sqlite3; c = sqlite3.connect(r'%s')
print('companies', c.execute('select id, name from companies').fetchall())
print('users', c.execute('select email, company_id, is_platform_admin from users order by id').fetchall())
print('conn', c.execute('select name, company_id from connections where id = 1').fetchall())
print('model', c.execute('select name, company_id, share_all, shared_companies from llm_models where id = 1').fetchall())
print('training', c.execute('select content from training_items where connection_id = 1').fetchall())
c.execute("insert into connections (name, description, db_type, config_enc, company_id, is_active, restricted, allow_samples, sample_columns, masked_columns, created_at, updated_at) values ('Sales', '', 'files', '', 2, 1, 0, 0, '[]', '[]', '2026-01-01', '2026-01-01')")
c.execute("insert into user_groups (name, company_id, description, created_at) values ('Finance', 2, '', '2026-01-01')")
try:
    c.execute("insert into connections (name, description, db_type, config_enc, company_id, is_active, restricted, allow_samples, sample_columns, masked_columns, created_at, updated_at) values ('Sales', '', 'files', '', 1, 1, 0, 0, '[]', '[]', '2026-01-01', '2026-01-01')")
    print('dup allowed')
except sqlite3.IntegrityError:
    print('dup refused')
print('fk', c.execute('pragma foreign_key_check').fetchall(), c.execute('pragma integrity_check').fetchone())
""" % db
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=".",
                         env={**__import__("os").environ, "T2S_DATA_DIR": str(tmp_path), "T2S_ADMIN_PASSWORD": "Upgrade-Passw0rd"})
    assert out.returncode == 0, out.stderr[-800:]
    o = out.stdout
    assert "companies [(1, 'Default company')]" in o
    assert "users [('boss@old.test', 1, 1), ('ann@old.test', 1, 0)]" in o
    assert "conn [('Sales', 1)]" in o and "model [('Opus', None, 0, '[1]')]" in o and "training [('Keep me',)]" in o
    assert "dup refused" in o and "fk [] ('ok',)" in o


def test_removing_platform_admin_rights(admin):
    """Another platform admin's rights can be removed and the account deleted; only your own are protected."""
    a = admin[0]
    second = a.post("/api/admin/users", headers=H, json={"email": "second.pa@test.local", "name": "Second", "role": "admin",
                                                          "is_platform_admin": True}).json()
    assert second["is_platform_admin"]
    body = {"email": second["email"], "name": "Second", "role": "admin", "is_active": True, "show_sql": True}
    assert a.put(f"/api/admin/users/{second['id']}", headers=H, json={**body, "is_platform_admin": False}).json()["is_platform_admin"] is False
    me = a.get("/api/auth/me").json()
    own = a.put(f"/api/admin/users/{me['id']}", headers=H, json={"email": me["email"], "name": me["name"], "role": "admin",
                                                                  "is_active": True, "show_sql": True, "is_platform_admin": False})
    assert own.status_code == 400 and f"signed in as {me['email']}" in own.json()["detail"]
    assert a.delete(f"/api/admin/users/{second['id']}", headers=H).status_code == 200


def test_platform_admin_adds_and_moves_people(two):
    """＋ User puts anyone into a company; moving a person removes every tie to the old company,
    hands their reports to an old-company administrator (schedules paused) and signs them out."""
    a = two["a"]
    cos = {c["name"]: c for c in a.get("/api/admin/companies").json()}
    one, b = next(c for c in cos.values() if c["is_mine"]), cos["Beta Ltd"]
    boss0 = next(x for x in b["admins"] if x["email"] == "boss@beta.test")      # earlier tests signed Beta out
    pw = a.post(f"/api/admin/companies/{b['id']}/admins/{boss0['id']}/reset-password", headers=H).json()["temporary_password"]
    beta = _sign_in("boss@beta.test", pw, new="Tenant-Passw0rd-9")
    assert beta.get(f"/api/admin/companies/{b['id']}/users").status_code == 403          # platform administrators only
    assert beta.post(f"/api/admin/companies/{one['id']}/users", headers=H, json={"email": "x@x.test"}).status_code == 403

    # ＋ User: any role, straight into another company
    r = a.post(f"/api/admin/companies/{b['id']}/users", headers=H,
               json={"email": "mo@beta.test", "name": "Mo Mover", "role": "analyst", "show_sql": False}).json()
    assert r["role"] == "analyst" and r["show_sql"] is False
    assert a.post(f"/api/admin/companies/{b['id']}/users", headers=H, json={"email": "mo@beta.test"}).status_code == 400
    assert a.post(f"/api/admin/companies/{b['id']}/users", headers=H, json={"email": "z@beta.test", "role": "boss"}).status_code == 400
    st = a.post(f"/api/admin/companies/{b['id']}/users", headers=H, json={"email": "stew@beta.test", "role": "steward"}).json()
    assert "mo@beta.test" in [u["email"] for u in beta.get("/api/admin/users").json()]       # Beta's admin sees them
    mo = _sign_in("mo@beta.test", r["temporary_password"])
    assert mo.get("/api/auth/me").json()["company"]["name"] == "Beta Ltd"

    # Mo's ties to Beta: a group, a report with a schedule, a place on a colleague's schedule, a personal share
    gid = beta.post("/api/admin/groups", headers=H, json={"name": "Movers", "user_ids": [r["id"]]}).json()["id"]
    rep = mo.post("/api/reports", headers=H, json={"title": "Mo's pack", "components": []}).json()["id"]
    assert mo.put(f"/api/reports/{rep}/schedule", headers=H, json={"enabled": True, "recipients": ["out@else.test"]}).status_code == 200
    boss_rep = beta.post("/api/reports", headers=H, json={"title": "Boss pack", "components": []}).json()["id"]
    assert beta.put(f"/api/reports/{boss_rep}/schedule", headers=H, json={"enabled": True, "user_ids": [r["id"]]}).status_code == 200
    beta.put(f"/api/reports/{boss_rep}/shares", headers=H, json={"shares": [{"scope": "user", "user_id": r["id"]}]})
    assert r["id"] in [x["user_id"] for x in beta.get(f"/api/reports/{boss_rep}").json()["shares"]]
    assert r["id"] in beta.get(f"/api/reports/{boss_rep}").json()["schedule"]["user_ids"]
    people = {u["email"]: u for u in a.get(f"/api/admin/companies/{b['id']}/users").json()}
    assert people["mo@beta.test"]["reports"] == 1
    boss = people["boss@beta.test"]

    url = f"/api/admin/companies/{one['id']}/users/{r['id']}/move"
    assert a.post(url, headers=H, json={"role": "analyst"}).status_code == 400                 # who takes over the report?
    assert a.post(url, headers=H, json={"role": "analyst", "reports_to": st["id"]}).status_code == 400   # a steward cannot
    me = next(u for u in a.get(f"/api/admin/companies/{one['id']}/users").json() if u["email"] == "admin@test.local")
    assert a.post(f"/api/admin/companies/{b['id']}/users/{me['id']}/move", headers=H, json={"role": "admin"}).status_code == 400  # own account
    assert a.post(f"/api/admin/companies/{one['id']}/users/{boss['id']}/move", headers=H,
                  json={"role": "admin"}).status_code == 400                                   # Beta's last administrator
    out = a.post(url, headers=H, json={"role": "steward", "reports_to": boss["id"]})
    assert out.status_code == 200, out.text
    out = out.json()
    assert out["reports_handed_over"] == 1 and out["schedules_paused"] == 1 and out["role"] == "steward"

    # old ties are gone; the report stays in Beta with its new owner, its schedule paused
    assert mo.get("/api/auth/me").status_code == 401                                            # signed out
    assert "mo@beta.test" not in [u["email"] for u in beta.get("/api/admin/users").json()]
    assert next(g for g in beta.get("/api/admin/groups").json() if g["id"] == gid)["user_ids"] == []
    handed = beta.get(f"/api/reports/{rep}").json()
    assert handed["schedule"]["enabled"] is False
    assert next(x for x in beta.get("/api/reports").json() if x["id"] == rep)["scheduled"] is False
    assert r["id"] not in beta.get(f"/api/reports/{boss_rep}").json()["schedule"]["user_ids"]
    assert r["id"] not in [x["user_id"] for x in beta.get(f"/api/reports/{boss_rep}").json()["shares"]]

    # in the new company: sees only that company's things, nothing of Beta's
    mo = _sign_in("mo@beta.test", "Tenant-Passw0rd-1", new="Tenant-Passw0rd-2")
    assert mo.get("/api/auth/me").json()["company"]["id"] == one["id"]
    assert mo.get("/api/auth/me").json()["role"] == "steward"
    assert rep not in [x["id"] for x in mo.get("/api/reports").json()]
    assert mo.get(f"/api/reports/{boss_rep}").status_code in (403, 404)
    assert "mo@beta.test" in [u["email"] for u in a.get("/api/admin/users").json()]
    assert "user.moved_out" in [e["action"] for e in beta.get("/api/admin/audit").json()["items"]]
    assert "user.moved_in" in [e["action"] for e in a.get("/api/admin/audit").json()["items"]]

    # tidy up for later tests
    a.delete(f"/api/admin/users/{r['id']}", headers=H)
    beta.delete(f"/api/admin/users/{st['id']}", headers=H)
    beta.delete(f"/api/admin/groups/{gid}", headers=H)


def test_a_new_data_model_never_inherits_a_deleted_ones_files(admin):
    """Database ids can be reused after a delete; the uploaded files must go with the data model."""
    from app import config
    client = admin[0]
    a = client.post("/api/connections", headers=H, json={"name": "Files to delete", "db_type": "files", "config": {}}).json()
    client.post(f"/api/connections/{a['id']}/files", headers=H, files=[("uploads", ("secret_salaries.csv", b"name,salary\nx,1\n", "text/csv"))])
    folder = config.FILES_DIR / str(a["id"])
    assert (folder / "secret_salaries.csv").exists()
    assert client.delete(f"/api/connections/{a['id']}", headers=H).status_code == 200
    assert not folder.exists()
    folder.mkdir(parents=True)                              # what older versions left behind
    (folder / "left_over.csv").write_bytes(b"a\n1\n")
    b = client.post("/api/connections", headers=H, json={"name": "Fresh files", "db_type": "files", "config": {}}).json()
    assert b["id"] == a["id"]                               # SQLite reuses the freed id: the case that leaked
    stale = config.FILES_DIR / str(b["id"])
    assert not (stale / "left_over.csv").exists() and not (stale / "secret_salaries.csv").exists()
    client.post(f"/api/connections/{b['id']}/sync", headers=H)
    assert client.get(f"/api/connections/{b['id']}/schema").json().get("tables", []) == []
    client.delete(f"/api/connections/{b['id']}", headers=H)
