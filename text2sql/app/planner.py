"""Answers across a combined data model: a *plan* of steps, one SELECT per step on one member data model, and a
*combine* SELECT that joins the step results on this server.

    plan = {"steps": [{"id": "s1", "source": "sap", "sql": "..."}, ...], "combine": "SELECT ... FROM s1 JOIN s2 ON ..."}

Every step goes through the same path as a single-model question: `sqlguard.check` for the member's dialect, the
person's row filters for that member (`rowfilter`), `connectors.run_query` and the member's masked columns. Masked
values are replaced *before* the results are combined, so nothing the person may not see can come out of the combine
step. Step results are loaded into a new in-memory DuckDB with external access switched off and the configuration
locked; the combine SQL is checked read-only and may only name step tables. Nothing here talks to the AI model.
"""
import concurrent.futures
import re
import time

from sqlglot import exp
from sqlalchemy.orm import Session

from . import connectors, matching, rowfilter, security, sqlguard
from .models import Connection

MAX_STEPS = 8
STEP_ID = re.compile(r"^s[1-9]$")


class PlanError(connectors.ConnectorError):
    """A plan that cannot run as written - shown to the person (and, scrubbed, to the model for repair)."""


class LimitError(PlanError):
    """A row limit was reached: never repaired automatically, never answered with an approximate result."""


def members_by_alias(db: Session, combined: Connection) -> dict[str, Connection]:
    return {m.alias: c for m, c in matching.members(db, combined)}


def clean(raw, members: dict[str, Connection]) -> dict:
    """A plan from the model or the editor -> {"steps": [{id, source, sql}], "combine"}; raises PlanError."""
    if not isinstance(raw, dict):
        raise PlanError("The answer did not contain a plan.")
    steps_in = raw.get("steps")
    if not isinstance(steps_in, list) or not steps_in:
        raise PlanError("The plan has no steps.")
    if len(steps_in) > MAX_STEPS:
        raise PlanError(f"A plan can have at most {MAX_STEPS} steps.")
    steps, seen = [], set()
    for i, st in enumerate(steps_in, 1):
        if not isinstance(st, dict):
            raise PlanError("A step of the plan is not readable.")
        sid = str(st.get("id") or f"s{i}").strip().lower()
        if not STEP_ID.match(sid) or sid in seen:
            sid = f"s{i}"
        if sid in seen:
            raise PlanError("Two steps have the same name.")
        source = str(st.get("source") or "").strip().lower()
        if source not in members:
            raise PlanError(f"Step {sid} names a data model that is not part of this combined model"
                            f" ({source or 'none'}); use one of: {', '.join(members)}.")
        sql = sqlguard._strip(str(st.get("sql") or ""))
        if not sql:
            raise PlanError(f"Step {sid} has no SQL.")
        seen.add(sid)
        steps.append({"id": sid, "source": source, "sql": sql})
    combine = sqlguard._strip(str(raw.get("combine") or ""))
    if not combine:
        if len(steps) != 1:
            raise PlanError("The plan has no combine step.")
        combine = f"SELECT * FROM {steps[0]['id']}"
    return {"steps": steps, "combine": combine}


def text(plan: dict, names: dict[str, str] | None = None) -> str:
    """The whole plan as one readable SQL text (history search, dashboard, exports)."""
    out = [f"-- {s['id']} · {s['source']}{' (' + names[s['source']] + ')' if names and s['source'] in names else ''}\n{s['sql']}"
           for s in plan["steps"]]
    out.append(f"-- combine (on the AskData server)\n{plan['combine']}")
    return "\n\n".join(out)


def same(a: dict, b: dict) -> bool:
    norm = lambda x: " ".join((x or "").split())
    return norm(a.get("combine")) == norm(b.get("combine")) and \
        [(s["id"], s["source"], norm(s["sql"])) for s in a.get("steps", [])] == \
        [(s["id"], s["source"], norm(s["sql"])) for s in b.get("steps", [])]


def check_combine(sql: str, step_ids: list[str]) -> sqlguard.Checked:
    """Read-only, DuckDB, and only the step tables (and its own CTEs) may be named."""
    checked = sqlguard.check(sql, "files")
    if not checked.parsed:
        raise sqlguard.SQLBlocked("The combine step could not be read; write it as plain SQL over the step tables.")
    ctes = {c.alias_or_name.lower() for c in checked.tree.find_all(exp.CTE)}
    for t in checked.tree.find_all(exp.Table):
        if not t.name:
            continue
        if t.db or t.catalog:
            raise sqlguard.SQLBlocked(f"The combine step can only use the step tables ({', '.join(step_ids)}), not {t.sql()}.")
        if t.name.lower() not in step_ids and t.name.lower() not in ctes:
            raise sqlguard.SQLBlocked(f"The combine step can only use the step tables ({', '.join(step_ids)}); "
                                      f"“{t.name}” is not one of them.")
    return checked


