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
}
DEFAULT_PORT = {"postgres": 5432, "mysql": 3306, "singlestore": 3306, "mssql": 1433, "oracle": 1521}
DIALECT_NAME = {
    "postgres": "PostgreSQL", "mysql": "MySQL", "singlestore": "SingleStore (MySQL-compatible)",
    "mssql": "Microsoft SQL Server (T-SQL)", "oracle": "Oracle", "snowflake": "Snowflake", "files": "DuckDB",
}
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


_SESSION_SETUP = {
    "mysql": ["SET SESSION TRANSACTION READ ONLY", "SET SESSION MAX_EXECUTION_TIME={ms}"],
    "singlestore": [],
    "mssql": ["SET TRANSACTION ISOLATION LEVEL READ COMMITTED"],
    "oracle": ["SET TRANSACTION READ ONLY"],
}


# ---- Excel / CSV folders via DuckDB -------------------------------------------------
def files_folder(conn_id, cfg) -> Path:
    if cfg.get("folder"):
        return Path(cfg["folder"]).expanduser()
    p = config.FILES_DIR / str(conn_id)
    p.mkdir(parents=True, exist_ok=True)
    return p


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
    def work():
        t0 = time.time()
        if conn.db_type == "files":
            cur = _duck_db(conn.id, cfg).cursor()
            holder["cancel"] = cur.interrupt
            cur.execute(sql)
            names = [d[0] for d in cur.description or []]
            rows = cur.fetchmany(max_rows + 1)
            cur.close()
        else:
            eng = _engine(conn.id, conn.db_type, cfg, timeout_s, conn.updated_at)
            with eng.connect() as c:
                for stmt in _SESSION_SETUP.get(conn.db_type, []):
                    try:
                        c.exec_driver_sql(stmt.format(ms=timeout_s * 1000))
                    except Exception:
                        c.rollback()
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


def test(conn, cfg) -> str:
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
