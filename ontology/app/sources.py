"""Source material: text extraction from uploaded documents, and database schemas.

A database is only ever asked for its structure - tables, columns, types, keys, comments. No rows are read.
Connection details are used for that one read and are not stored.
"""
import csv
import io
import json
import os
import re
import tempfile

MAX_FILE = 25 * 1024 * 1024
MAX_CHARS = 400_000                 # text kept per document
TEXT_EXT = {"txt", "md", "markdown", "rst", "json", "xml", "yaml", "yml", "sql", "ddl", "html", "htm", "ttl", "owl",
            "rdf", "tsv", "log", "ini", "properties", "dbml", "puml", "graphql", "proto", "xsd", "avsc"}
DOC_EXT = TEXT_EXT | {"pdf", "docx", "pptx", "xlsx", "xlsm", "csv", "db", "sqlite", "sqlite3"}


class Unreadable(Exception):
    pass


def _clean(t: str) -> str:
    t = t.replace("\x00", "").replace("\r\n", "\n")
    return re.sub(r"\n{4,}", "\n\n\n", re.sub(r"[ \t]{3,}", "  ", t)).strip()


def extract(name: str, data: bytes) -> tuple[str, str, str]:
    """-> (kind, text, note). Raises Unreadable with a sentence the user can act on."""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if len(data) > MAX_FILE:
        raise Unreadable("Larger than 25 MB.")
    if not data:
        raise Unreadable("The file is empty.")
    try:
        if ext == "pdf":
            from pypdf import PdfReader
            pages = PdfReader(io.BytesIO(data)).pages
            text = "\n\n".join((p.extract_text() or "") for p in pages)
            if len(text.strip()) < 20:
                raise Unreadable("No text could be read - it looks like a scanned PDF (images only).")
            kind, note = "document", f"{len(pages)} pages"
        elif ext == "docx":
            import docx
            d = docx.Document(io.BytesIO(data))
            parts = [p.text for p in d.paragraphs]
            for tb in d.tables:
                parts += [" | ".join(c.text.strip() for c in r.cells) for r in tb.rows]
            text, kind, note = "\n".join(parts), "document", f"{len(d.paragraphs)} paragraphs, {len(d.tables)} tables"
        elif ext == "pptx":
            from pptx import Presentation
            prs = Presentation(io.BytesIO(data))
            parts = []
            for i, s in enumerate(prs.slides):
                parts.append(f"--- slide {i + 1} ---")
                parts += [sh.text_frame.text for sh in s.shapes if sh.has_text_frame and sh.text_frame.text.strip()]
            text, kind, note = "\n".join(parts), "document", f"{len(prs.slides)} slides"
        elif ext in ("xlsx", "xlsm"):
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
            parts = []
            for ws in wb.worksheets:
                parts.append(f"--- sheet: {ws.title} ---")
                for n, row in enumerate(ws.iter_rows(values_only=True)):
                    if n >= 25:                      # the header and a few rows show the structure
                        parts.append("…")
                        break
                    if any(v is not None for v in row):
                        parts.append(" | ".join("" if v is None else str(v)[:80] for v in row))
            text, kind, note = "\n".join(parts), "document", f"{len(wb.worksheets)} sheets (headings and first rows)"
        elif ext == "csv":
            rows = list(csv.reader(io.StringIO(data[:200_000].decode("utf-8", "replace"))))[:25]
            text, kind, note = "\n".join(" | ".join(c[:80] for c in r) for r in rows), "document", "headings and first rows"
        elif ext in ("db", "sqlite", "sqlite3"):
            fd, path = tempfile.mkstemp(suffix=".sqlite")
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                text, note = introspect(f"sqlite:///{path}")
            finally:
                os.unlink(path)
            kind = "schema"
        elif ext in TEXT_EXT or not ext:
            text = data.decode("utf-8", "replace")
            if text.count("�") > len(text) / 20:
                raise Unreadable("This does not look like a text file.")
            if ext in ("html", "htm"):
                text = re.sub(r"<(script|style)\b.*?</\1>", " ", text, flags=re.S | re.I)
                text = re.sub(r"<[^>]+>", " ", text)
            is_ddl = ext in ("sql", "ddl", "dbml") or len(re.findall(r"create\s+table", text, re.I)) >= 2
            kind, note = ("schema", f"{len(re.findall(r'create\s+table', text, re.I))} CREATE TABLE statements") if is_ddl else ("document", "")
        else:
            raise Unreadable(f"Files of type .{ext} are not supported (use PDF, Word, PowerPoint, Excel, CSV, SQL or text).")
    except Unreadable:
        raise
    except Exception as e:
        raise Unreadable(f"Could not be read ({type(e).__name__}). The file may be damaged or password-protected.")
    text = _clean(text)
    if len(text) > MAX_CHARS:
        note = (note + "; " if note else "") + f"only the first {MAX_CHARS:,} of {len(text):,} characters are kept"
        text = text[:MAX_CHARS]
    return kind, text, note


# ---- database schema ----------------------------------------------------------------------------
DB_TYPES = {
    "postgresql": {"label": "PostgreSQL", "driver": "postgresql+psycopg2", "port": 5432, "package": "psycopg2-binary"},
    "mysql": {"label": "MySQL / MariaDB", "driver": "mysql+pymysql", "port": 3306, "package": "pymysql"},
    "singlestore": {"label": "SingleStore", "driver": "mysql+pymysql", "port": 3306, "package": "pymysql"},
    "mssql": {"label": "Microsoft SQL Server", "driver": "mssql+pymssql", "port": 1433, "package": "pymssql"},
    "oracle": {"label": "Oracle", "driver": "oracle+oracledb", "port": 1521, "package": "oracledb"},
    "snowflake": {"label": "Snowflake", "driver": "snowflake", "port": None, "package": "snowflake-sqlalchemy"},
}


