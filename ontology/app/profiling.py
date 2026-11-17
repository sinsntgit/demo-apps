"""Data profiling for data sources: what a table or dataset holds, computed on this server.

For every table the profiler records row count, and per column the type, how many values are empty, how many
distinct values a sample holds, whether it is unique, what role it plays (identifier, reference to another table,
code / category, flag, date, measure, free text, personal data), the range of numbers and dates, and sample
values: the full list with counts for a code column, a few examples otherwise. Keys and foreign keys come from
the database; for files, and for databases that declare none, likely joins are inferred from names and values.

Only SELECT statements built by SQLAlchemy Core are run against a database - never SQL typed by a person or
written by a model - and only a bounded number of rows is read per table. Values of columns that look like
personal data are never kept as samples unless the data source's owner allows it.
"""
import csv
import datetime as dt
import decimal
import io
import json
import os
import re
import tempfile
import time

SAMPLE_ROWS = 2000          # rows read per table to profile it
FILE_ROWS = 20000           # rows of an uploaded file profiled
CATEGORY_MAX = 30           # at most this many distinct values -> a code / category with all values listed
TOP_N = 15                  # values listed for a code column
DATASET_EXT = {"csv", "tsv", "xlsx", "xlsm", "db", "sqlite", "sqlite3"}

PERSONAL_NAME = re.compile(r"(^|_)(first_?name|last_?name|full_?name|surname|customer_?name|person_?name|name_of|e_?mail|mail_?id|phone|mobile|"
                           r"contact_?no|telephone|address|addr|street|pin_?code|zip|postcode|pan(_?no|_?number)?|aadhaa?r|ssn|passport|"
                           r"date_?of_?birth|dob|birth_?date|national_?id|voter_?id|driving_?licen[cs]e|account_?(no|number)|iban|card_?(no|number)|"
                           r"ip_?address|password|pwd)($|_)", re.I)
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.I)
PHONE = re.compile(r"^\+?[\d\s()-]{10,15}$")
ID_DOC = re.compile(r"^([A-Z]{5}\d{4}[A-Z]|\d{4}\s?\d{4}\s?\d{4}|\d{3}-\d{2}-\d{4})$")       # PAN, Aadhaar, SSN shapes
DATE_RX = [(re.compile(r"^\d{4}-\d{2}-\d{2}$"), "%Y-%m-%d"), (re.compile(r"^\d{2}/\d{2}/\d{4}$"), "%d/%m/%Y"),
           (re.compile(r"^\d{2}-\d{2}-\d{4}$"), "%d-%m-%Y")]
DATETIME_RX = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$")
FLAG_VALUES = {frozenset(x) for x in (("y", "n"), ("yes", "no"), ("true", "false"), ("0", "1"), ("t", "f"), ("active", "inactive"))}


class ProfileError(Exception):
    pass


# ---- one column ---------------------------------------------------------------------------------
def _kind(v) -> str:
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, (float, decimal.Decimal)):
        return "decimal"
    if isinstance(v, dt.datetime):
        return "dateTime"
    if isinstance(v, dt.date):
        return "date"
    s = str(v).strip()
    if re.fullmatch(r"[+-]?\d{1,18}", s) and not (len(s) > 1 and s.startswith("0")):
        return "integer"
    if re.fullmatch(r"[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?", s) or re.fullmatch(r"[+-]?\d{1,3}(,\d{3})+(\.\d+)?", s):
        return "decimal"
    if DATETIME_RX.match(s):
        return "dateTime"
    for rx, _ in DATE_RX:
        if rx.match(s):
            return "date"
    if s.lower() in ("true", "false"):
        return "boolean"
    return "string"


def _num(v):
    try:
        return float(str(v).replace(",", "")) if not isinstance(v, (int, float, decimal.Decimal)) or isinstance(v, bool) else float(v)
    except ValueError:
        return None


def _short(v, n=40) -> str:
    if isinstance(v, (decimal.Decimal, float)) and not isinstance(v, bool):
        s = format(v, "f") if isinstance(v, decimal.Decimal) else repr(v)
        s = s.rstrip("0").rstrip(".") if "." in s else s
    else:
        s = v.isoformat() if isinstance(v, (dt.date, dt.datetime)) else str(v)
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[:n - 1] + "…"


MEASURE_NAME = re.compile(r"(amount|amt|price|cost|value|qty|quantity|total|balance|rate|percent|pct|score|weight|volume|count|salary|income|fee|tax|"
                          r"discount|revenue|sales|margin|premium|limit|area|duration|age)", re.I)


