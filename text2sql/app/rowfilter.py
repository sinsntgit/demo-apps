"""Row-level data filters.

An administrator attaches a condition to a table ("region = 'North'") for everyone, a role
or named users. Before a query runs, every reference to that table is replaced by a
filtered sub-select, so the restriction holds however the SQL was written - by the model,
edited by the user, or stored in a report. Administrators are not filtered.
"""
import re

import sqlglot
from sqlalchemy import or_, select
from sqlglot import exp

from .models import DataFilter
from .sqlguard import _FORBIDDEN_FUNCS, SQLGLOT_DIALECT, Checked, SQLBlocked, _func_names

PLACEHOLDERS = ("{user_email}", "{user_name}", "{user_id}")


def applicable(db, user, conn) -> list[DataFilter]:
    if user.role == "admin":
        return []
    return list(db.scalars(select(DataFilter).where(
        DataFilter.connection_id == conn.id, DataFilter.enabled,
        or_(DataFilter.scope == "all",
            (DataFilter.scope == "role") & (DataFilter.role == user.role),
            (DataFilter.scope == "user") & (DataFilter.user_id == user.id)))))


def _lit(value) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _fill(condition: str, user) -> str:
    """Substitute the signed-in user's attributes as safely quoted literals."""
    out = condition.replace("{user_email}", _lit(user.email)).replace("{user_name}", _lit(user.name))
    return out.replace("{user_id}", str(int(user.id)))


def _parse(condition: str, db_type: str):
    try:
        tree = sqlglot.parse_one(f"SELECT 1 FROM t WHERE {condition}", read=SQLGLOT_DIALECT.get(db_type))
    except Exception:
        raise ValueError("The condition is not valid SQL for this database.")
    where = tree.args.get("where")
    if where is None or not isinstance(tree, exp.Select):
        raise ValueError("Enter a single condition, for example: region = 'North'")
    extra = [k for k in ("group", "having", "order", "limit", "joins") if tree.args.get(k)]
    if extra or ";" in re.sub(r"'(?:[^']|'')*'", "", condition):
        raise ValueError("Enter only a condition (what would follow WHERE), nothing else.")
    cond = where.this
    if cond.find(exp.Select) or cond.find(exp.Subquery):
        raise ValueError("Sub-queries are not allowed in a data filter.")
    for name in _func_names(cond):
        if name in _FORBIDDEN_FUNCS:
            raise ValueError(f"Function not allowed: {name}().")
    return cond


def validate(condition: str, db_type: str):
    """Raises ValueError with a user-facing message if the condition cannot be used."""
    if not condition.strip():
        raise ValueError("A condition is required.")
    probe = condition
    for p in PLACEHOLDERS:
        probe = probe.replace(p, "1" if p == "{user_id}" else "'x'")
    if re.search(r"\{[^}]*\}", re.sub(r"'(?:[^']|'')*'", "", probe)):
        raise ValueError("Unknown placeholder. Available: " + ", ".join(PLACEHOLDERS))
    _parse(probe, db_type)


def _matches(table: exp.Table, name: str) -> bool:
    parts = [p.strip().strip('"`[]').lower() for p in name.split(".") if p.strip()]
    if not parts or table.name.lower() != parts[-1]:
        return False
    return len(parts) == 1 or not table.db or table.db.lower() == parts[-2]


def apply(checked: Checked, filters: list[DataFilter], db_type: str, user) -> tuple[str, list[int]]:
    """Returns (sql_to_run, ids of the filters that took effect)."""
    if not filters:
        return checked.sql, []
    if checked.tree is None:
        raise SQLBlocked("This SQL uses syntax that cannot be checked against your data filters. "
                         "Rephrase the question or simplify the query.")
    tree = checked.tree.copy()
    cte_names = {c.alias_or_name.lower() for c in tree.find_all(exp.CTE)}
    used: list[int] = []
    for table in list(tree.find_all(exp.Table)):
        hits = [f for f in filters if table.name and _matches(table, f.table_name)]
        if not hits:
            continue
        if table.name.lower() in cte_names and not table.db:
            raise SQLBlocked(f"A sub-query is named '{table.name}', the same as a table with a data filter. "
                             "Give it a different name.")
        if table.args.get("pivots") or table.args.get("sample"):
            raise SQLBlocked(f"PIVOT / SAMPLE directly on '{table.name}' cannot be combined with your data filters. "
                             "Select from the table in a sub-query first.")
        try:
            conds = [_parse(_fill(f.condition, user), db_type) for f in hits]
        except ValueError as e:
            raise SQLBlocked(f"A data filter on '{table.name}' is invalid ({e}). Ask an administrator to fix it.")
        inner = exp.Table(this=table.this.copy(), db=table.args.get("db"), catalog=table.args.get("catalog"))
        table.replace(exp.select("*").from_(inner).where(*conds).subquery(table.alias or table.name))
        used += [f.id for f in hits]
    return tree.sql(dialect=SQLGLOT_DIALECT.get(db_type)), sorted(set(used))
