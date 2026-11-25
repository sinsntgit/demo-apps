"""Guardrails against changing a data source: no insert / update / delete, no change to table structure, descriptions or
other metadata, by any path. Layer 1: the read-only SQL check (sqlguard). Layer 2: the database session itself is
read-only (Postgres, MySQL, Oracle; refused if it cannot be), Excel/CSV queries always roll back. Layer 3: Test connection
says whether the database account could write. Layer 4: refused statements are audited.
The live-database half of these checks is in tests/test_postgres.py."""
import pytest

from app import connectors, security, sqlguard
from tests.conftest import H
from tests.test_platform import ask

MUST_BLOCK = [
    # data
    ("postgres", "INSERT INTO orders SELECT * FROM orders"), ("postgres", "UPDATE orders SET amount = 0"),
    ("postgres", "DELETE FROM orders"), ("postgres", "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE"),
    ("postgres", "TRUNCATE orders"), ("postgres", "WITH u AS (UPDATE orders SET amount = 0 RETURNING 1) SELECT * FROM u"),
    ("mysql", "REPLACE INTO t VALUES (1)"), ("mysql", "LOAD DATA INFILE 'x' INTO TABLE t"), ("mssql", "SELECT * INTO new_t FROM orders"),
    ("mssql", "BULK INSERT t FROM 'x'"), ("snowflake", "COPY INTO @stage FROM t"), ("oracle", "BEGIN DELETE FROM t; END;"),
    # structure
    ("postgres", "ALTER TABLE orders ADD COLUMN x int"), ("postgres", "ALTER TABLE orders RENAME TO o2"), ("postgres", "DROP VIEW v"),
    ("postgres", "CREATE INDEX i ON orders(id)"), ("mysql", "RENAME TABLE orders TO o2"), ("snowflake", "CREATE OR REPLACE TABLE t AS SELECT 1"),
    ("snowflake", "UNDROP TABLE t"), ("oracle", "FLASHBACK TABLE t TO BEFORE DROP"), ("mssql", "EXEC sp_rename 'orders', 'o2'"),
    ("postgres", "REFRESH MATERIALIZED VIEW mv"), ("postgres", "VACUUM orders"), ("postgres", "REINDEX TABLE orders"),
    # descriptions, permissions and other metadata
    ("postgres", "COMMENT ON TABLE orders IS 'x'"), ("postgres", "COMMENT ON COLUMN orders.amount IS 'x'"), ("oracle", "COMMENT ON TABLE orders IS 'x'"),
    ("mysql", "ALTER TABLE orders COMMENT = 'x'"), ("snowflake", "ALTER TABLE t SET COMMENT = 'x'"),
    ("mssql", "EXEC sp_addextendedproperty 'MS_Description', 'x'"), ("mssql", "EXECUTE sp_updateextendedproperty 'MS_Description', 'x'"),
    ("postgres", "GRANT SELECT ON orders TO public"), ("postgres", "REVOKE ALL ON orders FROM bob"), ("postgres", "SECURITY LABEL ON TABLE orders IS 'x'"),
    ("postgres", "ANALYZE orders"), ("oracle", "SELECT dbms_stats.gather_table_stats('a', 'b') FROM dual"), ("mssql", "DBCC CHECKIDENT ('orders', RESEED, 0)"),
    # changes made from inside a SELECT: sequences, locks, server administration, running SQL text
    ("postgres", "SELECT setval('orders_id_seq', 1)"), ("postgres", "SELECT nextval('orders_id_seq')"), ("oracle", "SELECT seq.NEXTVAL FROM dual"),
    ("snowflake", "SELECT seq1.nextval"), ("mssql", "SELECT NEXT VALUE FOR dbo.seq"), ("postgres", "SELECT lo_unlink(1)"),
    ("postgres", "SELECT pg_advisory_lock(1)"), ("postgres", "SELECT pg_reload_conf()"), ("postgres", "SELECT pg_notify('c', 'x')"),
    ("postgres", "SELECT pg_create_restore_point('x')"), ("postgres", "SELECT set_config('default_transaction_read_only', 'off', false)"),
    ("mysql", "SELECT GET_LOCK('x', 10)"), ("mssql", "SELECT * FROM t WITH (UPDLOCK)"), ("oracle", "SELECT utl_http.request('http://x') FROM dual"),
    ("snowflake", "SELECT SYSTEM$CANCEL_ALL_QUERIES(1)"), ("files", "SELECT * FROM query('DELETE FROM t')"), ("files", "SELECT nextval('s')"),
    ("files", "SELECT * FROM sniff_csv('x')"), ("postgres", "SELECT * FROM orders FOR UPDATE"), ("mysql", "SELECT * FROM t LOCK IN SHARE MODE"),
    # switching read-only off, procedures, several statements
    ("postgres", "SET default_transaction_read_only = off"), ("postgres", "BEGIN READ WRITE"), ("postgres", "SET TRANSACTION READ WRITE"),
    ("postgres", "RESET ALL"), ("mysql", "SET autocommit = 1"), ("postgres", "DO $$BEGIN DELETE FROM orders; END$$"), ("postgres", "CALL purge()"),
    ("snowflake", "EXECUTE IMMEDIATE 'delete from t'"), ("postgres", "SELECT 1; DELETE FROM orders"), ("postgres", "SELECT 1 /* ; */ ; DROP TABLE t"),
]