def _limit_msg(what: str, limit: int) -> str:
    return (f"{what} more than {limit:,} rows, the limit for questions across data models. Ask for totals rather than "
            "detail (for example per customer or per month), or for a shorter period. An administrator can change the limit "
            "under Admin → Settings → Combined data models.")


def run(db: Session, combined: Connection, plan: dict, cfg: dict, user, cap: int) -> dict:
    """Run a cleaned plan for this person. Returns a result like `connectors.run_query` plus
    {"steps": [...], "filters": [...], "warnings": [...], "combine_sql"}. Raises SQLBlocked / ConnectorError / PlanError."""
    members = members_by_alias(db, combined)
    step_cap, total_cap = int(cfg["combined_step_max_rows"]), int(cfg["combined_total_max_rows"])
    prepared = []
    for st in plan["steps"]:
        conn = members.get(st["source"])
        if conn is None:
            raise PlanError(f"Step {st['id']}: the data model “{st['source']}” is no longer part of this combined model.")
        if not conn.is_active:
            raise PlanError(f"Step {st['id']}: the data model “{conn.name}” is disabled.")
        try:
            checked = sqlguard.check(st["sql"], conn.db_type)
        except sqlguard.SQLBlocked as e:
            raise sqlguard.SQLBlocked(f"Step {st['id']} ({st['source']}): {e}")
        to_run, applied = rowfilter.apply(checked, rowfilter.applicable(db, user, conn) if user is not None else [], conn.db_type, user)
        prepared.append((st, conn, checked, to_run, applied))
    combine_checked = check_combine(plan["combine"], [s["id"] for s in plan["steps"]])

    def one(item):
        st, conn, checked, to_run, applied = item
        try:
            return connectors.run_query(conn, security.decrypt_json(conn.config_enc), to_run, step_cap, cfg["query_timeout_s"])
        except connectors.ConnectorError as e:
            raise type(e)(f"Step {st['id']} ({st['source']}): {e}")

    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(prepared))) as pool:
        results = list(pool.map(one, prepared))          # the first failing step raises here
    steps, total, filters = [], 0, []
    from .engine import _mask
    for (st, conn, checked, to_run, applied), res in zip(prepared, results):
        if res["truncated"]:
            raise LimitError(_limit_msg(f"Step {st['id']} ({conn.name}) would read", step_cap))
        _mask(conn, checked, res)                         # masked values never reach the combine step
        total += len(res["rows"])
        filters += [f for f in applied if f not in filters]
        steps.append({"id": st["id"], "source": st["source"], "data_model": conn.name, "sql": st["sql"], "final_sql": checked.sql,
                      "rows": len(res["rows"]), "ms": res["ms"], "filters": len(applied), "columns": res["columns"], "_rows": res["rows"]})
    if total > total_cap:
        raise LimitError(_limit_msg("Together the steps would read", total_cap))
    out = _combine(steps, combine_checked.sql, cap, cfg["query_timeout_s"])
    out["warnings"] = _warnings(steps, combine_checked, out)
    for s in steps:
        s.pop("_rows")
        s["columns"] = [c["name"] for c in s["columns"]]
    out.update(steps=steps, filters=filters, combine_sql=combine_checked.sql, ms=int((time.time() - t0) * 1000))
    return out


# ---- the combine step: a locked, in-memory DuckDB holding only the step results ------------------------------------------
_TYPES = {"boolean": "BOOLEAN", "date": None, "number": None, "string": "VARCHAR"}


def _unique_names(cols: list[str]) -> list[str]:
    seen, out = {}, []
    for c in cols:
        base = c or "column"
        n = seen.get(base.lower(), 0)
        seen[base.lower()] = n + 1
        out.append(base if n == 0 else f"{base}_{n + 1}")
    return out


def _sql_type(col: dict, values: list) -> str:
    if col.get("masked"):
        return "VARCHAR"
    t = col.get("type")
    if t == "number":
        return "BIGINT" if all(isinstance(v, int) and not isinstance(v, bool) for v in values if v is not None) else "DOUBLE"
    if t == "date":
        return "TIMESTAMP" if any(isinstance(v, str) and len(v) > 10 for v in values if v is not None) else "DATE"
    return _TYPES.get(t) or "VARCHAR"


