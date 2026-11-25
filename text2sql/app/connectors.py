"""Source database connectors: connect, introspect schema, run read-only queries.

Query results are returned to the caller (the web UI) only - nothing in this module
talks to a language model.
"""
import concurrent.futures
import datetime as dt
import decimal
import math
import re
import threading
import time
import uuid
from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import URL

from . import config

F = lambda key, label, **kw: {"key": key, "label": label, **kw}   # noqa: E731
_HOST = [F("host", "Host", required=True), F("port", "Port", type="number")]
_AUTH = [F("username", "Username", required=True), F("password", "Password", type="password", secret=True)]

DB_TYPES = {
    "postgres": {"label": "PostgreSQL", "driver": "psycopg2-binary", "fields": [
        *_HOST, F("database", "Database", required=True), *_AUTH,
        F("schemas", "Schemas (comma separated)", placeholder="public"),
        F("sslmode", "SSL mode", placeholder="prefer")]},
    "mysql": {"label": "MySQL", "driver": "pymysql", "fields": [
        *_HOST, F("database", "Database", required=True), *_AUTH, F("ssl", "Require TLS", type="checkbox")]},
    "singlestore": {"label": "SingleStore", "driver": "pymysql", "fields": [
        *_HOST, F("database", "Database", required=True), *_AUTH, F("ssl", "Require TLS", type="checkbox")]},
    "mssql": {"label": "Microsoft SQL Server", "driver": "pymssql", "fields": [
        *_HOST, F("database", "Database", required=True), *_AUTH,
        F("schemas", "Schemas (comma separated)", placeholder="dbo")]},
    "oracle": {"label": "Oracle", "driver": "oracledb", "fields": [
        *_HOST, F("service_name", "Service name", required=True), *_AUTH,
        F("schemas", "Schemas / owners (comma separated)", placeholder="defaults to the user")]},
    "snowflake": {"label": "Snowflake", "driver": "snowflake-sqlalchemy", "fields": [
        F("account", "Account identifier", required=True, placeholder="orgname-account"),
        *_AUTH, F("database", "Database", required=True), F("warehouse", "Warehouse", required=True),
        F("role", "Role"), F("schemas", "Schemas (comma separated)", placeholder="PUBLIC")]},
    "files": {"label": "Excel / CSV folder", "driver": "duckdb", "fields": [
        F("folder", "Folder path on the server", placeholder="leave blank to upload files here")]},
    # not a database: two or more data models answered together (app/matching.py, routers/combined.py)
    "combined": {"label": "Combined data model", "driver": "", "fields": []},
}
DEFAULT_PORT = {"postgres": 5432, "mysql": 3306, "singlestore": 3306, "mssql": 1433, "oracle": 1521}
DIALECT_NAME = {
    "postgres": "PostgreSQL", "mysql": "MySQL", "singlestore": "SingleStore (MySQL-compatible)",
    "mssql": "Microsoft SQL Server (T-SQL)", "oracle": "Oracle", "snowflake": "Snowflake", "files": "DuckDB",
    "combined": "DuckDB",
}
NOT_A_SOURCE = "A combined data model has no database of its own: it uses the data models it combines."
SECRET_FIELDS = {"password"}


class ConnectorError(Exception):
    pass


class QueryTimeout(ConnectorError):
    pass


_pool = concurrent.futures.ThreadPoolExecutor(max_workers=16, thread_name_prefix="query")
_engines: dict = {}
_duck: dict = {}
_lock = threading.Lock()


def _clean_error(e: Exception) -> str:
    msg = str(getattr(e, "orig", None) or e)
    msg = re.sub(r"\(Background on this error at:.*?\)", "", msg, flags=re.S)
    msg = re.sub(r"\[SQL:.*", "", msg, flags=re.S)
    return msg.strip()[:1500]


def _schemas(cfg) -> list[str | None]:
    names = [s.strip() for s in (cfg.get("schemas") or "").split(",") if s.strip()]
    return names or [None]


