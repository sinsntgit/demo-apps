"""The question -> SQL -> result pipeline.

Privacy boundary: `build_prompt`, `build_plan_prompt` (combined data models) and the smaller `build_rephrase_prompt` are the
only places content is assembled for the model.
It contains schema metadata, confirmed join paths and entities from the metadata graph (names and keys only),
approved training text, earlier questions + SQL, and the
new question. Query results are never included. Database error text used for automatic
repair is scrubbed of literals first (`scrub_error`).
"""
import logging
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

import concurrent.futures
import json

from . import connectors, graph, llm, matching, predict, retrieval, rowfilter, security, sqlguard, summarize
from .models import Connection, GraphEdge, LLMModel, QueryRun, TrainingItem

log = logging.getLogger("text2sql.engine")

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

{predictive}
Reply with a single JSON object and nothing else:
{{"sql": "<the query, or empty string>", "explanation": "<one or two sentences on how the query answers the question>", "followups": ["<3 natural next questions a business user might ask of this same data>"], "clarification": "<question for the user, only when sql is empty>"{analysis_key}}}"""

PREDICTIVE = """
Predictive questions
When - and only when - the question asks to forecast or project something, predict or classify an outcome, explain what drives something, segment / cluster / group similar items, or find anomalies / outliers, also return an "analysis" object. The platform runs the statistics itself on the rows your SQL returns; you only choose the method and name the columns. For these questions the SQL must return the *input data set* for the analysis - not a finished answer - with every relevant history row and no row limit:
- Forecast: {{"type": "forecast", "date": "<period column>", "target": "<measure>", "horizon": <periods ahead the user asked for, or null>}}. SQL: one row per period (the grain the question implies; month if unstated), all available history, ordered by period.
- Predict a category: {{"type": "classification", "target": "<outcome column>", "id": "<row identifier or null>"}}. Predict a number: same with "type": "regression". SQL: one row per item (customer, order, product...) with the outcome and the attributes that might explain it and are known before the outcome happens. Leave the outcome NULL for items whose outcome is not yet known.
- What drives X: {{"type": "drivers", "target": "<X>"}}. SQL as for prediction.
- Segments / clusters: {{"type": "clustering", "id": "<row identifier>", "k": <number of segments if the user gave one, else null>}}. SQL: one row per item with descriptive numeric and categorical columns.
- Anomalies: unusual periods -> {{"type": "anomaly", "date": "<period column>", "target": "<measure>"}} with one row per period; unusual items -> {{"type": "anomaly", "id": "<row identifier>"}} with one row per item.
Column names inside "analysis" must be exactly the aliases your SQL returns. Add "features": [...] only to restrict the inputs to specific columns. For every other question "analysis" must be null.
"""


PLAN_SYSTEM = """You answer business questions that may need data from several separate data models (different databases or file folders) by writing a short plan of SQL steps.

How a plan runs:
- Each step is ONE read-only SELECT (CTEs allowed) on ONE data model, in that data model's SQL dialect, using only its tables and columns. Steps cannot see each other.
- The platform runs the steps, then runs your "combine" query in DuckDB SQL over the step results, which are available as tables named after the steps (s1, s2, ...). The combine query can only use those tables.
- Use one step per data model you need. If one data model is enough, write one step and combine "SELECT * FROM s1".

Rules:
- Each step may return at most {step_rows} rows and all steps together at most {total_rows}. Aggregate inside the steps (for example totals per customer or per month) and return detail rows only when the question asks for them.
- Every step must return the columns the combine query joins on, under clear aliases.
- Join steps only on the matches listed under "Matches between data models", and apply each match's key rule exactly as given there (the systems store the same key differently).
- Write each step in its own dialect; write the combine query in DuckDB SQL. Give the final columns clear, readable aliases and order the result so it answers the question. Unless the question asks for every row, limit detail listings to {max_rows} rows in the combine query.
- Prefer the patterns in each data model's verified example queries and follow its business documentation.
- You never see the data. Do not guess literal values that are not in the schema notes, documentation or examples.
- If the question cannot be answered from these data models, or is too ambiguous, do not write a plan; ask one short clarifying question instead.

{predictive}
Reply with a single JSON object and nothing else:
{{"steps": [{{"id": "s1", "source": "<data model short name>", "sql": "<SELECT for that data model>"}}], "combine": "<DuckDB SELECT over s1, s2, ...>", "explanation": "<one or two sentences on how the plan answers the question>", "followups": ["<3 natural next questions>"], "clarification": "<question for the user, only when there are no steps>"{analysis_key}}}"""

REPHRASE_SYSTEM = """You rewrite a business user's question so that a text-to-SQL assistant can answer it precisely and on the first attempt. You do not answer the question and you do not write SQL.

