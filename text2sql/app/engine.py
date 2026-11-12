"""The question -> SQL -> result pipeline.

Privacy boundary: `build_prompt` is the only place content is assembled for the model.
It contains schema metadata, approved training text, earlier questions + SQL, and the
new question. Query results are never included. Database error text used for automatic
repair is scrubbed of literals first (`scrub_error`).
"""
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import connectors, llm, retrieval, rowfilter, security, sqlguard, summarize
from .models import Connection, LLMModel, QueryRun, TrainingItem

MAX_FULL_SCHEMA_TABLES = 40
SCHEMA_CHAR_BUDGET = 60_000

SYSTEM = """You translate business questions into a single read-only SQL query for a {dialect} database.

Rules:
- Use only the tables and columns in the schema provided. Never invent names.
- Write one SELECT statement (CTEs allowed) in valid {dialect} syntax. No DDL, DML or multiple statements.
- Prefer the patterns in the verified example queries and follow the business documentation when it defines a term or metric.
- Give result columns clear, readable aliases. Aggregate and order results so they answer the question directly.
- Unless the question asks for every row, limit detail listings to {max_rows} rows using {dialect} syntax.
- You never see the data. Do not guess literal values that are not in the schema notes, documentation or examples; if a filter value is unknown, match case-insensitively or ask.
- If the question cannot be answered from this schema, or is too ambiguous to answer responsibly, do not write SQL; ask one short clarifying question instead.

Reply with a single JSON object and nothing else:
{{"sql": "<the query, or empty string>", "explanation": "<one or two sentences on how the query answers the question>", "followups": ["<3 natural next questions a business user might ask of this same data>"], "clarification": "<question for the user, only when sql is empty>"}}"""


def scrub_error(msg: str) -> str:
    """Remove literal values from a database error before it is shown to the model."""
    msg = re.sub(r"'(?:[^']|'')*'", "'?'", msg or "")
    msg = re.sub(r"\b\d{3,}\b", "N", msg)
    msg = re.sub(r"(?i)(detail|context|hint):.*", "", msg, flags=re.S)
    return msg.strip()[:400]


def _approved(db: Session, conn_id: int, kind: str) -> list[TrainingItem]:
    return list(db.scalars(select(TrainingItem).where(
        TrainingItem.connection_id == conn_id, TrainingItem.kind == kind, TrainingItem.status == "approved")))


def build_prompt(db: Session, conn: Connection, question: str, history: list[QueryRun], max_rows: int):
    """Returns (system, user, context_summary)."""
    tables = (conn.schema_json or {}).get("tables", [])
    pairs = _approved(db, conn.id, "sql_pair")
    docs = _approved(db, conn.id, "documentation") + _approved(db, conn.id, "document")
    extra_ddl = _approved(db, conn.id, "ddl")
    search = question + " " + " ".join(h.question for h in history[-2:])

    ex = retrieval.top(search, pairs, lambda p: p.question + " " + p.sql, 6)
    doc_hits = retrieval.top(search, docs, lambda d: d.title + " " + d.content, 6)

    ddl_all = [(t, connectors.table_ddl(t)) for t in tables]
    if len(tables) <= MAX_FULL_SCHEMA_TABLES and sum(len(d) for _, d in ddl_all) <= SCHEMA_CHAR_BUDGET:
        chosen = ddl_all
    else:   # large schema: send the most relevant tables + any used by the retrieved examples
        hint = search + " " + " ".join(p.sql for p in ex)
        ranked = retrieval.top(hint, ddl_all, lambda x: x[1].replace("_", " "), 15)
        names = {connectors.table_fqn(t) for t, _ in ranked}
        example_sql = " ".join(p.sql for p in ex).lower()
        for t, d in ddl_all:
            if connectors.table_fqn(t) not in names and re.search(rf"\b{re.escape(t['name'].lower())}\b", example_sql):
                ranked.append((t, d))
        chosen, used = [], 0
        for t, d in ranked:
            if used + len(d) > SCHEMA_CHAR_BUDGET:
                break
            chosen.append((t, d))
            used += len(d)

    parts = ["## Database schema"]
    if not chosen and not extra_ddl:
        parts.append("(no schema has been synced for this data model)")
    parts += [d for _, d in chosen]
    parts += [f"-- {d.title}\n{d.content}" for d in extra_ddl]
    if len(chosen) < len(tables):
        others = [connectors.table_fqn(t) for t, _ in ddl_all if (t, _) not in chosen][:200]
        parts.append("Other tables that exist (columns not shown): " + ", ".join(others))
    if doc_hits:
        parts.append("\n## Business documentation")
        parts += [f"### {d.title or d.document_name or 'Note'}\n{d.content}" for d in doc_hits]
    if ex:
        parts.append("\n## Verified example queries")
        parts += [f"Question: {p.question}\nSQL:\n{p.sql}" for p in ex]
    stable = "\n\n".join(parts)

    tail = []
    if history:
        tail.append("## Conversation so far (the new question may refer back to it)")
        for h in history[-3:]:
            tail.append(f"Question: {h.question}\nSQL:\n{h.final_sql or h.generated_sql}")
    tail.append(f"## Question\n{question}")

    system = SYSTEM.format(dialect=connectors.DIALECT_NAME[conn.db_type], max_rows=max_rows) + "\n\n" + stable
    context = {"tables": [connectors.table_fqn(t) for t, _ in chosen], "examples": [p.id for p in ex],
               "docs": [d.id for d in doc_hits], "history_turns": min(len(history), 3)}
    return system, "\n\n".join(tail), context