# ---- SQLAlchemy engines -------------------------------------------------------------
def _make_engine(db_type: str, cfg: dict, timeout_s: int):
    port = int(cfg.get("port") or DEFAULT_PORT.get(db_type, 0)) or None
    user, pw, host, database = cfg.get("username"), cfg.get("password"), cfg.get("host"), cfg.get("database")
    try:
        if db_type == "postgres":
            import psycopg2  # noqa: F401
            url = URL.create("postgresql+psycopg2", user, pw, host, port, database)
            args = {"connect_timeout": 10, "application_name": "text2sql",
                    "options": f"-c default_transaction_read_only=on -c statement_timeout={timeout_s * 1000}"}
            if cfg.get("sslmode"):
                args["sslmode"] = cfg["sslmode"]
        elif db_type in ("mysql", "singlestore"):
            import pymysql  # noqa: F401
            url = URL.create("mysql+pymysql", user, pw, host, port, database)
            args = {"connect_timeout": 10, "read_timeout": timeout_s + 5}
            if cfg.get("ssl"):
                args["ssl"] = {"check_hostname": False}
        elif db_type == "mssql":
            import pymssql  # noqa: F401
            url = URL.create("mssql+pymssql", user, pw, host, port, database)
            args = {"login_timeout": 10, "timeout": timeout_s}
        elif db_type == "oracle":
            import oracledb  # noqa: F401
            url = URL.create("oracle+oracledb", user, pw, host, port, query={"service_name": cfg.get("service_name", "")})
            args = {}
        elif db_type == "snowflake":
            from snowflake.sqlalchemy import URL as SFURL
            parts = {k: cfg[k] for k in ("account", "database", "warehouse", "role") if cfg.get(k)}
            url = SFURL(user=user, password=pw or "", **parts)
            args = {"session_parameters": {"STATEMENT_TIMEOUT_IN_SECONDS": timeout_s, "QUERY_TAG": "text2sql"},
                    "login_timeout": 15}
        else:
            raise ConnectorError(f"Unknown database type: {db_type}")
    except ImportError:
        raise ConnectorError(f"The {DB_TYPES[db_type]['label']} driver is not installed on the server. "
                             f"Install it with: pip install {DB_TYPES[db_type]['driver']}")
    return create_engine(url, connect_args=args, pool_size=3, max_overflow=5, pool_pre_ping=True, pool_recycle=1800)


def _engine(conn_id, db_type, cfg, timeout_s, stamp):
    key = (conn_id, stamp, timeout_s)
    with _lock:
        if key not in _engines:
            for k in [k for k in _engines if k[0] == conn_id]:
                _engines.pop(k).dispose()
            _engines[key] = _make_engine(db_type, cfg, timeout_s)
        return _engines[key]


def forget(conn_id):
    with _lock:
        for k in [k for k in _engines if k[0] == conn_id]:
            _engines.pop(k).dispose()
        _duck.pop(conn_id, None)


# Read-only sessions, the database's own guarantee behind the SQL check: if one cannot be switched on, the query is refused
# (never run without it). Postgres starts every session read-only (connect options) and that is verified per query.
_READ_ONLY = {
    "mysql": ["SET SESSION TRANSACTION READ ONLY"],
    "oracle": ["SET TRANSACTION READ ONLY"],
}
_READ_ONLY_CHECK = {"postgres": ("SHOW transaction_read_only", "on")}
# optional session settings (time limits, isolation): best effort
_SESSION_SETUP = {
    "mysql": ["SET SESSION MAX_EXECUTION_TIME={ms}"],
    "mssql": ["SET TRANSACTION ISOLATION LEVEL READ COMMITTED"],
}
READ_ONLY_FAILED = ("The database did not accept a read-only session, so the query was not run. AskData only runs queries "
                    "in read-only mode on {db}. Ask the database administrator to check the account, or use a read-only replica.")


# ---- Excel / CSV folders via DuckDB -------------------------------------------------
def files_folder(conn_id, cfg) -> Path:
    if cfg.get("folder"):
        return Path(cfg["folder"]).expanduser()
    p = config.FILES_DIR / str(conn_id)
    p.mkdir(parents=True, exist_ok=True)
    return p