def profile_column(name: str, values: list, declared: str = "", total_rows: int | None = None, allow_personal: bool = False,
                   first: bool = False) -> dict:
    n = len(values)
    present = [v for v in values if v is not None and str(v).strip() != ""]
    kinds: dict = {}
    for v in present[:5000]:
        k = _kind(v)
        kinds[k] = kinds.get(k, 0) + 1
    if not kinds:
        typ = "string"
    elif len(kinds) == 1:
        typ = next(iter(kinds))
    elif set(kinds) <= {"integer", "decimal"}:
        typ = "decimal"
    elif set(kinds) <= {"date", "dateTime"}:
        typ = "dateTime"
    else:                                               # mostly one kind with a few odd values
        top_kind, top_n = max(kinds.items(), key=lambda kv: kv[1])
        typ = top_kind if top_n >= 0.95 * sum(kinds.values()) else "string"
    keys = [_short(v, 200) for v in present]
    counts: dict = {}
    for k in keys:
        counts[k] = counts.get(k, 0) + 1
    distinct = len(counts)
    unique = bool(present) and distinct == len(present) and len(present) == n
    avg_len = sum(len(k) for k in keys) / len(keys) if keys else 0
    low = name.lower()
    personal = bool(PERSONAL_NAME.search(low))
    if not personal and keys and typ == "string":       # values that look like emails, phone or ID-document numbers
        sample = keys[:200]
        hits = sum(bool(EMAIL.match(k) or PHONE.match(k) or ID_DOC.match(k)) for k in sample)
        personal = hits >= 0.5 * len(sample)
    lowered = {k.lower() for k in counts}
    if typ == "boolean" or (distinct == 2 and frozenset(lowered) in FLAG_VALUES) or (1 <= distinct <= 2 and lowered <= {"y", "n", "yes", "no", "true", "false", "0", "1", "t", "f"}):
        role = "flag"
    elif typ in ("date", "dateTime"):
        role = "date"
    elif unique and (re.search(r"(^|_)(id|key|no|num|number|code|ref|uuid|guid)$|id$", low) or (first and typ in ("integer", "string") and not MEASURE_NAME.search(low))):
        role = "identifier"
    elif typ in ("integer", "decimal") and re.search(r"(^|_)(id|code|key|ref)$|id$", low):
        role = "reference"
    elif distinct and distinct <= CATEGORY_MAX and distinct <= max(CATEGORY_MAX, 0.05 * len(present)) and avg_len <= 40 and len(present) >= 2 * distinct:
        role = "code"
    elif typ in ("integer", "decimal"):
        role = "measure"
    elif avg_len > 60:
        role = "text"
    else:
        role = "attribute"
    out = {"name": name, "type": typ, "declared": declared, "role": role, "personal": personal,
           "nulls_pct": round(100 * (n - len(present)) / n, 1) if n else 0.0, "distinct": distinct, "unique": unique,
           "sampled": n, "top": [], "examples": [], "min": None, "max": None}
    if typ in ("integer", "decimal") and present:
        nums = [x for x in (_num(v) for v in present) if x is not None]
        if nums:
            out["min"], out["max"] = min(nums), max(nums)
    elif typ in ("date", "dateTime") and present:
        ks = sorted(keys)
        out["min"], out["max"] = ks[0][:19], ks[-1][:19]
    if not personal or allow_personal:
        if role in ("code", "flag"):
            out["top"] = [[k, c] for k, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_N]]
        elif role != "text":
            seen = []
            for k in keys:
                if k not in seen:
                    seen.append(_short(k))
                if len(seen) == 3:
                    break
            out["examples"] = seen
        else:
            out["examples"] = [_short(keys[0], 120)] if keys else []
    return out


def profile_table(name: str, columns: list[str], rows: list, declared: dict | None = None, row_count: int | None = None,
                  pk: list | None = None, fks: list | None = None, allow_personal: bool = False) -> tuple[dict, dict]:
    """-> (profile, distinct value sets per column - kept in memory only, to infer joins)."""
    declared = declared or {}
    cols, values = [], {}
    for i, c in enumerate(columns):
        vals = [r[i] if i < len(r) else None for r in rows]
        p = profile_column(c, vals, declared.get(c, ""), row_count, allow_personal, first=i == 0)
        if c in (pk or []):
            p["pk"] = True
            if p["role"] not in ("identifier",):
                p["role"] = "identifier"
        cols.append(p)
        values[c] = {_short(v, 200) for v in vals if v is not None and str(v).strip() != ""}
    for fk in fks or []:
        for c, rc in zip(fk["columns"], fk["ref_columns"]):
            for p in cols:
                if p["name"] == c:
                    p["ref"] = f"{fk['ref_table']}.{rc}"
                    p["ref_declared"] = True
                    if p["role"] not in ("identifier",):
                        p["role"] = "reference"
    return {"name": name, "row_count": row_count if row_count is not None else len(rows), "sampled_rows": len(rows), "pk": list(pk or []),
            "fks": list(fks or []), "columns": cols}, values


