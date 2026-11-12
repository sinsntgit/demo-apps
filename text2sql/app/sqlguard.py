"""Read-only SQL enforcement.

Every statement - model-written or user-edited - passes through `check()` before it
touches a source database. Only a single SELECT (incl. CTEs / set operations) is allowed.
"""
import fnmatch
import re
from dataclasses import dataclass, field

import sqlglot
from sqlglot import exp

SQLGLOT_DIALECT = {
    "postgres": "postgres", "mysql": "mysql", "singlestore": "singlestore", "mssql": "tsql",
    "oracle": "oracle", "snowflake": "snowflake", "files": "duckdb",
}

_FORBIDDEN_NODES = tuple(
    getattr(exp, n) for n in (
        "Insert", "Update", "Delete", "Merge", "Create", "Drop", "Alter", "AlterTable", "TruncateTable",
        "Command", "Into", "Grant", "Revoke", "Set", "Use", "Copy", "Pragma", "Transaction", "Commit",
        "Rollback", "LoadData", "Attach", "Detach", "Kill", "Execute", "Lock", "Analyze", "Refresh",
        "Export", "Put", "Get", "Cache", "Uncache", "Comment", "Install",
    ) if hasattr(exp, n)
)

# Functions that read files, call out of the database, or burn resources.
_FORBIDDEN_FUNCS = {
    "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_sleep", "pg_sleep_for", "pg_sleep_until",
    "lo_import", "lo_export", "dblink", "dblink_exec", "pg_terminate_backend", "pg_cancel_backend",
    "set_config", "query_to_xml", "copy", "load_file", "sleep", "benchmark", "sys_exec", "sys_eval",
    "xp_cmdshell", "openrowset", "opendatasource", "openquery", "sp_executesql", "waitfor",
    "utl_http", "utl_file", "dbms_scheduler", "dbms_lock", "system$wait", "read_csv", "read_csv_auto",
    "read_parquet", "read_json", "read_json_auto", "read_text", "read_blob", "glob", "getenv",
    "sqlite_scan", "postgres_scan", "mysql_scan", "httpfs",
}

_FALLBACK_BAD = re.compile(
    r"\b(insert|update|delete|merge|create|drop|alter|truncate|grant|revoke|exec|execute|call|copy|"
    r"into|attach|detach|pragma|set|use|begin|commit|rollback|lock|kill|shutdown|load|install|"
    r"replace\s+into|outfile|dumpfile)\b", re.I)


class SQLBlocked(Exception):
    pass


@dataclass
class Checked:
    sql: str
    tables: list[str] = field(default_factory=list)
    parsed: bool = True
    tree: object = None


def _strip(sql: str) -> str:
    sql = (sql or "").strip()
    sql = re.sub(r"^```(?:sql)?\s*|\s*```$", "", sql, flags=re.I).strip()
    return re.sub(r";+\s*$", "", sql).strip()


def _func_names(tree):
    for node in tree.find_all(exp.Func):
        if isinstance(node, exp.Anonymous):
            yield str(node.this).lower()
        else:
            yield node.sql_name().lower()
            yield type(node).__name__.lower()


def check(sql: str, db_type: str) -> Checked:
    sql = _strip(sql)
    if not sql:
        raise SQLBlocked("No SQL to run.")
    if len(sql) > 50_000:
        raise SQLBlocked("SQL is too long.")
    dialect = SQLGLOT_DIALECT.get(db_type)
    try:
        statements = [s for s in sqlglot.parse(sql, read=dialect) if s is not None]
    except Exception:
        return _fallback(sql)
    if len(statements) != 1:
        raise SQLBlocked("Only a single SQL statement is allowed.")
    tree = statements[0]
    if not isinstance(tree, (exp.Select, exp.SetOperation, exp.Subquery)):
        raise SQLBlocked("Only read-only SELECT queries are allowed.")
    for node in tree.walk():
        if isinstance(node, _FORBIDDEN_NODES):
            raise SQLBlocked(f"Statement type not allowed in read-only mode: {type(node).__name__.upper()}.")
    for name in _func_names(tree):
        if name in _FORBIDDEN_FUNCS:
            raise SQLBlocked(f"Function not allowed: {name}().")
    tables = sorted({".".join(p for p in (t.db, t.name) if p) for t in tree.find_all(exp.Table) if t.name})
    return Checked(sql=sql, tables=tables, parsed=True, tree=tree)


def _fallback(sql: str) -> Checked:
    """Used when the dialect parser cannot read vendor-specific syntax: strict keyword screen."""
    bare = re.sub(r"--[^\n]*|/\*.*?\*/", " ", sql, flags=re.S)
    bare = re.sub(r"'(?:[^']|'')*'", "''", bare)
    if ";" in bare:
        raise SQLBlocked("Only a single SQL statement is allowed.")
    if not re.match(r"^\s*\(*\s*(select|with)\b", bare, re.I):
        raise SQLBlocked("Only read-only SELECT queries are allowed.")
    m = _FALLBACK_BAD.search(bare)
    if m:
        raise SQLBlocked(f"Keyword not allowed in read-only mode: {m.group(1).upper()}.")
    for name in re.findall(r"\b([a-z_$][\w$]*)\s*\(", bare, re.I):
        if name.lower() in _FORBIDDEN_FUNCS:
            raise SQLBlocked(f"Function not allowed: {name}().")
    return Checked(sql=sql, parsed=False)


# ---- column masking ---------------------------------------------------------------
def _matches(name: str, patterns: list[str]) -> bool:
    n = (name or "").lower()
    return any(fnmatch.fnmatch(n, p.lower().split(".")[-1]) for p in patterns)


def masked_output_columns(checked: Checked, out_columns: list[str], patterns: list[str]) -> set[int]:
    """Indexes of result columns that expose a masked source column.

    Follows aliases through CTEs/subqueries: any alias whose expression reads a masked
    (or already tainted) column is itself tainted.
    """
    if not patterns:
        return set()
    tainted_names: set[str] = set()
    masked = {i for i, c in enumerate(out_columns) if _matches(c, patterns)}
    tree = checked.tree
    if tree is None:          # unparsed SQL: mask by output name only, plus be conservative
        return masked

    def reads_tainted(node) -> bool:
        return any(_matches(c.name, patterns) or c.name.lower() in tainted_names
                   for c in node.find_all(exp.Column))

    changed = True
    while changed:
        changed = False
        for alias in tree.find_all(exp.Alias):
            name = (alias.alias or "").lower()
            if name and name not in tainted_names and reads_tainted(alias.this):
                tainted_names.add(name)
                changed = True

    top = tree
    while isinstance(top, (exp.SetOperation, exp.Subquery)):
        top = top.this
    projections = getattr(top, "expressions", []) or []
    has_star = any(isinstance(p, exp.Star) or (isinstance(p, exp.Column) and isinstance(p.this, exp.Star))
                   for p in projections)
    if not has_star and len(projections) == len(out_columns):
        for i, p in enumerate(projections):
            if reads_tainted(p):
                masked.add(i)
    for i, c in enumerate(out_columns):
        if c.lower() in tainted_names:
            masked.add(i)
    return masked
