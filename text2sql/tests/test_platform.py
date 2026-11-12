import json

import pyotp
import pytest

from tests.conftest import H


# ---- SQL guard ---------------------------------------------------------------------
@pytest.mark.parametrize("sql,db", [
    ("SELECT 1", "postgres"),
    ("WITH a AS (SELECT 1 AS x) SELECT * FROM a UNION ALL SELECT 2", "postgres"),
    ("SELECT TOP 5 name FROM dbo.customers ORDER BY name", "mssql"),
    ("SELECT * FROM orders FETCH FIRST 5 ROWS ONLY", "oracle"),
    ("SELECT a, COUNT(*) FROM t GROUP BY a QUALIFY ROW_NUMBER() OVER (ORDER BY a) = 1", "snowflake"),
    ("SELECT `a` FROM t LIMIT 5;", "mysql"),
    ("SELECT 'drop table x; delete' AS note", "postgres"),
])
def test_guard_allows_selects(sql, db):
    from app import sqlguard
    assert sqlguard.check(sql, db).sql


@pytest.mark.parametrize("sql,db", [
    ("DELETE FROM orders", "postgres"),
    ("SELECT 1; DROP TABLE users", "postgres"),
    ("UPDATE t SET a = 1", "mysql"),
    ("SELECT * INTO backup FROM orders", "mssql"),
    ("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "postgres"),
    ("SELECT pg_read_file('/etc/passwd')", "postgres"),
    ("SELECT * FROM read_csv_auto('/etc/passwd')", "files"),
    ("EXEC xp_cmdshell 'dir'", "mssql"),
    ("SELECT * FROM t INTO OUTFILE '/tmp/x'", "mysql"),
    ("CREATE TABLE x AS SELECT 1", "snowflake"),
    ("COPY orders TO '/tmp/o.csv'", "files"),
    ("SELECT pg_sleep(100)", "postgres"),
    ("", "postgres"),
])
def test_guard_blocks_everything_else(sql, db):
    from app import sqlguard
    with pytest.raises(sqlguard.SQLBlocked):
        sqlguard.check(sql, db)


def test_masking_follows_aliases():
    from app import sqlguard
    c = sqlguard.check("WITH c AS (SELECT name, email AS contact FROM customers) "
                       "SELECT name, upper(contact) AS reach FROM c", "postgres")
    assert sqlguard.masked_output_columns(c, ["name", "reach"], ["email"]) == {1}
    c = sqlguard.check("SELECT * FROM customers", "postgres")
    assert sqlguard.masked_output_columns(c, ["id", "email"], ["email"]) == {1}


# ---- auth --------------------------------------------------------------------------
def test_requires_login_and_csrf_header(client):
    from fastapi.testclient import TestClient
    from app.main import app
    anon = TestClient(app)
    assert anon.get("/api/connections").status_code == 401
    assert anon.post("/api/auth/login", json={"email": "a", "password": "b"}).status_code == 403   # no header
    assert anon.post("/api/auth/login", json={"email": "admin@test.local", "password": "nope"}, headers=H).status_code == 401


def test_user_lifecycle_and_2fa(admin):
    from fastapi.testclient import TestClient
    from app.main import app
    client, _, _ = admin
    made = client.post("/api/admin/users", headers=H, json={"email": "ana@test.local", "name": "Ana", "role": "analyst"}).json()
    u = TestClient(app)
    r = u.post("/api/auth/login", headers=H, json={"email": "ana@test.local", "password": made["temporary_password"]})
    assert r.json()["requirements"] == ["change_password"]
    assert u.get("/api/connections").status_code == 401                 # setup scope cannot use the app
    assert u.post("/api/auth/change-password", headers=H, json={"current": made["temporary_password"], "new": "weak"}).status_code == 400
    r = u.post("/api/auth/change-password", headers=H, json={"current": made["temporary_password"], "new": "Str0ng-Passphrase"})
    assert r.json()["requirements"] == []
    assert u.get("/api/connections").status_code == 200
    assert u.get("/api/admin/users").status_code == 403                 # role enforcement

    secret = u.post("/api/auth/2fa/setup", headers=H).json()["secret"]
    assert u.post("/api/auth/2fa/enable", headers=H, json={"code": "000000"}).status_code == 400
    codes = u.post("/api/auth/2fa/enable", headers=H, json={"code": pyotp.TOTP(secret).now()}).json()["recovery_codes"]
    assert len(codes) == 8

    v = TestClient(app)
    assert v.post("/api/auth/login", headers=H, json={"email": "ana@test.local", "password": "Str0ng-Passphrase"}).json() == {"step": "mfa"}
    assert v.get("/api/connections").status_code == 401                 # password alone is not enough
    assert v.post("/api/auth/mfa", headers=H, json={"code": "123456"}).status_code == 401
    assert v.post("/api/auth/mfa", headers=H, json={"code": pyotp.TOTP(secret).now()}).status_code == 401   # replayed code
    assert v.post("/api/auth/mfa", headers=H, json={"code": codes[0]}).status_code == 200                   # recovery code
    assert v.get("/api/connections").status_code == 200
    w = TestClient(app)
    w.post("/api/auth/login", headers=H, json={"email": "ana@test.local", "password": "Str0ng-Passphrase"})
    assert w.post("/api/auth/mfa", headers=H, json={"code": codes[0]}).status_code == 401                   # single use

    # enforcing 2FA org-wide applies immediately, even to sessions already signed in
    client.put("/api/admin/settings", headers=H, json={"enforce_2fa": True})
    assert client.get("/api/auth/me").json()["requirements"] == ["setup_2fa"]
    assert client.get("/api/connections").status_code == 401
    admin_secret = client.post("/api/auth/2fa/setup", headers=H).json()["secret"]
    client.post("/api/auth/2fa/enable", headers=H, json={"code": pyotp.TOTP(admin_secret).now()})
    assert client.get("/api/connections").status_code == 200
    assert client.post("/api/auth/2fa/disable", headers=H, json={"password": "Admin-Passw0rd!", "code": "000000"}).status_code == 400
    client.put("/api/admin/settings", headers=H, json={"enforce_2fa": False})


def test_lockout(admin):
    from fastapi.testclient import TestClient
    from app.main import app
    client, _, _ = admin
    client.post("/api/admin/users", headers=H, json={"email": "lock@test.local", "role": "analyst"})
    u = TestClient(app)
    for _ in range(5):
        assert u.post("/api/auth/login", headers=H, json={"email": "lock@test.local", "password": "x"}).status_code == 401
    assert u.post("/api/auth/login", headers=H, json={"email": "lock@test.local", "password": "x"}).status_code == 423


# ---- ask -> SQL -> result -------------------------------------------------------------
def ask(client, conn, model, question, **kw):
    r = client.post("/api/chat/ask", headers=H, json={"connection_id": conn, "model_id": model, "question": question, **kw})
    assert r.status_code == 200, r.text
    return r.json()


def test_ask_runs_sql_and_summarises_locally(admin, fake_llm):
    client, conn, model = admin
    out = ask(client, conn, model, "What is revenue by category?")
    run = out["run"]
    assert run["status"] == "success" and run["row_count"] == 5
    assert [c["name"] for c in run["columns"]] == ["category", "revenue"]
    assert run["chart"]["type"] in ("bar", "doughnut") and run["summary"]["bullets"]
    assert len(run["followups"]) == 3 and run["input_tokens"] > 0 and run["cost"] > 0

    # follow-up in the same conversation carries prior question + SQL, never rows
    out2 = ask(client, conn, model, "and by region?", conversation_id=out["conversation"]["id"])
    assert out2["run"]["status"] == "success"
    sent = json.dumps(fake_llm.REQUESTS[-1])
    assert "What is revenue by category?" in sent and "order_items" in sent
    top_value = str(run["rows"][0][1])
    assert all(top_value not in json.dumps(req) for req in fake_llm.REQUESTS), "result data leaked to the model"
    assert all("@example.com" not in json.dumps(req) for req in fake_llm.REQUESTS)


def test_review_edit_and_feedback_become_training(admin):
    client, conn, model = admin
    out = ask(client, conn, model, "How many orders by status?", review_first=True)
    run = out["run"]
    assert run["status"] == "pending_review" and run["rows"] is None
    edited = "SELECT status, COUNT(*) AS n FROM orders WHERE status <> 'pending' GROUP BY status ORDER BY n DESC"
    done = client.post(f"/api/chat/runs/{run['id']}/execute", headers=H, json={"sql": edited}).json()
    assert done["status"] == "success" and done["edited"] and done["row_count"] == 3
    fb = client.post(f"/api/chat/runs/{run['id']}/feedback", headers=H, json={"verdict": "correct"}).json()
    assert fb["run"]["feedback"] == "corrected" and fb["training"] == "approved"
    pairs = client.get(f"/api/training/{conn}?kind=sql_pair").json()["items"]
    assert any(p["source"] == "correction" and "pending" in p["sql"] for p in pairs)
    # user-edited SQL goes through the same guard
    other = ask(client, conn, model, "count the orders", review_first=True)["run"]
    bad = client.post(f"/api/chat/runs/{other['id']}/execute", headers=H, json={"sql": "DROP TABLE orders"}).json()
    assert bad["status"] == "blocked"


def test_guard_blocks_model_written_dml_and_repair_loop(admin):
    client, conn, model = admin
    assert ask(client, conn, model, "please delete everything")["run"]["status"] == "blocked"
    fixed = ask(client, conn, model, "run the broken query")["run"]
    assert fixed["status"] == "success" and fixed["attempts"] == 2
    assert ask(client, conn, model, "what is the weather")["run"]["status"] == "clarification"
    assert client.get(f"/api/connections/{conn}/schema").json()["tables"]   # data intact


def test_masked_columns(admin):
    client, conn, model = admin
    c = next(x for x in client.get("/api/connections").json() if x["id"] == conn)
    client.put(f"/api/connections/{conn}", headers=H, json={**c, "masked_columns": ["email"]})
    run = ask(client, conn, model, "list customer email addresses")["run"]
    assert all(r[1] == "••••••" for r in run["rows"]) and run["rows"][0][0] != "••••••"
    run = ask(client, conn, model, "show the alias trick")["run"]
    assert all(r[1] == "••••••" for r in run["rows"])


def test_analyst_feedback_needs_approval_and_restricted_models(admin):
    from fastapi.testclient import TestClient
    from app.main import app
    client, conn, model = admin
    made = client.post("/api/admin/users", headers=H, json={"email": "bo@test.local", "role": "analyst"}).json()
    u = TestClient(app)
    u.post("/api/auth/login", headers=H, json={"email": "bo@test.local", "password": made["temporary_password"]})
    u.post("/api/auth/change-password", headers=H, json={"current": made["temporary_password"], "new": "Another-Passw0rd"})
    run = ask(u, conn, model, "Who are the top customers?")["run"]
    fb = u.post(f"/api/chat/runs/{run['id']}/feedback", headers=H, json={"verdict": "correct"}).json()
    assert fb["training"] == "pending"
    assert u.get(f"/api/training/{conn}").status_code == 403
    pending = client.get(f"/api/training/{conn}?status=pending").json()["items"]
    assert len(pending) == 1
    assert client.post(f"/api/training/item/{pending[0]['id']}/approve", headers=H).json()["status"] == "approved"
    # another user's run is invisible
    assert client.get(f"/api/chat/conversations/{run['conversation_id']}").status_code == 404
    # restricted data model: hidden until granted
    c = next(x for x in client.get("/api/connections").json() if x["id"] == conn)
    client.put(f"/api/connections/{conn}", headers=H, json={**c, "restricted": True})
    assert u.get("/api/connections").json() == []
    client.put(f"/api/connections/{conn}/access", headers=H, json={"user_ids": [made["id"]]})
    assert len(u.get("/api/connections").json()) == 1
    client.put(f"/api/connections/{conn}", headers=H, json={**c, "restricted": False})


def test_training_documents_and_imports(admin, fake_llm):
    client, conn, model = admin
    doc = b"Glossary\n\nAOV means average order value: revenue divided by the number of completed orders.\n\nChurn is not tracked."
    r = client.post(f"/api/training/{conn}/upload", headers=H, files={"upload": ("glossary.md", doc, "text/markdown")})
    assert r.json()["chunks"] >= 1
    csv_pairs = b"question,sql\nHow many customers?,SELECT COUNT(*) AS customers FROM customers\nBad one,DELETE FROM customers\n"
    r = client.post(f"/api/training/{conn}/import-pairs", headers=H, files={"upload": ("pairs.csv", csv_pairs, "text/csv")}).json()
    assert r["added"] == 1 and len(r["errors"]) == 1
    ask(client, conn, model, "What is our AOV (average order value)?")
    assert "average order value: revenue divided" in json.dumps(fake_llm.REQUESTS[-1])   # retrieved into the prompt


def test_analytics_and_exports(admin):
    client, conn, model = admin
    s = client.get("/api/analytics/summary?days=7").json()
    assert s["totals"]["queries"] >= 8 and s["totals"]["corrected"] >= 1 and s["by_model"][0]["label"] == "Fake"
    assert s["totals"]["self_repaired"] >= 1 and len(s["series"]) == 7
    q = client.get("/api/analytics/queries?status=blocked").json()["items"]
    assert q and client.get(f"/api/analytics/queries/{q[0]['id']}").json()["final_sql"]
    ok = client.get("/api/analytics/queries?status=success").json()["items"][0]
    x = client.get(f"/api/chat/runs/{ok['id']}/export.xlsx")
    assert x.status_code in (200, 404)        # 404 when the run belongs to another user
    assert "login.success" in client.get("/api/admin/audit.csv").text


def test_file_sandbox_cannot_reach_filesystem(admin):
    client, conn, model = admin
    out = ask(client, conn, model, "count orders", review_first=True)["run"]
    for sql in ("SELECT * FROM read_csv_auto('/etc/passwd')", "SELECT * FROM '/etc/passwd'"):
        r = client.post(f"/api/chat/runs/{out['id']}/execute", headers=H, json={"sql": sql}).json()
        assert r["status"] in ("blocked", "error") and not r["rows"]


def test_excel_folder_connection(admin):
    """A new Excel/CSV data model: upload a workbook, each sheet becomes a queryable table."""
    import io
    import openpyxl
    client, _, model = admin
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Budget 2025"
    ws.append(["Department", "Quarter", "Amount"])
    for row in (("Sales", "Q1", 1200.5), ("Sales", "Q2", 1300), ("Ops", "Q1", 800)):
        ws.append(row)
    wb.create_sheet("Notes").append(["note"])
    buf = io.BytesIO()
    wb.save(buf)
    conn = client.post("/api/connections", headers=H, json={"name": "Finance files", "db_type": "files", "config": {}}).json()
    r = client.post(f"/api/connections/{conn['id']}/files", headers=H, files=[
        ("uploads", ("Plan.xlsx", buf.getvalue(), "application/octet-stream")),
        ("uploads", ("targets.csv", b"region,target\nNorth,10\nSouth,20\n", "text/csv"))])
    assert r.json()["saved"] == ["Plan.xlsx", "targets.csv"]
    assert client.post(f"/api/connections/{conn['id']}/files", headers=H,
                       files=[("uploads", ("evil.exe", b"x", "application/octet-stream"))]).status_code == 400
    client.post(f"/api/connections/{conn['id']}/sync", headers=H)
    names = {t["name"] for t in client.get(f"/api/connections/{conn['id']}/schema").json()["tables"]}
    assert names == {"plan_budget_2025", "plan_notes", "targets"}
    run = ask(client, conn["id"], model, "anything", review_first=True)["run"]
    done = client.post(f"/api/chat/runs/{run['id']}/execute", headers=H, json={
        "sql": 'SELECT "Department", SUM("Amount") AS total FROM plan_budget_2025 GROUP BY 1 ORDER BY 1'}).json()
    assert done["rows"] == [["Ops", 800], ["Sales", 2500.5]]
    # training is per data model: the retail examples are not visible here
    assert client.get(f"/api/training/{conn['id']}").json()["items"] == []


def test_identifier_columns_are_categories_not_measures():
    from app.connectors import _package
    from app.summarize import suggest_chart, summarize
    roles = lambda r: {c["name"]: c["role"] for c in r["columns"]}       # noqa: E731
    wide = _package(["product_id", "product_name", "2024-01", "2024-02", "2024-03", "2024-04", "2024-05"],
                    [(101, "A", 1.5, 2, 3, 4, 5), (102, "B", 2, 3, 4, 5, 6)], 100, 1)
    assert roles(wide)["product_id"] == "dimension" and roles(wide)["2024-01"] == "measure"
    assert suggest_chart(wide["columns"], wide["rows"])["type"] == "table"          # pivot reads best as a table
    stats = {s["column"]: s for s in summarize(wide["columns"], wide["rows"], False)["stats"]}
    assert "sum" not in stats["product_id"] and stats["product_id"]["distinct"] == 2 and stats["2024-01"]["sum"] == 3.5
    mixed = _package(["Language", "Total_Impressions", "Total_Revenue"], [("en", 9e8, 1200.5), ("hi", 5e8, 800.0)], 100, 1)
    chart = suggest_chart(mixed["columns"], mixed["rows"])
    assert chart == {"type": "bar", "x": "Language", "y": ["Total_Impressions"]}    # never two scales on one axis
    names = ["CustomerID", "order_no", "fiscal_year", "order_count", "days_open", "zip", "unit_price"]
    r = _package(names, [(1, 10, 2025, 3, 4, 90210, 5), (2, 11, 2024, 5, 6, 10001, 7)], 100, 1)
    assert [roles(r)[n] for n in names] == ["dimension", "dimension", "dimension", "measure", "measure", "dimension", "measure"]
    yearly = _package(["order_year", "orders"], [(2023, 10), (2024, 12)], 100, 1)
    assert suggest_chart(yearly["columns"], yearly["rows"])["x"] == "order_year"


def test_rename_conversation(admin):
    client, conn, model = admin
    conv = ask(client, conn, model, "count orders please")["conversation"]
    assert client.put(f"/api/chat/conversations/{conv['id']}", headers=H, json={"title": "  Weekly order count "}).json()["ok"]
    assert any(c["title"] == "Weekly order count" for c in client.get("/api/chat/conversations").json())