def _singular(w: str) -> str:
    w = w.lower()
    for suf, rep in (("ies", "y"), ("sses", "ss"), ("s", "")):
        if w.endswith(suf) and len(w) > len(suf) + 2:
            return w[:-len(suf)] + rep
    return w


def infer_joins(tables: list[dict], values: dict) -> int:
    """Mark columns that most likely refer to another table's key, from the column name and the values.
    values: {table: {column: set}}. Returns the number of joins found."""
    keys = {}
    for t in tables:
        for p in t["columns"]:
            if p.get("pk") or p["role"] == "identifier":
                keys.setdefault(t["name"], []).append(p["name"])
    found = 0
    for t in tables:
        for p in t["columns"]:
            if p.get("ref") or p.get("pk"):
                continue
            col = p["name"].lower()
            mine = values.get(t["name"], {}).get(p["name"], set())
            if not mine:
                continue
            best = None
            for other, kcols in keys.items():
                if other == t["name"]:
                    continue
                base = _singular(re.sub(r"^(tbl_|t_|dim_|fact_|stg_)", "", other.lower()))
                for k in kcols:
                    kl = k.lower()
                    named = col in (f"{base}_{kl}", f"{base}{kl}") or (col == kl and kl not in ("id", "code", "name", "no"))
                    if not named:
                        continue
                    theirs = values.get(other, {}).get(k, set())
                    if theirs and len(mine & theirs) >= 0.9 * len(mine):
                        best = f"{other}.{k}"
                        break
                if best:
                    break
            if best:
                p["ref"], p["ref_declared"] = best, False
                if p["role"] in ("measure", "code", "attribute", "identifier"):
                    p["role_before"], p["role"] = p["role"], "reference"
                found += 1
    return found


# ---- databases ---------------------------------------------------------------------------------
def profile_database(url: str, schema: str | None = None, max_tables: int = 200, sample_rows: int = SAMPLE_ROWS,
                     budget_s: float = 150, allow_personal: bool = False) -> dict:
    """Structure plus a profile of each table, reading at most `sample_rows` rows per table."""
    from sqlalchemy import MetaData, Table, create_engine, func, inspect, select
    from sqlalchemy.exc import NoSuchModuleError
    from . import sources
    try:
        engine = create_engine(url, connect_args={"connect_timeout": 10} if not url.startswith(("sqlite", "oracle")) else {})
    except (ModuleNotFoundError, NoSuchModuleError) as e:
        raise ProfileError(sources._no_driver(e) if isinstance(e, ModuleNotFoundError) else "This kind of database is not supported.")
    t0 = time.time()
    tables, values, notes = [], {}, []
    try:
        insp = inspect(engine)
        names = insp.get_table_names(schema=schema)
        views = insp.get_view_names(schema=schema)
        if not names and not views:
            raise ProfileError("Connected, but no tables or views are visible to this user" + (f" in schema '{schema}'." if schema else "."))
        md = MetaData()
        todo = [(n, "table") for n in names] + [(n, "view") for n in views]
        if len(todo) > max_tables:
            notes.append(f"Only the first {max_tables} of {len(todo)} tables and views were read.")
            todo = todo[:max_tables]
        with engine.connect() as con:
            for name, kind in todo:
                cols = insp.get_columns(name, schema=schema)
                declared = {c["name"]: str(c["type"]) for c in cols}
                comments = {c["name"]: c.get("comment") or "" for c in cols}
                try:
                    pk = (insp.get_pk_constraint(name, schema=schema) or {}).get("constrained_columns") or [] if kind == "table" else []
                    fks = [{"columns": f["constrained_columns"], "ref_table": f["referred_table"], "ref_columns": f["referred_columns"]}
                           for f in insp.get_foreign_keys(name, schema=schema)] if kind == "table" else []
                except Exception:
                    pk, fks = [], []
                try:
                    comment = (insp.get_table_comment(name, schema=schema) or {}).get("text") or "" if kind == "table" else ""
                except Exception:
                    comment = ""
                rows, count = [], None
                if time.time() - t0 < budget_s:
                    try:
                        tbl = Table(name, md, autoload_with=con, schema=schema)
                        count = con.execute(select(func.count()).select_from(tbl)).scalar()
                        rows = [tuple(r) for r in con.execute(select(tbl).limit(sample_rows))]
                    except Exception as e:                      # one unreadable table does not stop the rest
                        notes.append(f"{name}: rows could not be read ({type(e).__name__}); structure only.")
                        con.rollback() if hasattr(con, "rollback") else None
                else:
                    notes.append(f"{name}: not profiled (time limit reached); structure only.")
                prof, vals = profile_table(name, [c["name"] for c in cols], rows, declared, count, pk, fks, allow_personal)
                prof["kind"] = kind
                prof["db_comment"] = comment
                for p in prof["columns"]:
                    p["db_comment"] = comments.get(p["name"], "")
                tables.append(prof)
                values[name] = vals
    except ProfileError:
        raise
    except ModuleNotFoundError as e:
        raise ProfileError(sources._no_driver(e))
    except Exception as e:
        msg = re.sub(r"\s+", " ", str(getattr(e, "orig", e)))[:300]
        raise ProfileError("Could not read the database: " + re.sub(r"(password|pwd)\s*[=:]\s*\S+", r"\1=***", msg, flags=re.I))
    finally:
        engine.dispose()
    if not any(t["fks"] for t in tables):
        infer_joins(tables, values)
    return {"tables": tables, "notes": notes, "seconds": round(time.time() - t0, 1)}


