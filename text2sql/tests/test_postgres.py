"""Live-database checks. Skipped unless T2S_TEST_PG is set, e.g.
T2S_TEST_PG=reader:r3ader@127.0.0.1:5544/shop python -m pytest tests/test_postgres.py"""
import os
import re

import pytest

from tests.conftest import FAKE_PORT, H
from tests.test_platform import ask

DSN = os.environ.get("T2S_TEST_PG")
pytestmark = pytest.mark.skipif(not DSN, reason="T2S_TEST_PG not set")


@pytest.fixture(scope="module")
def pg(admin):
    client, _, model = admin
    user, pw, host, port, db = re.match(r"(.+?):(.+?)@(.+?):(\d+)/(.+)", DSN).groups()
    conn = client.post("/api/connections", headers=H, json={
        "name": "PG shop", "db_type": "postgres", "masked_columns": ["email"], "allow_samples": True,
        "sample_columns": ["orders.status"],
        "config": {"host": host, "port": port, "database": db, "username": user, "password": pw}}).json()
    return client, conn["id"], model


def test_connect_sync_and_secrets_hidden(pg):
    client, conn, _ = pg
    assert client.post(f"/api/connections/{conn}/test", headers=H).json()["ok"]
    assert client.post(f"/api/connections/{conn}/sync", headers=H).json() == {"tables": 2, "columns": 10}
    tables = {t["name"]: t for t in client.get(f"/api/connections/{conn}/schema").json()["tables"]}
    ddl = tables["orders"]["ddl"]
    assert "customer_id INTEGER REFERENCES customers(customer_id)" in ddl and "Order value in GBP" in ddl
    assert "values: 'cancelled', 'completed', 'pending'" in ddl      # opted-in samples only
    assert "samples" not in str(tables["customers"])
    listed = next(c for c in client.get("/api/connections").json() if c["id"] == conn)
    assert listed["config"]["password"] == "" and listed["has_password"]


def test_query_with_colons_percent_and_types(pg, fake_llm):
    client, conn, model = pg
    run = ask(client, conn, model, "pg time check")["run"]
    assert run["status"] == "success", run["error"]
    assert [c["type"] for c in run["columns"]] == ["string", "number", "number"]
    assert {r[0] for r in run["rows"]} == {"cancelled", "completed"}
    import json
    sent = json.dumps(fake_llm.REQUESTS[-1])
    assert "values: 'cancelled', 'completed', 'pending'" in sent      # opted-in sample values reach the prompt
    assert "@x.com" not in sent and "Cust 1" not in sent              # nothing else does


def test_database_itself_rejects_writes(pg):
    """Defence in depth: even SQL that slipped past the guard cannot write (read-only session + SELECT-only role)."""
    from app import connectors, security
    from app.db import SessionLocal
    from app.models import Connection
    client, conn, model = pg
    assert ask(client, conn, model, "pg write attempt")["run"]["status"] == "blocked"
    with SessionLocal() as db:
        c = db.get(Connection, conn)
        with pytest.raises(connectors.ConnectorError):
            connectors.run_query(c, security.decrypt_json(c.config_enc), "UPDATE orders SET amount = 0", 10, 10)
        with pytest.raises(connectors.ConnectorError):       # server-side statement timeout
            connectors.run_query(c, security.decrypt_json(c.config_enc), "SELECT pg_sleep(30)", 10, 2)


def test_claude_provider_path(pg):
    """Anthropic SDK request is well-formed (system prompt, caching, effort) against a local stand-in."""
    client, conn, _ = pg
    m = client.post("/api/admin/models", headers=H, json={
        "name": "Claude (stand-in)", "provider": "anthropic", "model_id": "claude-opus-5-5", "api_key": "sk-test",
        "base_url": f"http://127.0.0.1:{FAKE_PORT}", "effort": "medium", "price_in": 4, "price_out": 20}).json()
    assert client.post(f"/api/admin/models/{m['id']}/test", headers=H).json()["ok"]
    run = ask(client, conn, m["id"], "orders by status")["run"]
    assert run["status"] == "success" and run["input_tokens"] == 900 and run["cost"] == pytest.approx(0.0048)
    emails = ask(client, conn, m["id"], "customer email list")["run"]
    assert emails["status"] == "success" and all(r[1] == "••••••" for r in emails["rows"])