MUST_ALLOW = [
    ("postgres", "SELECT o.status, COUNT(*) AS n, SUM(o.amount) FROM orders o GROUP BY 1 ORDER BY 2 DESC"),
    ("postgres", "SELECT comment, query, lock_status, sequence_name FROM logs"),          # ordinary column names
    ("postgres", "SELECT 'please delete; drop table x; nextval' AS note"),               # words inside a quoted value
    ("postgres", "SELECT customer_id, ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) FROM orders"),
    ("mssql", "SELECT TOP 10 name FROM dbo.customers WITH (NOLOCK) ORDER BY name"),
    ("oracle", "SELECT sysdate, user FROM dual"), ("snowflake", "SELECT current_role(), current_warehouse()"),
    ("files", "SELECT * FROM duckdb_settings()"), ("mysql", "SELECT `comment` FROM t LIMIT 5"),
]


@pytest.mark.parametrize("db_type,sql", MUST_BLOCK)
def test_the_read_only_check_refuses_every_change(db_type, sql):
    with pytest.raises(sqlguard.SQLBlocked):
        sqlguard.check(sql, db_type)


@pytest.mark.parametrize("db_type,sql", MUST_ALLOW)
def test_ordinary_questions_still_run(db_type, sql):
    assert sqlguard.check(sql, db_type).sql


def _conn(client, name):
    from app.db import SessionLocal
    from app.models import Connection
    cid = next(c["id"] for c in client.get("/api/connections").json() if c["name"] == name)
    with SessionLocal() as db:
        c = db.get(Connection, cid)
        db.expunge(c)
        return c


def test_file_data_models_roll_back_anything_that_slips_through(admin):
    """Layer 2 for Excel/CSV: even a statement that got past the check (run here directly) changes nothing."""
    client, _, _ = admin
    c = _conn(client, "Sample: Retail sales")
    cfg = security.decrypt_json(c.config_enc)
    before = connectors.run_query(c, cfg, "SELECT COUNT(*), COUNT(DISTINCT region) FROM customers", 5, 10)["rows"]
    for bad in ("UPDATE customers SET region = 'X'", "DELETE FROM customers", "CREATE TABLE extra AS SELECT 1 AS a",
                "ALTER TABLE customers ADD COLUMN x INTEGER", "COMMENT ON TABLE customers IS 'changed'"):
        try:
            connectors.run_query(c, cfg, bad, 5, 10)
        except connectors.ConnectorError:
            pass
    assert connectors.run_query(c, cfg, "SELECT COUNT(*), COUNT(DISTINCT region) FROM customers", 5, 10)["rows"] == before
    tables = connectors.run_query(c, cfg, "SELECT table_name, comment FROM duckdb_tables() ORDER BY 1", 50, 10)["rows"]
    assert "extra" not in [t[0] for t in tables] and all(t[1] in (None, "") for t in tables)
    cols = connectors.run_query(c, cfg, "SELECT column_name FROM information_schema.columns WHERE table_name = 'customers'", 50, 10)["rows"]
    assert ["x"] not in cols


def test_a_session_that_cannot_be_read_only_is_refused(monkeypatch):
    """Fail closed: if the database does not confirm a read-only session, the query is not run."""
    class FakeConn:
        id, db_type, updated_at = 991, "postgres", None
    monkeypatch.setitem(connectors._READ_ONLY_CHECK, "postgres", ("SELECT 'off'", "on"))

    class Res:
        def scalar(self):
            return "off"

    class C:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def exec_driver_sql(self, sql):
            return Res()

        def rollback(self):
            pass

        def execute(self, *a):
            raise AssertionError("the query must not run")

    class Eng:
        def connect(self):
            return C()
    monkeypatch.setattr(connectors, "_engine", lambda *a: Eng())
    with pytest.raises(connectors.ConnectorError, match="read-only session"):
        connectors.run_query(FakeConn(), {}, "SELECT 1", 5, 5)


def test_connection_test_reports_write_access_and_refusals_are_audited(admin):
    client, conn, model = admin
    r = client.post(f"/api/connections/{conn}/test", headers=H).json()
    assert r["ok"] and r["write_access"] == {"can_write": False, "detail": "Files are read into memory; AskData never changes them."}
    run = ask(client, conn, model, "delete everything")["run"]
    assert run["status"] == "blocked"
    items = client.get("/api/admin/audit", params={"action": "query.blocked"}).json()["items"]
    assert any(f"run #{run['id']}" in i["detail"] for i in items)