# ---- files -------------------------------------------------------------------------------------
def is_dataset(name: str, data: bytes) -> bool:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext in DATASET_EXT:
        return True
    if ext == "json":
        try:
            return bool(_json_tables(name, json.loads(data.decode("utf-8", "replace"))))
        except ValueError:
            return False
    return False


def _json_tables(name: str, obj) -> list:
    """A JSON array of records, or an object holding such arrays, is a dataset; anything else is a document."""
    base = re.sub(r"\.\w+$", "", name.rsplit("/", 1)[-1])
    def records(x):
        return isinstance(x, list) and len(x) >= 2 and sum(isinstance(r, dict) for r in x[:50]) >= 0.9 * min(len(x), 50)
    if records(obj):
        return [(base, obj)]
    if isinstance(obj, dict):
        return [(k, v) for k, v in obj.items() if records(v)]
    return []


def profile_file(name: str, data: bytes, allow_personal: bool = False) -> list[dict]:
    """A dataset file -> table profiles (one per CSV, sheet, SQLite table or JSON record list)."""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    base = re.sub(r"\.\w+$", "", name.rsplit("/", 1)[-1])
    out, values = [], {}
    try:
        if ext in ("csv", "tsv"):
            text = data.decode("utf-8-sig", "replace")
            try:
                dialect = csv.Sniffer().sniff(text[:20000], delimiters=",;\t|") if ext == "csv" else csv.excel_tab
            except csv.Error:
                dialect = csv.excel
            reader = csv.reader(io.StringIO(text), dialect)
            header = next(reader, [])
            rows, total = [], 0
            for r in reader:
                total += 1
                if len(rows) < FILE_ROWS:
                    rows.append(r)
            if not header:
                raise ProfileError("The file is empty.")
            p, v = profile_table(base, [h.strip() or f"column_{i + 1}" for i, h in enumerate(header)], rows, row_count=total, allow_personal=allow_personal)
            out.append(p); values[base] = v
        elif ext in ("xlsx", "xlsm"):
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
            for ws in wb.worksheets:
                it = ws.iter_rows(values_only=True)
                header = None
                for r in it:                                 # the first row with at least two filled cells is the header
                    if r and sum(c is not None and str(c).strip() != "" for c in r) >= 2:
                        header = r
                        break
                if not header:
                    continue
                rows, total = [], 0
                for r in it:
                    if r is None or all(c is None for c in r):
                        continue
                    total += 1
                    if len(rows) < FILE_ROWS:
                        rows.append(r)
                tname = base if len(wb.worksheets) == 1 else f"{base} - {ws.title}"
                p, v = profile_table(tname, [str(h).strip() if h is not None else f"column_{i + 1}" for i, h in enumerate(header)], rows,
                                     row_count=total, allow_personal=allow_personal)
                out.append(p); values[tname] = v
        elif ext in ("db", "sqlite", "sqlite3"):
            fd, path = tempfile.mkstemp(suffix=".sqlite")
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                return profile_database(f"sqlite:///{path}", allow_personal=allow_personal)["tables"]
            finally:
                os.unlink(path)
        elif ext == "json":
            for tname, recs in _json_tables(name, json.loads(data.decode("utf-8", "replace"))):
                cols = []
                for r in recs[:FILE_ROWS]:
                    for k in (r.keys() if isinstance(r, dict) else []):
                        if k not in cols:
                            cols.append(k)
                rows = [tuple((json.dumps(r.get(c)) if isinstance(r.get(c), (dict, list)) else r.get(c)) for c in cols)
                        for r in recs[:FILE_ROWS] if isinstance(r, dict)]
                p, v = profile_table(tname, [str(c) for c in cols], rows, row_count=len(recs), allow_personal=allow_personal)
                out.append(p); values[tname] = v
        else:
            raise ProfileError(f"Files of type .{ext} are not datasets.")
    except ProfileError:
        raise
    except Exception as e:
        raise ProfileError(f"Could not be read as a dataset ({type(e).__name__}). The file may be damaged or password-protected.")
    if not out:
        raise ProfileError("No table with a header row was found.")
    infer_joins(out, values)
    return out