def _load(con, sid: str, columns: list[dict], rows: list):
    import pandas as pd
    names = _unique_names([c["name"] for c in columns])
    quoted = ['"' + n.replace('"', '""') + '"' for n in names]
    if not rows:        # nothing came back (e.g. filtered away): untyped empty columns, so the combine query still works
        con.execute(f"CREATE VIEW {sid} AS SELECT {', '.join('NULL AS ' + q for q in quoted) or 'NULL AS x'} WHERE false")
        return
    cast = []
    for i, (c, q) in enumerate(zip(columns, quoted)):
        typ = _sql_type(c, [r[i] for r in rows[:2000]])
        cast.append(f"CAST({q} AS VARCHAR) AS {q}" if typ == "VARCHAR" else f"TRY_CAST({q} AS {typ}) AS {q}")
    con.register("_step", pd.DataFrame([[None if v is None else str(v) for v in r] for r in rows], columns=names, dtype=object))
    con.execute(f"CREATE TABLE {sid} AS SELECT {', '.join(cast) or '1 AS x'} FROM _step")
    con.unregister("_step")


def _combine(steps: list[dict], sql: str, cap: int, timeout_s: int) -> dict:
    import duckdb
    con = duckdb.connect(":memory:")
    try:
        for s in steps:
            _load(con, s["id"], s["columns"], s["_rows"])
        con.execute("SET enable_external_access=false")      # the combine step sees the step tables and nothing else
        con.execute("SET lock_configuration=true")
        cur = con.cursor()
        holder = {}

        def work():
            t0 = time.time()
            holder["cancel"] = cur.interrupt
            cur.execute(sql)
            names = [d[0] for d in cur.description or []]
            return connectors._package(names, cur.fetchmany(cap + 1), cap, int((time.time() - t0) * 1000))
        fut = connectors._pool.submit(work)
        try:
            return fut.result(timeout=timeout_s + 5)
        except concurrent.futures.TimeoutError:
            if holder.get("cancel"):
                holder["cancel"]()
            raise connectors.QueryTimeout(f"The combine step exceeded the {timeout_s}s time limit and was cancelled.")
        except connectors.ConnectorError:
            raise
        except Exception as e:
            raise PlanError("Combine step: " + connectors._clean_error(e))
    finally:
        con.close()


def _warnings(steps: list[dict], checked: sqlguard.Checked, out: dict) -> list[str]:
    """Plain warnings: a join that matched nothing, or keys repeated on both sides (rows counted more than once)."""
    warn = []
    tree, ids = checked.tree, {s["id"]: s for s in steps}
    joins = [j for j in tree.find_all(exp.Join)]
    if joins and not out["rows"] and all(s["rows"] for s in steps):
        warn.append("No rows matched between the steps. Check that the right fields are matched and that the key rule fits "
                    "(for example “Strip leading zeros” for 0000100001 = 100001).")
    alias = {}
    for t in tree.find_all(exp.Table):
        if t.name.lower() in ids:
            alias[(t.alias_or_name or t.name).lower()] = t.name.lower()
    for j in joins:
        on = j.args.get("on")
        if on is None:
            continue
        for eq in on.find_all(exp.EQ):
            sides = []
            for side in (eq.left, eq.right):
                cols = list(side.find_all(exp.Column)) if not isinstance(side, exp.Column) else [side]
                if len(cols) != 1 or alias.get((cols[0].table or "").lower()) not in ids:
                    break
                sides.append((ids[alias[cols[0].table.lower()]], cols[0].name))
            if len(sides) != 2 or sides[0][0] is sides[1][0]:
                continue
            if all(_repeats(s, c) for s, c in sides):
                warn.append(f"{sides[0][0]['id']}.{sides[0][1]} and {sides[1][0]['id']}.{sides[1][1]} both repeat values, so joined "
                            "rows can be counted more than once. Totals may be too high; ask for one row per key in one of the steps.")
    return list(dict.fromkeys(warn))


def _repeats(step: dict, column: str) -> bool:
    names = [c["name"].lower() for c in step["columns"]]
    if column.lower() not in names:
        return False
    i = names.index(column.lower())
    vals = [r[i] for r in step["_rows"] if r[i] is not None]
    return len(vals) != len(set(vals))


def plan_dto(plan: dict | None) -> dict | None:
    """What the answer panel shows: each step with its source, SQL, rows, time and filters, then the combine SQL."""
    if not plan:
        return None
    return {"steps": [{k: s.get(k) for k in ("id", "source", "data_model", "sql", "rows", "ms", "filters", "columns")} for s in plan["steps"]],
            "combine": plan["combine"], "edited": bool(plan.get("generated")) and not same(plan, plan["generated"])}