def clear_managed_folder(conn_id: int) -> None:
    """Remove the app-managed upload folder of a data model (never a server folder an admin pointed it at).
    Database ids can be reused after a delete (SQLite), so a new data model must never start with an old one's files."""
    import shutil
    p = config.FILES_DIR / str(conn_id)
    if p.is_dir():
        shutil.rmtree(p, ignore_errors=True)


def _ident(name: str) -> str:
    s = re.sub(r"\W+", "_", name.strip().lower()).strip("_") or "t"
    return ("t_" + s) if s[0].isdigit() else s


FILE_EXT = {".csv", ".tsv", ".txt", ".xlsx", ".xlsm", ".xls", ".parquet"}


def _duck_db(conn_id, cfg):
    """An in-memory DuckDB holding one table per CSV file / Excel sheet. Reloaded when files change."""
    import duckdb
    folder = files_folder(conn_id, cfg)
    if not folder.is_dir():
        raise ConnectorError(f"Folder not found on the server: {folder}")
    files = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in FILE_EXT)
    sig = tuple((p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in files)
    with _lock:
        cached = _duck.get(conn_id)
        if cached and cached[0] == sig:
            return cached[1]
    con = duckdb.connect(":memory:")
    used: set[str] = set()

    def unique(name):
        base, n = name, 2
        while name in used:
            name, n = f"{base}_{n}", n + 1
        used.add(name)
        return name

    errors = []
    for p in files:
        ext = p.suffix.lower()
        try:
            if ext in (".csv", ".tsv", ".txt"):
                con.execute(f'CREATE TABLE "{unique(_ident(p.stem))}" AS SELECT * FROM read_csv_auto(?, sample_size=20000)', [str(p)])
            elif ext == ".parquet":
                con.execute(f'CREATE TABLE "{unique(_ident(p.stem))}" AS SELECT * FROM read_parquet(?)', [str(p)])
            else:
                import pandas as pd
                sheets = pd.read_excel(p, sheet_name=None)
                for sheet, df in sheets.items():
                    if df.empty and not len(df.columns):
                        continue
                    df.columns = [str(c).strip() for c in df.columns]
                    name = unique(_ident(p.stem if len(sheets) == 1 else f"{p.stem}_{sheet}"))
                    con.register("_df", df)
                    con.execute(f'CREATE TABLE "{name}" AS SELECT * FROM _df')
                    con.unregister("_df")
        except Exception as e:   # one bad file must not hide the rest
            errors.append(f"{p.name}: {str(e)[:200]}")
    # Lock the sandbox: queries can only see the loaded tables, never the filesystem.
    con.execute("SET enable_external_access=false")
    con.execute("SET lock_configuration=true")
    with _lock:
        _duck[conn_id] = (sig, con, errors)
    return con


def list_files(conn_id, cfg) -> list[dict]:
    folder = files_folder(conn_id, cfg)
    if not folder.is_dir():
        return []
    return [{"name": p.name, "size": p.stat().st_size,
             "modified": dt.datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds")}
            for p in sorted(folder.iterdir()) if p.is_file() and p.suffix.lower() in FILE_EXT]


# ---- value conversion -------------------------------------------------------------
def _jsonable(v):
    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, decimal.Decimal):
        if not v.is_finite():
            return None
        return int(v) if v == v.to_integral_value() and abs(v) < 2**53 else float(v)
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat(sep=" ") if isinstance(v, dt.datetime) else v.isoformat()
    if isinstance(v, dt.timedelta):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return "0x" + bytes(v)[:32].hex()
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, (list, tuple, dict, set)):
        return str(v)[:2000]
    if hasattr(v, "item"):          # numpy scalars
        try:
            return _jsonable(v.item())
        except Exception:
            pass
    return str(v)[:2000]


def _col_type(values) -> str:
    seen = [v for v in values if v is not None][:200]
    if not seen:
        return "string"
    if all(isinstance(v, bool) for v in seen):
        return "boolean"
    if all(isinstance(v, (int, float, decimal.Decimal)) and not isinstance(v, bool) for v in seen):
        return "number"
    if all(isinstance(v, (dt.datetime, dt.date)) for v in seen):
        return "date"
    return "string"