Make the question self-contained and specific:
- Name the measure, the grouping, any filters and the time period the user means, using the business terms and the names of things listed below.
- Turn references to the conversation so far ("that", "same for last year", "split it by region") into a complete question.
- Fix spelling, expand abbreviations, remove filler words.
- Keep the user's intent and language. Never add a filter, period, ranking or limit the user did not ask for or clearly imply. If something important is missing (for example which period), keep that part general and say so in "unclear".
- One or two sentences at most.

Reply with a single JSON object and nothing else:
{"question": "<the rewritten question>", "changes": "<a few words on what you changed>", "unclear": "<what the user may still want to specify, or empty>"}"""

REPHRASE_SCHEMA_BUDGET = 4000


def build_rephrase_prompt(db: Session, conn: Connection, question: str, history: list[str], similar: list[str]):
    """A deliberately small prompt: table and column names (no types, DDL or comments), the titles of the
    business documentation, a few similar verified questions and earlier questions - never SQL, data or results.
    Returns (system, user)."""
    srcs = [(m.alias + ".", c) for m, c in matching.members(db, conn)] if conn.db_type == "combined" else [("", conn)]
    lines = [f"{pre}{connectors.table_fqn(t)}({', '.join(c['name'] for c in t['columns'])})"
             for pre, src in srcs for t in (src.schema_json or {}).get("tables", [])]
    if sum(len(x) for x in lines) > REPHRASE_SCHEMA_BUDGET:
        lines = retrieval.top(question + " " + " ".join(history[-2:]), lines, lambda x: x.replace("_", " "), 25)
    out, used = [], 0
    for x in lines:
        if used + len(x) > REPHRASE_SCHEMA_BUDGET:
            break
        out.append(x)
        used += len(x)
    terms = [d.title for _, src in srcs for d in _approved(db, src.id, "documentation") if d.title][:40]
    parts = [f"## Data model\n{conn.name}" + (f" - {conn.description}" if conn.description else ""),
             "## Tables and columns\n" + ("\n".join(out) or "(not synced)")]
    if terms:
        parts.append("## Business terms defined for this data\n" + "; ".join(terms))
    if similar:
        parts.append("## Verified questions that are similar (reuse their wording where it fits)\n" + "\n".join(f"- {q}" for q in similar))
    if history:
        parts.append("## Earlier questions in this conversation\n" + "\n".join(f"- {q}" for q in history[-2:]))
    parts.append(f"## Question to rewrite\n{question}")
    return REPHRASE_SYSTEM, "\n\n".join(parts)


def similar_questions(db: Session, conn_id: int, question: str, k: int = 3) -> list[str]:
    """Verified example questions close to this one - found locally, no model call."""
    pairs = _approved(db, conn_id, "sql_pair")
    want = set(retrieval.tokens(question))
    if not want:
        return []
    hits = retrieval.top(question, pairs, lambda p: p.question, k * 3)
    out = []
    for p in hits:      # at least half of the question's words must appear in the example
        if len(want & set(retrieval.tokens(p.question))) / len(want) >= 0.5 and p.question not in out:
            out.append(p.question)
    return out[:k]


def rephrase(db: Session, conn: Connection, model: LLMModel, question: str, history: list[str], log) -> dict:
    """Ask the model for a better wording; fills the RephraseLog `log` with tokens and cost."""
    similar = similar_questions(db, conn.id, question)
    system, user = build_rephrase_prompt(db, conn, question, history, similar)
    log.model_id, log.model_label = model.id, model.name
    try:
        res = llm.complete(model, system, user)
    except llm.LLMError as e:
        log.status, log.error = "error", str(e)
        return {"similar": similar, "error": str(e)}
    log.input_tokens, log.output_tokens, log.llm_ms = res.input_tokens, res.output_tokens, res.ms
    log.cost = (res.input_tokens * model.price_in + res.output_tokens * model.price_out) / 1_000_000
    obj = llm.parse_json(res.text)
    new = " ".join(str(obj.get("question") or "").split())[:4000]
    if not new:
        log.status, log.error = "error", "The model did not return a rewritten question."
        return {"similar": similar, "error": "The AI model did not suggest a new wording. Try again or ask as written."}
    log.rephrased = new
    for q in similar_questions(db, conn.id, new):     # the clearer wording often matches verified questions the original did not
        if q not in similar and q.strip().lower() != new.strip().lower():
            similar.append(q)
    return {"question": new, "changes": str(obj.get("changes") or "").strip()[:300],
            "unclear": str(obj.get("unclear") or "").strip()[:300], "similar": similar[:3]}


def build_plan_prompt(db: Session, combined: Connection, question: str, history: list[QueryRun], cfg: dict,
                      predictive: bool = True):
    """The prompt for a combined data model: per member data model the same knowledge a single-model question gets
    (schema, join paths, documentation, verified examples - metadata and approved training only), the confirmed matches
    between them with their key rules, earlier questions with their plans, and the question. Never data or results.
    Returns (system, user, context_summary)."""
    from . import planner
    ms = matching.members(db, combined)
    budget = max(20_000, SCHEMA_CHAR_BUDGET * 2 // max(len(ms), 1))
    earlier = [h.question for h in history]
    parts, context = [], {"members": {}}
    for m, conn in ms:
        text, ctx = _knowledge(db, conn, question, earlier, budget)
        parts.append(f"# Data model `{m.alias}`: {conn.name} - {connectors.DIALECT_NAME[conn.db_type]} SQL"
                     + (f"\n{conn.description}" if conn.description else "") + "\n\n" + text)
        context["members"][m.alias] = ctx
    alias = {conn.id: m.alias for m, conn in ms}
    lines = []
    for e in db.scalars(select(GraphEdge).where(GraphEdge.kind == "match", GraphEdge.status == "confirmed",
                                                GraphEdge.left_connection_id.in_(list(alias)), GraphEdge.right_connection_id.in_(list(alias)))):
        la, ra = alias[e.left_connection_id], alias[e.right_connection_id]
        rule = e.normalisation or ""
        cmp = " AND ".join(f"{matching.duck_expr(rule, '<' + la + ' step>.' + lc)} = {matching.duck_expr(rule, '<' + ra + ' step>.' + rc)}"
                           for lc, rc in zip(e.left_columns, e.right_columns))
        lines.append(f"- {la}.{e.left_table}.{', '.join(e.left_columns)} = {ra}.{e.right_table}.{', '.join(e.right_columns)}"
                     f" (key rule: {matching.NORMALISATIONS.get(rule, rule)}{'; ' + e.cardinality if e.cardinality else ''})."
                     f" In the combine query join with: {cmp}")
    parts.append("# Matches between data models\n" + ("\n".join(lines) or "(none confirmed - only questions about one data model can be answered)"))
    context["matches"] = len(lines)
    # the combined model's own training: business notes that span the data models, and verified question -> plan examples
    search = question + " " + " ".join(earlier[-2:])
    notes = retrieval.top(search, _approved(db, combined.id, "documentation"), lambda d: d.title + " " + d.content, 4)
    if notes:
        parts.append("# Business documentation for questions across these data models\n" +
                     "\n\n".join(f"### {d.title or 'Note'}\n{d.content}" for d in notes))
    examples = retrieval.top(search, [p for p in _approved(db, combined.id, "sql_pair") if p.plan],
                             lambda p: p.question + " " + p.sql, 4)
    if examples:
        parts.append("# Verified example plans (follow their patterns)\n" + "\n\n".join(
            f"Question: {p.question}\nPlan: " + json.dumps({"steps": p.plan["steps"], "combine": p.plan["combine"]}, ensure_ascii=False)
            for p in examples))
    context.update(examples=[p.id for p in examples], docs=[d.id for d in notes])
    tail = []
    if history:
        tail.append("## Conversation so far (the new question may refer back to it)")
        for h in history[-3:]:
            tail.append(f"Question: {h.question}\nPlan:\n{h.final_sql or h.generated_sql}")
    tail.append(f"## Question\n{question}")
    system = PLAN_SYSTEM.format(step_rows=f"{int(cfg['combined_step_max_rows']):,}", total_rows=f"{int(cfg['combined_total_max_rows']):,}",
                                max_rows=cfg["max_rows"], predictive=PREDICTIVE.format().replace("your SQL", "your combine query") if predictive else "",
                                analysis_key=', "analysis": <object as described above, or null>' if predictive else "")
    context["history_turns"] = min(len(history), 3)
    return system + "\n\n" + "\n\n".join(parts), "\n\n".join(tail), context


def scrub_error(msg: str) -> str:
    """Remove literal values from a database error before it is shown to the model."""
    msg = re.sub(r"'(?:[^']|'')*'", "'?'", msg or "")
    msg = re.sub(r"\b\d{3,}\b", "N", msg)
    msg = re.sub(r"(?i)(detail|context|hint):.*", "", msg, flags=re.S)
    return msg.strip()[:400]


def _approved(db: Session, conn_id: int, kind: str) -> list[TrainingItem]:
    return list(db.scalars(select(TrainingItem).where(
        TrainingItem.connection_id == conn_id, TrainingItem.kind == kind, TrainingItem.status == "approved")))


def build_prompt(db: Session, conn: Connection, question: str, history: list[QueryRun], max_rows: int,
                 predictive: bool = True):
    """Returns (system, user, context_summary)."""
    stable, context = _knowledge(db, conn, question, [h.question for h in history])
    tail = []
    if history:
        tail.append("## Conversation so far (the new question may refer back to it)")
        for h in history[-3:]:
            tail.append(f"Question: {h.question}\nSQL:\n{h.final_sql or h.generated_sql}")
    tail.append(f"## Question\n{question}")

    system = SYSTEM.format(dialect=connectors.DIALECT_NAME[conn.db_type], max_rows=max_rows,
                           predictive=PREDICTIVE.format() if predictive else "",
                           analysis_key=', "analysis": <object as described above, or null>' if predictive else "") + "\n\n" + stable
    context["history_turns"] = min(len(history), 3)
    return system, "\n\n".join(tail), context


def _knowledge(db: Session, conn: Connection, question: str, earlier: list[str], budget: int = SCHEMA_CHAR_BUDGET):
    """What the model is told about one data model: schema, join paths, documentation, verified examples
    (metadata and approved training only - never data). Returns (text, context_summary)."""
    tables = (conn.schema_json or {}).get("tables", [])
    pairs = _approved(db, conn.id, "sql_pair")
    docs = _approved(db, conn.id, "documentation") + _approved(db, conn.id, "document")
    extra_ddl = _approved(db, conn.id, "ddl")
    search = question + " " + " ".join(earlier[-2:])

    ex = retrieval.top(search, pairs, lambda p: p.question + " " + p.sql, 6)
    doc_hits = retrieval.top(search, docs, lambda d: d.title + " " + d.content, 6)

    ddl_all = [(t, connectors.table_ddl(t)) for t in tables]
    hint = search + " " + " ".join(p.sql for p in ex)
    example_sql = " ".join(p.sql for p in ex).lower()
    in_examples = [t for t, _ in ddl_all if re.search(rf"\b{re.escape(t['name'].lower())}\b", example_sql)]
    g = {"text": "", "tables": [], "edges": [], "entities": []}
    try:        # the metadata graph (kept up to date by graph.refresh in the ask route): entities and confirmed join paths
        seeds = []                  # most relevant first: the tables of the best-matching verified examples, in the order used
        for p in ex[:3]:
            low = p.sql.lower()
            hits = sorted((m.start(), connectors.table_fqn(t)) for t, _ in ddl_all
                          for m in [re.search(rf"\b{re.escape(t['name'].lower())}\b", low)] if m)
            seeds += [name for _, name in hits]
        seeds += [connectors.table_fqn(t) for t, _ in retrieval.top(search, ddl_all, lambda x: x[1].replace("_", " "), 4)]
        g = graph.prompt_section(db, conn, search, seeds)
    except Exception:
        log.exception("metadata graph skipped for data model #%s", conn.id)
    if len(tables) <= MAX_FULL_SCHEMA_TABLES and sum(len(d) for _, d in ddl_all) <= budget:
        chosen = ddl_all
    else:   # large schema: the graph's tables first, then the most relevant tables + any used by the retrieved examples
        by_name = {connectors.table_fqn(t).lower(): (t, d) for t, d in ddl_all}
        ranked = [by_name[n.lower()] for n in g["tables"] if n.lower() in by_name]
        for t, d in retrieval.top(hint, ddl_all, lambda x: x[1].replace("_", " "), 15):
            if (t, d) not in ranked:
                ranked.append((t, d))
        names = {connectors.table_fqn(t) for t, _ in ranked}
        for t in in_examples:
            if connectors.table_fqn(t) not in names:
                ranked.append((t, connectors.table_ddl(t)))
        chosen, used = [], 0
        for t, d in ranked:
            if used + len(d) > budget:
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
    if g["text"]:
        parts.append("\n## Join paths\n" + g["text"])
    if doc_hits:
        parts.append("\n## Business documentation")
        parts += [f"### {d.title or d.document_name or 'Note'}\n{d.content}" for d in doc_hits]
    if ex:
        parts.append("\n## Verified example queries")
        parts += [f"Question: {p.question}\nSQL:\n{p.sql}" + (f"\nAnalysis: {p.content}" if p.content.strip().startswith("{") else "")
                  for p in ex]
    context = {"tables": [connectors.table_fqn(t) for t, _ in chosen], "examples": [p.id for p in ex],
               "docs": [d.id for d in doc_hits], "join_paths": len(g["edges"]), "entities": g["entities"]}
    return "\n\n".join(parts), context


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


def run_sql(db: Session, conn: Connection, sql: str, cfg: dict, user, spec: dict | None = None, plan: dict | None = None) -> dict:
    """Guard, apply the user's data filters, run and mask. Used for stored SQL (reports, shared chats).
    A combined data model runs its stored `plan` instead (every step guarded, filtered and masked for this user).
    With `spec`, also runs that predictive analysis on the fresh rows.
    Raises sqlguard.SQLBlocked / connectors.ConnectorError."""
    cap = cfg["analysis_max_rows"] if spec else cfg["max_rows"]
    if conn.db_type == "combined":
        from . import planner
        if not plan:
            raise planner.PlanError("This answer has no stored plan; ask the question again.")
        res = planner.run(db, conn, planner.clean(plan, planner.members_by_alias(db, conn)), cfg, user, cap)
    else:
        checked = sqlguard.check(sql, conn.db_type)
        to_run, applied = rowfilter.apply(checked, rowfilter.applicable(db, user, conn), conn.db_type, user)
        res = connectors.run_query(conn, security.decrypt_json(conn.config_enc), to_run, cap, cfg["query_timeout_s"])
        _mask(conn, checked, res)
        res["filters"] = applied
    res["summary"] = summarize.summarize(res["columns"], res["rows"], res["truncated"])
    res["row_count"] = len(res["rows"])
    if spec:
        res["analysis"] = {"spec": spec, **analyse(spec, res["columns"], res["rows"])}
        res["rows"] = res["rows"][:cfg["max_rows"]]
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
    system, user, context = build_prompt(db, conn, run.question, history, cfg["max_rows"], cfg["predictive_enabled"])
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
    spec = predict.clean_spec(ans.get("analysis")) if cfg["predictive_enabled"] else None
    run.analysis = {"spec": spec} if spec else None
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
    spec = (run.analysis or {}).get("spec")
    cap = cfg["analysis_max_rows"] if spec else cfg["max_rows"]       # predictive questions need the history
    while True:
        problem = None
        try:
            checked = sqlguard.check(run.final_sql, conn.db_type)
            to_run, applied = rowfilter.apply(checked, filters, conn.db_type, user)
            res = connectors.run_query(conn, conn_cfg, to_run, cap, cfg["query_timeout_s"])
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
    return _finish(run, res, cfg, spec)


def _finish(run: QueryRun, res: dict, cfg: dict, spec: dict | None):
    """Store a successful result on the run (summary, chart, rows if kept, predictive analysis)."""
    run.status, run.error = "success", ""
    run.columns, run.row_count, run.truncated, run.db_ms = res["columns"], len(res["rows"]), res["truncated"], res["ms"]
    run.summary = summarize.summarize(res["columns"], res["rows"], res["truncated"])
    if not run.chart:
        run.chart = summarize.suggest_chart(res["columns"], res["rows"])
    shown = res["rows"][:cfg["max_rows"]]                   # the data table shows (and stores) at most max_rows
    run._live_rows = shown                                  # for this response, even when nothing is stored
    run.result_rows = shown if cfg["store_results"] else None
    if spec:
        outcome = analyse(spec, res["columns"], res["rows"])
        run._live_analysis = {"spec": spec, **outcome}
        run.analysis = run._live_analysis if cfg["store_results"] else {"spec": spec}
    return res["rows"]


# ---- combined data models: a plan of steps, one per data model, combined on the server --------------------------------------
def generate_plan(db: Session, run: QueryRun, combined: Connection, model: LLMModel, history: list[QueryRun], cfg: dict):
    """Ask the model for a plan; fills run.plan / generated_sql / status. Does not execute."""
    from . import planner
    system, user, context = build_plan_prompt(db, combined, run.question, history, cfg, cfg["predictive_enabled"])
    run.context = context
    try:
        ans = _call(run, model, system, user)
    except llm.LLMError as e:
        run.status, run.error = "error", str(e)
        return None
    run.explanation, run.followups = ans["explanation"], ans["followups"]
    if not ans.get("plan"):
        run.status = "clarification"
        run.explanation = ans["clarification"] or "I could not write a plan for that. Could you rephrase the question?"
        return None
    members = planner.members_by_alias(db, combined)
    try:
        plan = planner.clean(ans["plan"], members)
    except planner.PlanError as e:
        run.status, run.error = "error", f"The AI model's plan could not be used: {e}"
        return None
    _set_plan(run, plan, members, generated=True)
    spec = predict.clean_spec(ans.get("analysis")) if cfg["predictive_enabled"] else None
    run.analysis = {"spec": spec} if spec else None
    run.status = "pending_review"
    return system, user


def _set_plan(run: QueryRun, plan: dict, members: dict, generated: bool = False):
    from . import planner
    names = {a: c.name for a, c in members.items()}
    keep = (run.plan or {}).get("generated")
    run.plan = {**plan, "generated": plan if generated else (keep or plan)}
    if generated:
        run.generated_sql = planner.text(plan, names)
    run.final_sql = planner.text(plan, names)
    run.edited = not planner.same(plan, run.plan["generated"])


def execute_plan(db: Session, run: QueryRun, combined: Connection, cfg: dict, model: LLMModel | None = None,
                 prompt: tuple | None = None, user=None):
    """Run run.plan for this person. With `model` and `prompt`, a failing model-written plan is sent back for repair
    (error text scrubbed of literals) up to N times. Row-limit and time-out failures are never repaired."""
    from . import planner
    members = planner.members_by_alias(db, combined)
    repairs_left = cfg["max_repair_attempts"] if (model and prompt and not run.edited) else 0
    spec = (run.analysis or {}).get("spec")
    cap = cfg["analysis_max_rows"] if spec else cfg["max_rows"]
    while True:
        problem, status = None, "error"
        try:
            plan = planner.clean(run.plan, members)
            res = planner.run(db, combined, plan, cfg, user, cap)
        except sqlguard.SQLBlocked as e:
            problem, status = str(e), "blocked"
        except connectors.ConnectorError as e:
            problem = str(e)
            if isinstance(e, (planner.LimitError, connectors.QueryTimeout)):
                repairs_left = 0
        if problem is None:
            break
        if repairs_left <= 0:
            run.status, run.error = status, problem
            return
        repairs_left -= 1
        fix = (f"{prompt[1]}\n\n## Your previous plan failed\nPlan:\n{run.final_sql}\n\n"
               f"Error: {problem if status == 'blocked' else scrub_error(problem)}\n\n"
               "Return the corrected plan as JSON in the same format.")
        try:
            ans = _call(run, model, prompt[0], fix)
            new = planner.clean(ans.get("plan"), members)
        except (llm.LLMError, planner.PlanError):
            run.status, run.error = status, problem
            return
        _set_plan(run, new, members, generated=True)
        run.explanation = ans["explanation"] or run.explanation
        run.followups = ans["followups"] or run.followups
    run.plan = {**run.plan, "steps": [{**s, **{k: v for k, v in r.items() if k in ("data_model", "rows", "ms", "filters", "columns")}}
                                      for s, r in zip(run.plan["steps"], res["steps"])]}
    run.context = {**(run.context or {}), "filters": res["filters"], "warnings": res["warnings"]}
    return _finish(run, res, cfg, spec)


_analysis_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="analysis")


def analyse(spec: dict, columns: list, rows: list, timeout_s: int = 180) -> dict:
    """Run a predictive analysis on already-fetched rows. Returns {"result": ...} or {"error": "..."}.
    Runs on the server only - nothing here is sent to the language model."""
    future = _analysis_pool.submit(predict.run, spec, columns, rows)
    try:
        result = future.result(timeout=timeout_s)
        json.dumps(result)                                  # must be storable
        return {"result": result}
    except predict.AnalysisError as e:
        return {"error": str(e)}
    except concurrent.futures.TimeoutError:
        return {"error": "The analysis took too long and was stopped. Ask for less data (a shorter period or fewer columns)."}
    except Exception as e:                                  # never let statistics break the answer itself
        return {"error": f"The analysis failed unexpectedly ({type(e).__name__})."}
