"""Answers across a combined data model: a *plan* of steps, one SELECT per step on one member data model, and a
*combine* SELECT that joins the step results on this server.

    plan = {"steps": [{"id": "s1", "source": "sap", "sql": "..."}, ...], "combine": "SELECT ... FROM s1 JOIN s2 ON ..."}

Every step goes through the same path as a single-model question: `sqlguard.check` for the member's dialect, the
person's row filters for that member (`rowfilter`), `connectors.run_query` and the member's masked columns. Masked
values are replaced *before* the results are combined, so nothing the person may not see can come out of the combine
step. Step results are loaded into a new in-memory DuckDB with external access switched off and the configuration
locked; the combine SQL is checked read-only and may only name step tables. Nothing here talks to the AI model.

Passing keys between steps (phase 5): a step may filter on the values another, *earlier* step returned, written as
`col IN ({{s1.column}})` or `col IN ({{s1.column|strip_zeros}})` (a key rule from matching.NORMALISATIONS). The earlier step
runs first, for this person, with their filters and masking; its distinct non-empty values (at most `combined_max_keys`) are
inserted by sqlglot as literals of the receiving data model's dialect - never by string concatenation - and the filled SQL is
parsed again and must contain exactly those values, in the same places, before it goes through the read-only guard and the
person's row filters like any step. Masked columns cannot be passed, nor values containing a backslash or NUL (databases
disagree on backslash escapes). The AI model never sees the keys: plans keep the placeholder, and errors are scrubbed.
"""
import concurrent.futures
import decimal
import re
import time

import sqlglot
from sqlglot import exp
from sqlalchemy.orm import Session

from . import connectors, matching, rowfilter, security, sqlguard
from .models import Connection

MAX_STEPS = 8
STEP_ID = re.compile(r"^s[1-9]$")
KEY_REF = re.compile(r"\{\{\s*(s[1-9])\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|\s*([a-z_]+)\s*)?\}\}")
SENTINEL = "askdata_key_{}_x"


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
        for ref, col, rule in KEY_REF.findall(sql):
            if ref not in seen:
                raise PlanError(f"Step {sid} uses keys from {ref}, which must be an earlier step of the plan.")
            if (rule or "") not in matching.NORMALISATIONS:
                raise PlanError(f"Step {sid}: “{rule}” is not a key rule; use one of {', '.join(r for r in matching.NORMALISATIONS if r)}.")
        if "{{" in KEY_REF.sub("", sql):
            raise PlanError(f"Step {sid}: write keys from another step as {{{{s1.column}}}} or {{{{s1.column|strip_zeros}}}}.")
        seen.add(sid)
        steps.append({"id": sid, "source": source, "sql": sql})
    combine = sqlguard._strip(str(raw.get("combine") or ""))
    if "{{" in combine:
        raise PlanError("Keys from a step can only be used inside another step, not in the combine query (join the step tables there).")
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


# ---- passing keys between steps -------------------------------------------------------------------------------------------
def refs(sql: str) -> list[tuple[str, str, str]]:
    return [(r, c, k or "") for r, c, k in KEY_REF.findall(sql)]


def _key_values(step: dict, column: str, rule: str, max_keys: int, sid: str) -> list:
    """The distinct, non-empty values of an earlier step's column, after the key rule. Raises PlanError / LimitError."""
    cols = [c["name"].lower() for c in step["columns"]]
    if column.lower() not in cols:
        raise PlanError(f"Step {sid} uses {{{{{step['id']}.{column}}}}}, but step {step['id']} returns no column “{column}”"
                        f" (it returns: {', '.join(c['name'] for c in step['columns'])}).")
    i = cols.index(column.lower())
    if step["columns"][i].get("masked"):
        raise PlanError(f"Step {sid} cannot use {step['id']}.{column} as keys: the column is masked, and matching on its values "
                        "would reveal them.")
    out, seen = [], set()
    for row in step["_rows"]:
        v = row[i]
        if v is None or v == "":
            continue
        if rule:
            v = matching.normalise(rule, v)
            if v is None or v == "":
                continue
        if isinstance(v, bool):
            v = str(v).lower()
        if isinstance(v, float):
            v = int(v) if v.is_integer() else v
        if isinstance(v, str) and ("\\" in v or "\x00" in v):
            raise PlanError(f"A key in {step['id']}.{column} contains a backslash or a control character, which cannot be passed "
                            "safely to another data model. Join the steps in the combine query instead.")
        k = (type(v).__name__ if not isinstance(v, (int, float, decimal.Decimal)) else "n", str(v))
        if k not in seen:
            seen.add(k)
            out.append(v)
    if len(out) > max_keys:
        raise LimitError(f"Step {step['id']} returned more than {max_keys:,} different values of {column} to pass to step {sid}. "
                         "Narrow the first step (for example a shorter period or one region), or join the steps in the combine "
                         "query instead. An administrator can change the limit under Admin → Settings → Combined data models.")
    return out