# Numeric columns that label things rather than measure them: never summed or averaged.
_ID_SUFFIX = re.compile(r"(?:^|[_\s.])(id|ids|key|code|no|nr|num|number|zip|zipcode|postcode|pincode|pin|sku|year|yr|"
                        r"month|mon|week|day|quarter|qtr|fy|period|rank|version)$", re.I)
_ID_CAMEL = re.compile(r"[a-z0-9](Id|ID|Key|Code|No|Num|Year|Month)$")
_MEASURE_WORD = re.compile(r"(count|total|sum|avg|average|amount|qty|quantity|revenue|sales|price|cost|per_|pct|percent|"
                           r"rate|ratio|score|days|months|years|number_of|num_|no_of)", re.I)


def column_role(name: str, col_type: str, values) -> str:
    """'measure' = a quantity that can be added up; 'dimension' = a label / category / identifier."""
    if col_type != "number":
        return "dimension"
    whole = all(isinstance(v, int) or (isinstance(v, (float, decimal.Decimal)) and v == int(v))
                for v in values if v is not None)
    if whole and (_ID_SUFFIX.search(name) or _ID_CAMEL.search(name)) and not _MEASURE_WORD.search(name):
        return "dimension"
    return "measure"


def _package(names, raw_rows, max_rows, ms):
    truncated = len(raw_rows) > max_rows
    raw_rows = raw_rows[:max_rows]
    cols = []
    for i, n in enumerate(names):
        vals = [r[i] for r in raw_rows]
        typ = _col_type(vals)
        cols.append({"name": str(n), "type": typ, "role": column_role(str(n), typ, vals[:500])})
    from .summarize import enrich
    enrich(cols)            # marks averages / rates / prices as non-additive
    rows = [[_jsonable(v) for v in r] for r in raw_rows]
    for r in rows:
        for i, v in enumerate(r):
            if isinstance(v, str) and len(v) > 2000:
                r[i] = v[:2000] + "..."
    return {"columns": cols, "rows": rows, "truncated": truncated, "ms": ms}


# ---- public API -------------------------------------------------------------------
def run_query(conn, cfg: dict, sql: str, max_rows: int, timeout_s: int) -> dict:
    """Run an already-guarded SELECT. Returns {columns, rows, truncated, ms}."""
    if conn.db_type == "combined":
        raise ConnectorError(NOT_A_SOURCE)
    def work():
        t0 = time.time()
        if conn.db_type == "files":
            cur = _duck_db(conn.id, cfg).cursor()
            holder["cancel"] = cur.interrupt
            cur.execute("BEGIN TRANSACTION")      # always rolled back: nothing can change the loaded tables
            try:
                cur.execute(sql)
                names = [d[0] for d in cur.description or []]
                rows = cur.fetchmany(max_rows + 1)
            finally:
                try:
                    cur.execute("ROLLBACK")
                finally:
                    cur.close()
        else:
            eng = _engine(conn.id, conn.db_type, cfg, timeout_s, conn.updated_at)
            with eng.connect() as c:
                for stmt in _SESSION_SETUP.get(conn.db_type, []):
                    try:
                        c.exec_driver_sql(stmt.format(ms=timeout_s * 1000))
                    except Exception:
                        c.rollback()
                try:
                    for stmt in _READ_ONLY.get(conn.db_type, []):
                        c.exec_driver_sql(stmt)
                    probe = _READ_ONLY_CHECK.get(conn.db_type)
                    if probe and str(c.exec_driver_sql(probe[0]).scalar()).lower() != probe[1]:
                        raise ValueError("not read-only")
                except Exception:
                    c.rollback()
                    raise ConnectorError(READ_ONLY_FAILED.format(db=DB_TYPES[conn.db_type]["label"]))
                if conn.db_type == "oracle":
                    try:
                        c.connection.driver_connection.call_timeout = timeout_s * 1000
                    except Exception:
                        pass
                # escape ':' so literals such as '12:30' are not read as bind parameters
                res = c.execute(text(re.sub(r"(?<!:):(?!:)", r"\\:", sql)))
                names = list(res.keys())
                rows = res.fetchmany(max_rows + 1)
                c.rollback()
        return _package(names, rows, max_rows, int((time.time() - t0) * 1000))

    holder: dict = {}
    fut = _pool.submit(work)
    try:
        return fut.result(timeout=timeout_s + 5)
    except concurrent.futures.TimeoutError:
        if holder.get("cancel"):
            try:
                holder["cancel"]()
            except Exception:
                pass
        raise QueryTimeout(f"Query exceeded the {timeout_s}s time limit and was cancelled.")
    except ConnectorError:
        raise
    except Exception as e:
        raise ConnectorError(_clean_error(e))