def _mask(conn: Connection, checked, res: dict):
    """Hide the values of masked columns in a result, in place."""
    names = [c["name"] for c in res["columns"]]
    masked = sqlguard.masked_output_columns(checked, names, conn.masked_columns or [])
    for row in res["rows"]:
        for i in masked:
            if row[i] is not None:
                row[i] = "••••••"
    for i in masked:
        res["columns"][i].update(type="string", masked=True, role="dimension")
        res["columns"][i].pop("additive", None)


def run_sql(db: Session, conn: Connection, sql: str, cfg: dict, user) -> dict:
    """Guard, apply the user's data filters, run and mask. Used for stored SQL (reports).
    Raises sqlguard.SQLBlocked / connectors.ConnectorError."""
    checked = sqlguard.check(sql, conn.db_type)
    to_run, applied = rowfilter.apply(checked, rowfilter.applicable(db, user, conn), conn.db_type, user)
    res = connectors.run_query(conn, security.decrypt_json(conn.config_enc), to_run, cfg["max_rows"], cfg["query_timeout_s"])
    _mask(conn, checked, res)
    res["filters"] = applied
    res["summary"] = summarize.summarize(res["columns"], res["rows"], res["truncated"])
    return res


def _call(run: QueryRun, model: LLMModel, system: str, user: str) -> dict:
    res = llm.complete(model, system, user)
    run.attempts += 1
    run.input_tokens += res.input_tokens
    run.output_tokens += res.output_tokens
    run.llm_ms += res.ms
    run.cost += (res.input_tokens * model.price_in + res.output_tokens * model.price_out) / 1_000_000
    return llm.parse_answer(res.text)


def generate(db: Session, run: QueryRun, conn: Connection, model: LLMModel, history: list[QueryRun], cfg: dict):
    """Ask the model for SQL; fills run.generated_sql / status. Does not execute."""
    system, user, context = build_prompt(db, conn, run.question, history, cfg["max_rows"])
    run.context = context
    try:
        ans = _call(run, model, system, user)
    except llm.LLMError as e:
        run.status, run.error = "error", str(e)
        return None
    run.explanation, run.followups = ans["explanation"], ans["followups"]
    if not ans["sql"]:
        run.status = "clarification"
        run.explanation = ans["clarification"] or "I could not write a query for that. Could you rephrase the question?"
        return None
    run.generated_sql = run.final_sql = sqlguard._strip(ans["sql"])
    run.status = "pending_review"
    return system, user


def execute(db: Session, run: QueryRun, conn: Connection, cfg: dict, model: LLMModel | None = None,
            prompt: tuple | None = None, user=None):
    """Guard and run run.final_sql on the source. With `model` and `prompt`, a failing
    model-written query is sent back for repair (error text scrubbed) up to N times."""
    conn_cfg = security.decrypt_json(conn.config_enc)
    repairs_left = cfg["max_repair_attempts"] if (model and prompt and not run.edited) else 0
    filters = rowfilter.applicable(db, user, conn) if user is not None else []
    applied: list[int] = []
    while True:
        problem = None
        try:
            checked = sqlguard.check(run.final_sql, conn.db_type)
            to_run, applied = rowfilter.apply(checked, filters, conn.db_type, user)
            res = connectors.run_query(conn, conn_cfg, to_run, cfg["max_rows"], cfg["query_timeout_s"])
        except sqlguard.SQLBlocked as e:
            problem, status = str(e), "blocked"
        except connectors.ConnectorError as e:
            problem, status = str(e), "error"
        if problem is None:
            break
        if repairs_left <= 0 or isinstance(problem, str) and "time limit" in problem:
            run.status, run.error = status, problem
            return
        repairs_left -= 1
        fix = (f"{prompt[1]}\n\n## Your previous attempt failed\nSQL:\n{run.final_sql}\n\n"
               f"Error: {problem if status == 'blocked' else scrub_error(problem)}\n\n"
               "Return corrected JSON in the same format.")
        try:
            ans = _call(run, model, prompt[0], fix)
        except llm.LLMError:
            run.status, run.error = status, problem
            return
        if not ans["sql"]:
            run.status, run.error = status, problem
            return
        run.generated_sql = run.final_sql = sqlguard._strip(ans["sql"])
        run.explanation = ans["explanation"] or run.explanation
        run.followups = ans["followups"] or run.followups

    _mask(conn, checked, res)
    run.final_sql = checked.sql
    run.context = {**(run.context or {}), "filters": applied}      # which row filters were enforced
    run.status, run.error = "success", ""
    run.columns, run.row_count, run.truncated, run.db_ms = res["columns"], len(res["rows"]), res["truncated"], res["ms"]
    run.summary = summarize.summarize(res["columns"], res["rows"], res["truncated"])
    if not run.chart:
        run.chart = summarize.suggest_chart(res["columns"], res["rows"])
    run.result_rows = res["rows"] if cfg["store_results"] else None
    return res["rows"]