def _literal(v) -> exp.Expression:
    if isinstance(v, (int, decimal.Decimal)) or (isinstance(v, float) and v == v and v not in (float("inf"), float("-inf"))):
        text = format(v, "f") if isinstance(v, decimal.Decimal) else repr(v) if isinstance(v, float) else str(v)
        if not re.fullmatch(r"-?\d+(\.\d+)?(e-?\d+)?", text, re.I):
            raise PlanError("A key value is not a plain number.")
        return exp.Literal.number(text)
    return exp.Literal.string(str(v))


def fill_keys(sql: str, db_type: str, values: dict[int, list]) -> str:
    """Put each placeholder's values into the step's SQL as literals of its dialect. Each placeholder must be the whole
    list of an IN (...). The result is parsed again and must hold exactly these values in those places."""
    dialect = sqlguard.SQLGLOT_DIALECT.get(db_type)
    n = iter(range(10_000))
    template = KEY_REF.sub(lambda m: SENTINEL.format(next(n)), sql)
    try:
        tree = sqlglot.parse_one(template, read=dialect)
    except Exception:
        raise PlanError("A step that uses keys from another step could not be read; write it as one plain SELECT.")
    ins = []
    for idx in values:
        name = SENTINEL.format(idx)
        nodes = [c for c in tree.find_all(exp.Column) if c.name.lower() == name]
        if len(nodes) != 1:
            raise PlanError("Keys from another step must be written as the whole list of an IN, for example "
                            "WHERE customer IN ({{s1.customer}}), outside quotes.")
        col = nodes[0]
        parent = col.parent
        if not isinstance(parent, exp.In) or parent.args.get("query") or len(parent.expressions) != 1 or parent.expressions[0] is not col:
            raise PlanError("Keys from another step must be written as the whole list of an IN, for example "
                            "WHERE customer IN ({{s1.customer}}).")
        ins.append((parent, values[idx]))
    expected = []
    for node, vals in ins:
        if vals:
            node.set("expressions", [_literal(v) for v in vals])
            expected.append([(lit.is_string, lit.this) for lit in node.expressions])
        else:       # nothing to match: IN () is never true (NOT IN () always is)
            node.replace(exp.Paren(this=exp.EQ(this=exp.Literal.number(1), expression=exp.Literal.number(0))))
    filled = tree.sql(dialect=dialect)
    # the safety check: read the filled SQL back and compare every inserted list, in order, with what was inserted
    try:
        back = sqlglot.parse_one(filled, read=dialect)
    except Exception:
        raise PlanError("The keys could not be inserted safely.")
    lists = [[(lit.is_string, lit.this) for lit in i.expressions] for i in back.find_all(exp.In)
             if i.expressions and all(isinstance(e, exp.Literal) for e in i.expressions)]
    if "askdata_key_" in filled.lower() or \
            [x for x in lists if x in expected] != expected or sum(len(x) for x in expected) > sum(len(x) for x in lists):
        raise PlanError("The keys could not be inserted safely.")
    return filled


def _limit_msg(what: str, limit: int) -> str:
    return (f"{what} more than {limit:,} rows, the limit for questions across data models. Ask for totals rather than "
            "detail (for example per customer or per month), or for a shorter period. An administrator can change the limit "
            "under Admin → Settings → Combined data models.")