_WRITE_PROBE = {
    "postgres": "SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user), "
                "(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm') "
                "AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' "
                "AND (pg_has_role(c.relowner, 'USAGE') OR has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE'))), "
                "(SELECT count(*) FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') "
                "AND n.nspname NOT LIKE 'pg\\_%' AND has_schema_privilege(n.oid, 'CREATE'))",
    "mysql": "SHOW GRANTS", "singlestore": "SHOW GRANTS",
    "mssql": "SELECT IS_SRVROLEMEMBER('sysadmin'), IS_ROLEMEMBER('db_owner'), IS_ROLEMEMBER('db_datawriter'), IS_ROLEMEMBER('db_ddladmin'), "
             "HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT'), HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE'), "
             "HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE'), HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER')",
    "oracle": "SELECT (SELECT COUNT(*) FROM user_tables), (SELECT COUNT(*) FROM session_privs WHERE privilege IN ('INSERT ANY TABLE', "
              "'UPDATE ANY TABLE', 'DELETE ANY TABLE', 'DROP ANY TABLE', 'ALTER ANY TABLE', 'CREATE ANY TABLE', 'CREATE TABLE', "
              "'COMMENT ANY TABLE')), (SELECT COUNT(*) FROM user_tab_privs WHERE privilege IN ('INSERT', 'UPDATE', 'DELETE', 'ALTER')) FROM dual",
}


def write_access(conn, cfg) -> dict:
    """Could this database account change data, structure or descriptions if AskData ever let a statement through?
    {"can_write": True | False | None (not known), "detail": "..."}. Read-only probes of the account's own privileges."""
    if conn.db_type == "files":
        return {"can_write": False, "detail": "Files are read into memory; AskData never changes them."}
    sql = _WRITE_PROBE.get(conn.db_type)
    if not sql:
        return {"can_write": None, "detail": "AskData cannot check this database's privileges automatically. Make sure the account "
                                             "may only read (SELECT): no INSERT, UPDATE, DELETE, CREATE, ALTER or OWNERSHIP."}
    try:
        rows = run_query(conn, cfg, sql, 200, 15)["rows"]
    except ConnectorError as e:
        return {"can_write": None, "detail": f"The account's privileges could not be checked ({e})."}
    found = []
    if conn.db_type == "postgres":
        su, tables, schemas = rows[0]
        if su:
            found.append("it is a superuser")
        if tables:
            found.append(f"it can change or owns {tables} table(s) or view(s)")
        if schemas:
            found.append(f"it can create tables in {schemas} schema(s)")
    elif conn.db_type in ("mysql", "singlestore"):
        grants = " ".join(str(r[0]) for r in rows).upper()
        hits = sorted(set(re.findall(r"\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|INDEX|TRIGGER|REFERENCES)\b", grants)))
        if hits:
            found.append("its grants include " + ", ".join(hits))
    elif conn.db_type == "mssql":
        names = ["sysadmin", "db_owner", "db_datawriter", "db_ddladmin", "INSERT", "UPDATE", "DELETE", "ALTER"]
        hits = [n for n, v in zip(names, rows[0]) if v == 1]
        if hits:
            found.append("it has " + ", ".join(hits))
    elif conn.db_type == "oracle":
        own, sys_privs, obj_privs = rows[0]
        if own:
            found.append(f"it owns {own} table(s)")
        if sys_privs:
            found.append(f"it has {sys_privs} system privilege(s) that change tables")
        if obj_privs:
            found.append(f"it may change {obj_privs} table(s) of other users")
    if found:
        return {"can_write": True, "detail": "This database account could change data or structure: " + "; ".join(found) + ". "
                "AskData never sends anything but read-only queries, but a read-only account (SELECT only) is the strongest guarantee."}
    return {"can_write": False, "detail": "The account can only read."}