def relink(tables: list[dict]) -> None:
    """Re-infer joins across all the tables of a data source (files uploaded separately), using sample values only."""
    values = {}
    for t in tables:
        vals = {}
        for p in t["columns"]:
            vals[p["name"]] = {x[0] for x in p.get("top", [])} | set(p.get("examples", []))
        values[t["name"]] = vals
    for t in tables:
        for p in t["columns"]:
            if p.get("ref") and not p.get("ref_declared"):
                p.pop("ref", None)
                if "role_before" in p:
                    p["role"] = p.pop("role_before")
    # with only samples to compare, a join by name to a unique key is accepted when no sample contradicts it
    keys = {t["name"]: [p["name"] for p in t["columns"] if p.get("pk") or p["role"] == "identifier"] for t in tables}
    for t in tables:
        for p in t["columns"]:
            if p.get("ref") or p.get("pk") or p["role"] == "identifier":
                continue
            col = p["name"].lower()
            for other, kcols in keys.items():
                if other == t["name"]:
                    continue
                base = _singular(re.sub(r"^(tbl_|t_|dim_|fact_|stg_)", "", other.lower().split(" - ")[-1]))
                for k in kcols:
                    kl = k.lower()
                    if p.get("ref"):
                        break
                    if col in (f"{base}_{kl}", f"{base}{kl}") or (col == kl and kl not in ("id", "code", "name", "no")):
                        p["ref"], p["ref_declared"] = f"{other}.{k}", False
                        if p["role"] in ("measure", "code", "attribute"):
                            p["role_before"], p["role"] = p["role"], "reference"


# ---- what the ontology builder is given -----------------------------------------------------------
ROLE_WORD = {"identifier": "identifier", "reference": "reference", "code": "code list", "flag": "yes/no flag", "date": "date",
             "measure": "measure", "text": "free text", "attribute": "attribute"}


def _fmt(x) -> str:
    if isinstance(x, float):
        return f"{x:,.0f}" if abs(x) >= 100 else f"{x:,.2f}".rstrip("0").rstrip(".")
    return str(x)


def describe(table: dict, samples: bool = True) -> str:
    """One table as text for the model: structure, profile, business descriptions and (if allowed) sample values."""
    t = table
    head = f"TABLE {t['name']}"
    if t.get("row_count") is not None:
        head += f"  ({t['row_count']:,} rows)"
    desc = t.get("description") or t.get("db_comment")
    lines = [head + (f"  -- {desc}" if desc else "")]
    for p in t["columns"]:
        bits = [p["declared"] or p["type"]]
        if p.get("pk"):
            bits.append("PK")
        bits.append(ROLE_WORD.get(p["role"], p["role"]))
        if p.get("ref"):
            bits.append(f"-> {p['ref']}" + ("" if p.get("ref_declared", True) else " (inferred)"))
        if p["unique"] and not p.get("pk"):
            bits.append("unique")
        if p["nulls_pct"]:
            bits.append(f"{p['nulls_pct']:g}% empty")
        if p["personal"]:
            bits.append("personal data")
        if p["min"] is not None and p["role"] in ("measure", "date"):
            bits.append(f"range {_fmt(p['min'])} .. {_fmt(p['max'])}")
        line = f"  {p['name']}  " + ", ".join(bits)
        if samples:
            if p["top"]:
                line += f"; {p['distinct']} values: " + ", ".join(f"{v} ({c})" for v, c in p["top"]) + (" …" if p["distinct"] > len(p["top"]) else "")
            elif p["examples"]:
                line += "; e.g. " + " | ".join(p["examples"])
            elif p["personal"]:
                line += "; values withheld"
        d = p.get("description") or p.get("db_comment")
        if d:
            line += f"  -- {d}"
        lines.append(line)
    return "\n".join(lines)