def run(db: Session, combined: Connection, plan: dict, cfg: dict, user, cap: int) -> dict:
    """Run a cleaned plan for this person. Returns a result like `connectors.run_query` plus
    {"steps": [...], "filters": [...], "warnings": [...], "combine_sql"}. Raises SQLBlocked / ConnectorError / PlanError.
    Steps that use keys from earlier steps run after them; the others run side by side."""
    members = members_by_alias(db, combined)
    step_cap, total_cap = int(cfg["combined_step_max_rows"]), int(cfg["combined_total_max_rows"])
    max_keys = int(cfg.get("combined_max_keys") or 1000)
    for st in plan["steps"]:
        conn = members.get(st["source"])
        if conn is None:
            raise PlanError(f"Step {st['id']}: the data model “{st['source']}” is no longer part of this combined model.")
        if not conn.is_active:
            raise PlanError(f"Step {st['id']}: the data model “{conn.name}” is disabled.")
        if not refs(st["sql"]):         # guard every step that can be checked now, before anything runs
            try:
                sqlguard.check(st["sql"], conn.db_type)
            except sqlguard.SQLBlocked as e:
                raise sqlguard.SQLBlocked(f"Step {st['id']} ({st['source']}): {e}")
    combine_checked = check_combine(plan["combine"], [s["id"] for s in plan["steps"]])
    from .engine import _mask

    def prepare(st):
        conn = members[st["source"]]
        sql, keys = st["sql"], None
        found = refs(sql)
        if found:
            vals = {i: _key_values(done[r], c, k, max_keys, st["id"]) for i, (r, c, k) in enumerate(found)}
            sql = fill_keys(sql, conn.db_type, vals)
            keys = [{"from": f"{r}.{c}", "rule": k, "count": len(vals[i])} for i, (r, c, k) in enumerate(found)]
        try:
            checked = sqlguard.check(sql, conn.db_type)
        except sqlguard.SQLBlocked as e:
            raise sqlguard.SQLBlocked(f"Step {st['id']} ({st['source']}): {e}")
        to_run, applied = rowfilter.apply(checked, rowfilter.applicable(db, user, conn) if user is not None else [], conn.db_type, user)
        return st, conn, checked, to_run, applied, keys

    def one(item):
        st, conn, checked, to_run, applied, keys = item
        try:
            return connectors.run_query(conn, security.decrypt_json(conn.config_enc), to_run, step_cap, cfg["query_timeout_s"])
        except connectors.ConnectorError as e:
            raise type(e)(f"Step {st['id']} ({st['source']}): {e}")

    t0 = time.time()
    done, total, filters, waiting = {}, 0, [], list(plan["steps"])
    while waiting:
        wave = [st for st in waiting if all(r in done for r, _, _ in refs(st["sql"]))]
        if not wave:
            raise PlanError("The steps depend on each other in a circle; a step can only use keys from an earlier step.")
        prepared = [prepare(st) for st in wave]
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(prepared))) as pool:
            results = list(pool.map(one, prepared))      # the first failing step raises here
        for (st, conn, checked, to_run, applied, keys), res in zip(prepared, results):
            if res["truncated"]:
                raise LimitError(_limit_msg(f"Step {st['id']} ({conn.name}) would read", step_cap))
            _mask(conn, checked, res)                     # masked values never reach a later step or the combine step
            total += len(res["rows"])
            filters += [f for f in applied if f not in filters]
            done[st["id"]] = {"id": st["id"], "source": st["source"], "data_model": conn.name, "sql": st["sql"],
                              "rows": len(res["rows"]), "ms": res["ms"], "filters": len(applied), "columns": res["columns"],
                              "_rows": res["rows"], **({"keys": keys} if keys else {})}
        if total > total_cap:
            raise LimitError(_limit_msg("Together the steps would read", total_cap))
        waiting = [st for st in waiting if st["id"] not in done]
    steps = [done[st["id"]] for st in plan["steps"]]
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
    return {"steps": [{k: s.get(k) for k in ("id", "source", "data_model", "sql", "rows", "ms", "filters", "columns", "keys")} for s in plan["steps"]],
            "combine": plan["combine"], "edited": bool(plan.get("generated")) and not same(plan, plan["generated"])}