def test(conn, cfg) -> str:
    if conn.db_type == "combined":
        raise ConnectorError(NOT_A_SOURCE)
    probe = {"oracle": "SELECT 1 FROM dual"}.get(conn.db_type, "SELECT 1")
    if conn.db_type == "files":
        con = _duck_db(conn.id, cfg)
        n = con.cursor().execute("SELECT count(*) FROM information_schema.tables").fetchone()[0]
        errs = _duck[conn.id][2]
        return f"OK - {n} table(s) loaded from files." + (f" Skipped: {'; '.join(errs)}" if errs else "")
    run_query(conn, cfg, probe, 1, 15)
    return "Connection successful."


def introspect(conn, cfg, timeout_s=120) -> dict:
    """Read table/column metadata (never row data, unless sample columns were opted in)."""
    if conn.db_type == "combined":
        raise ConnectorError(NOT_A_SOURCE)
    def work():
        tables = []
        if conn.db_type == "files":
            cur = _duck_db(conn.id, cfg).cursor()
            cols = cur.execute("SELECT table_name, column_name, data_type FROM information_schema.columns "
                               "ORDER BY table_name, ordinal_position").fetchall()
            by: dict = {}
            for t, c, typ in cols:
                by.setdefault(t, []).append({"name": c, "type": typ, "nullable": True, "pk": False, "comment": ""})
            tables = [{"schema": None, "name": t, "type": "table", "comment": "", "columns": c, "fks": []}
                      for t, c in by.items()]
        else:
            eng = _engine(conn.id, conn.db_type, cfg, timeout_s, conn.updated_at)
            insp = inspect(eng)
            for schema in _schemas(cfg):
                names = [(n, "table") for n in insp.get_table_names(schema=schema)]
                try:
                    names += [(n, "view") for n in insp.get_view_names(schema=schema)]
                except Exception:
                    pass
                for name, kind in names[:2000]:
                    try:
                        cols = insp.get_columns(name, schema=schema)
                    except Exception:
                        continue
                    pk = set()
                    fks = []
                    comment = ""
                    try:
                        pk = set(insp.get_pk_constraint(name, schema=schema).get("constrained_columns") or [])
                        for fk in insp.get_foreign_keys(name, schema=schema):
                            fks.append({"columns": fk["constrained_columns"], "ref_table": fk["referred_table"],
                                        "ref_schema": fk.get("referred_schema"), "ref_columns": fk["referred_columns"]})
                        comment = (insp.get_table_comment(name, schema=schema) or {}).get("text") or ""
                    except Exception:
                        pass
                    tables.append({
                        "schema": schema, "name": name, "type": kind, "comment": comment, "fks": fks,
                        "columns": [{"name": c["name"], "type": str(c["type"]) if c.get("type") is not None else "",
                                     "nullable": bool(c.get("nullable", True)), "pk": c["name"] in pk,
                                     "comment": c.get("comment") or ""} for c in cols]})
        return {"tables": tables}

    try:
        schema = _pool.submit(work).result(timeout=timeout_s + 10)
    except concurrent.futures.TimeoutError:
        raise QueryTimeout("Reading the schema timed out.")
    except ConnectorError:
        raise
    except Exception as e:
        raise ConnectorError(_clean_error(e))

    if conn.allow_samples and conn.sample_columns:
        _add_samples(conn, cfg, schema)
    return schema


def _quote(db_type, name):
    if db_type in ("mysql", "singlestore"):
        return "`" + name.replace("`", "``") + "`"
    if db_type == "mssql":
        return "[" + name.replace("]", "]]") + "]"
    return '"' + name.replace('"', '""') + '"'