def db_url(db_type: str, host: str, port: int | None, database: str, user: str, password: str, extra: dict | None = None) -> str:
    """A SQLAlchemy URL. Snowflake: host is the account identifier (e.g. orgname-account), and `extra` may give
    the warehouse, role and schema. Oracle: database is the service name."""
    from sqlalchemy.engine import URL
    t, extra = DB_TYPES[db_type], extra or {}
    if db_type == "snowflake":
        db = database + (f"/{extra['schema']}" if extra.get("schema") else "")
        query = {k: extra[k] for k in ("warehouse", "role") if extra.get(k)}
        return URL.create("snowflake", user or None, password or None, host, None, db, query=query).render_as_string(False)
    if db_type == "oracle":
        return URL.create(t["driver"], user or None, password or None, host, port or t["port"], query={"service_name": database}).render_as_string(False)
    return URL.create(t["driver"], user or None, password or None, host, port or t["port"], database).render_as_string(False)


def connect_args(url: str) -> dict:
    """Each driver names its connection timeout differently; passing the wrong name makes it refuse to connect."""
    scheme = url.split(":", 1)[0]
    if scheme.startswith(("postgresql", "mysql")):
        return {"connect_timeout": 10}
    if scheme.startswith("mssql"):
        return {"login_timeout": 10}
    if scheme.startswith("oracle"):
        return {"tcp_connect_timeout": 10}
    if scheme.startswith("snowflake"):
        return {"login_timeout": 15, "session_parameters": {"QUERY_TAG": "ontostudio"}}
    return {}


def make_engine(url: str):
    """Engine with the right connection settings, or Unreadable with the package to install."""
    from sqlalchemy import create_engine
    from sqlalchemy.exc import NoSuchModuleError
    scheme = url.split(":", 1)[0]
    try:
        return create_engine(url, connect_args=connect_args(url))
    except ModuleNotFoundError as e:
        raise Unreadable(_no_driver(e))
    except NoSuchModuleError:
        pkg = next((v["package"] for v in DB_TYPES.values() if v["driver"].split("+")[0] == scheme.split("+")[0]), scheme)
        raise Unreadable(f"The driver for this kind of database is not installed on the server. Ask an administrator to run:  pip install {pkg}")


def _no_driver(e) -> str:
    pkg = {"psycopg2": "psycopg2-binary", "snowflake": "snowflake-sqlalchemy"}.get(e.name, e.name)
    return f"The driver for this kind of database is not installed on the server. Ask an administrator to run:  pip install {pkg}"


def introspect(url: str, schema: str | None = None, max_tables: int = 400) -> tuple[str, str]:
    """Read a database's structure (never its rows) -> (schema text, note)."""
    from sqlalchemy import inspect
    engine = make_engine(url)
    try:
        insp = inspect(engine)
        tables = insp.get_table_names(schema=schema)
        views = insp.get_view_names(schema=schema)
        lines, n_cols, n_fk = [], 0, 0
        for kind, names in (("TABLE", tables[:max_tables]), ("VIEW", views[:max(0, max_tables - len(tables))])):
            for t in names:
                try:
                    comment = (insp.get_table_comment(t, schema=schema) or {}).get("text") if kind == "TABLE" else None
                except Exception:
                    comment = None
                lines.append(f"{kind} {t}" + (f"  -- {comment}" if comment else ""))
                try:
                    pk = set((insp.get_pk_constraint(t, schema=schema) or {}).get("constrained_columns") or []) if kind == "TABLE" else set()
                except Exception:
                    pk = set()
                for col in insp.get_columns(t, schema=schema):
                    n_cols += 1
                    bits = [str(col["type"])] + (["PK"] if col["name"] in pk else []) + ([] if col.get("nullable", True) else ["NOT NULL"])
                    lines.append(f"  {col['name']}  {' '.join(bits)}" + (f"  -- {col['comment']}" if col.get("comment") else ""))
                if kind == "TABLE":
                    for fk in insp.get_foreign_keys(t, schema=schema):
                        n_fk += 1
                        lines.append(f"  FK ({', '.join(fk['constrained_columns'])}) -> {fk['referred_table']} ({', '.join(fk['referred_columns'])})")
                    try:
                        for uq in insp.get_unique_constraints(t, schema=schema):
                            lines.append(f"  UNIQUE ({', '.join(uq['column_names'])})")
                    except Exception:
                        pass
                lines.append("")
    except Unreadable:
        raise
    except ModuleNotFoundError as e:
        raise Unreadable(_no_driver(e))
    except Exception as e:
        msg = re.sub(r"\s+", " ", str(getattr(e, "orig", e)))[:300]
        msg = re.sub(r"(password|pwd)\s*[=:]\s*\S+", r"\1=***", msg, flags=re.I)
        raise Unreadable(f"Could not read the database structure: {msg}")
    finally:
        engine.dispose()
    if not tables and not views:
        raise Unreadable("Connected, but no tables or views are visible to this user" + (f" in schema '{schema}'." if schema else "."))
    note = f"{len(tables)} tables, {len(views)} views, {n_cols} columns, {n_fk} foreign keys - structure only, no rows read"
    if len(tables) + len(views) > max_tables:
        note += f"; only the first {max_tables} are included"
    return "\n".join(lines).strip(), note