def _add_samples(conn, cfg, schema):
    """Opt-in only: distinct values of admin-chosen low-cardinality columns (e.g. status codes)."""
    wanted = {s.lower() for s in conn.sample_columns}
    for t in schema["tables"]:
        for c in t["columns"]:
            if f"{t['name']}.{c['name']}".lower() not in wanted:
                continue
            tbl = ".".join(_quote(conn.db_type, p) for p in (t["schema"], t["name"]) if p)
            col = _quote(conn.db_type, c["name"])
            try:
                res = run_query(conn, cfg, f"SELECT DISTINCT {col} FROM {tbl}", 21, 20)
                if not res["truncated"]:
                    c["samples"] = sorted(str(r[0])[:60] for r in res["rows"] if r[0] is not None)
            except ConnectorError:
                pass


def table_fqn(t) -> str:
    return ".".join(p for p in (t.get("schema"), t["name"]) if p)


def table_ddl(t) -> str:
    """Compact CREATE TABLE text used in prompts and shown in the UI."""
    fk_by_col = {}
    for fk in t.get("fks", []):
        if len(fk["columns"]) == 1:
            fk_by_col[fk["columns"][0]] = f"{fk['ref_table']}({fk['ref_columns'][0]})"
    lines = []
    for c in t["columns"]:
        line = f"  {c['name']} {c['type']}".rstrip()
        if c.get("pk"):
            line += " PRIMARY KEY"
        if c["name"] in fk_by_col:
            line += f" REFERENCES {fk_by_col[c['name']]}"
        notes = []
        if c.get("comment"):
            notes.append(c["comment"])
        if c.get("samples"):
            notes.append("values: " + ", ".join(repr(s) for s in c["samples"]))
        lines.append(line + "," + (f"  -- {'; '.join(notes)}" if notes else ""))
    head = f"CREATE {'VIEW' if t.get('type') == 'view' else 'TABLE'} {table_fqn(t)} ("
    if t.get("comment"):
        head += f"  -- {t['comment']}"
    return head + "\n" + "\n".join(lines) + "\n);"


SQLGLOT_DIALECT = {"postgres": "postgres", "mysql": "mysql", "singlestore": "mysql", "mssql": "tsql", "oracle": "oracle",
                   "snowflake": "snowflake", "files": "duckdb"}


def distinct_values_sql(conn, table: dict, column: str, limit: int) -> str:
    """SELECT DISTINCT <column> FROM <table> WHERE <column> IS NOT NULL, limited, written by sqlglot in the source's
    dialect from schema names only (nothing typed by a user or a model is pasted in)."""
    import sqlglot
    from sqlglot import exp
    q_ = lambda n: exp.to_identifier(n, quoted=not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", n))   # quote only when needed
    tb = exp.Table(this=q_(table["name"]), db=q_(table["schema"]) if table.get("schema") else None)
    col = exp.Column(this=q_(column))
    q = sqlglot.select(col).distinct().from_(tb).where(exp.Not(this=exp.Is(this=col.copy(), expression=exp.Null()))).limit(limit)
    return q.sql(dialect=SQLGLOT_DIALECT.get(conn.db_type, "duckdb"))


def count_sql(conn, table: dict, column: str) -> str:
    """SELECT COUNT(<column>) AS n, COUNT(DISTINCT <column>) AS d FROM <table>: is the column unique (one row per value)?"""
    import sqlglot
    from sqlglot import exp
    q_ = lambda n: exp.to_identifier(n, quoted=not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", n))
    tb = exp.Table(this=q_(table["name"]), db=q_(table["schema"]) if table.get("schema") else None)
    col = exp.Column(this=q_(column))
    q = sqlglot.select(exp.alias_(exp.Count(this=col.copy()), "n"), exp.alias_(exp.Count(this=exp.Distinct(expressions=[col.copy()])), "d")).from_(tb)
    return q.sql(dialect=SQLGLOT_DIALECT.get(conn.db_type, "duckdb"))
