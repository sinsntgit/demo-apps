import io

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .. import engine, predict, security, sqlguard, summarize
from ..db import get_db, now
from ..deps import audit, current_user, get_connection, get_settings
from ..models import Connection, Conversation, LLMModel, QueryRun, User
from .training import upsert_pair

router = APIRouter(prefix="/api", tags=["chat"])


class AskIn(BaseModel):
    connection_id: int
    model_id: int | None = None
    conversation_id: int | None = None
    question: str
    review_first: bool = False
    predictive: bool = False        # "Use predictive capability": forecasts, predictions, segments, anomalies


class ExecIn(BaseModel):
    sql: str | None = None


class FeedbackIn(BaseModel):
    verdict: str            # correct | incorrect
    note: str = ""


class TitleIn(BaseModel):
    title: str


def run_dto(r: QueryRun, rows: bool = True) -> dict:
    summary, columns = r.summary, r.columns or []
    stored = r.result_rows if r.result_rows is not None else getattr(r, "_live_rows", None)
    analysis = getattr(r, "_live_analysis", None) or r.analysis
    if rows and r.result_rows is not None and r.status == "success" and len(r.result_rows) == r.row_count:
        # recomputed on read, so saved answers always get the current summary logic
        columns = summarize.enrich([dict(c) for c in columns])
        summary = summarize.summarize(columns, r.result_rows, r.truncated)
    return {"id": r.id, "conversation_id": r.conversation_id, "question": r.question,
            "generated_sql": r.generated_sql, "final_sql": r.final_sql, "edited": r.edited,
            "explanation": r.explanation, "status": r.status, "error": r.error, "row_count": r.row_count,
            "truncated": r.truncated, "columns": columns, "rows": (stored if rows else None),
            "analysis": analysis if rows else ({"spec": analysis.get("spec")} if analysis else None),
            "rows_stored": r.result_rows is not None, "summary": summary, "chart": r.chart,
            "followups": r.followups or [], "feedback": r.feedback, "feedback_note": r.feedback_note,
            "model_label": r.model_label, "input_tokens": r.input_tokens, "output_tokens": r.output_tokens,
            "cost": round(r.cost, 6), "llm_ms": r.llm_ms, "db_ms": r.db_ms, "attempts": r.attempts,
            "context": r.context, "created_at": r.created_at.isoformat()}


def _own_run(db: Session, user: User, run_id: int) -> QueryRun:
    run = db.get(QueryRun, run_id)
    if not run or run.user_id != user.id:
        raise HTTPException(404, "Not found")
    return run


def _own_conv(db: Session, user: User, conv_id: int) -> Conversation:
    conv = db.get(Conversation, conv_id)
    if not conv or conv.user_id != user.id:
        raise HTTPException(404, "Conversation not found")
    return conv


def _pick_model(db: Session, model_id: int | None) -> LLMModel:
    model = db.get(LLMModel, model_id) if model_id else db.scalar(
        select(LLMModel).where(LLMModel.enabled).order_by(LLMModel.is_default.desc(), LLMModel.id))
    if not model or not model.enabled:
        raise HTTPException(400, "No AI model is available. Ask an admin to add one under Admin > Models.")
    return model


@router.get("/models")
def models(_: User = Depends(current_user), db: Session = Depends(get_db)):
    return [{"id": m.id, "name": m.name, "provider": m.provider, "is_default": m.is_default}
            for m in db.scalars(select(LLMModel).where(LLMModel.enabled).order_by(LLMModel.is_default.desc(), LLMModel.name))]


@router.post("/chat/ask")
def ask(body: AskIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    question = body.question.strip()
    if not question:
        raise HTTPException(400, "Type a question first.")
    if len(question) > 4000:
        raise HTTPException(400, "Question is too long.")
    cfg = get_settings(db)
    if not security.limiter.allow(f"ask:{user.id}", cfg["rate_limit_per_min"]):
        raise HTTPException(429, "You are asking questions too quickly. Wait a moment and try again.")
    conn = get_connection(db, user, body.connection_id)
    if not conn.is_active:
        raise HTTPException(400, "This data model is disabled.")
    model = _pick_model(db, body.model_id)

    if body.conversation_id:
        conv = _own_conv(db, user, body.conversation_id)
        if conv.connection_id != conn.id:
            raise HTTPException(400, "This conversation belongs to a different data model. Start a new chat.")
        history = [r for r in conv.runs if r.status == "success"]
    else:
        conv = Conversation(user_id=user.id, connection_id=conn.id, title=question[:80])
        db.add(conv)
        db.flush()
        history = []

    run = QueryRun(conversation_id=conv.id, user_id=user.id, connection_id=conn.id, model_id=model.id,
                   model_label=model.name, question=question, attempts=0, input_tokens=0, output_tokens=0,
                   llm_ms=0, cost=0.0)
    db.add(run)
    # predictive analysis is used only when the user ticked it for this question and an admin allows it
    prompt = engine.generate(db, run, conn, model, history,
                             {**cfg, "predictive_enabled": bool(cfg["predictive_enabled"] and body.predictive)})
    if prompt and not body.review_first:
        engine.execute(db, run, conn, cfg, model, prompt, user=user)
    conv.updated_at = now()
    audit(db, request, user, "query.asked", conn.name, f"run status={run.status}")
    db.commit()
    return {"conversation": {"id": conv.id, "title": conv.title}, "run": run_dto(run)}


@router.post("/chat/runs/{run_id}/execute")
def execute(run_id: int, body: ExecIn, request: Request, user: User = Depends(current_user),
            db: Session = Depends(get_db)):
    """Run the reviewed SQL, or a user-edited version of it."""
    run = _own_run(db, user, run_id)
    conn = get_connection(db, user, run.connection_id)
    cfg = get_settings(db)
    if body.sql is not None:
        sql = sqlguard._strip(body.sql)
        if " ".join(sql.split()) != " ".join((run.generated_sql or "").split()):
            run.edited = True      # whitespace-only changes (the UI's formatting) do not count
        run.final_sql = sql
    if not run.final_sql:
        raise HTTPException(400, "There is no SQL to run.")
    run.feedback = "" if run.edited else run.feedback
    engine.execute(db, run, conn, cfg, user=user)
    audit(db, request, user, "query.executed", conn.name,
          f"run #{run.id} status={run.status}{' (edited SQL)' if run.edited else ''}")
    db.commit()
    return run_dto(run)


class AnalysisIn(BaseModel):
    horizon: int | None = None
    k: int | None = None


@router.post("/chat/runs/{run_id}/analysis")
def rerun_analysis(run_id: int, body: AnalysisIn, request: Request, user: User = Depends(current_user),
                   db: Session = Depends(get_db)):
    """Re-run a predictive answer with a different horizon / number of segments (data is fetched afresh)."""
    run = _own_run(db, user, run_id)
    conn = get_connection(db, user, run.connection_id)
    spec = dict((run.analysis or {}).get("spec") or {})
    if not spec:
        raise HTTPException(400, "This answer has no predictive analysis.")
    if body.horizon is not None:
        spec["horizon"] = body.horizon
    if body.k is not None:
        spec["k"] = body.k
    elif "k" in body.model_fields_set:
        spec.pop("k", None)                     # back to automatic
    run.analysis = {"spec": predict.clean_spec(spec)}
    engine.execute(db, run, conn, get_settings(db), user=user)
    audit(db, request, user, "query.analysis_rerun", conn.name, f"run #{run.id} {spec.get('type')}")
    db.commit()
    return run_dto(run)


@router.post("/chat/runs/{run_id}/feedback")
def feedback(run_id: int, body: FeedbackIn, request: Request, user: User = Depends(current_user),
             db: Session = Depends(get_db)):
    """Confirm the SQL (it becomes a training pair) or flag it as wrong."""
    run = _own_run(db, user, run_id)
    conn = get_connection(db, user, run.connection_id)
    if body.verdict == "incorrect":
        run.feedback, run.feedback_note = "incorrect", body.note[:2000]
        audit(db, request, user, "query.feedback", conn.name, f"run #{run.id} incorrect")
        db.commit()
        return {"run": run_dto(run, rows=False), "training": None}
    if body.verdict != "correct":
        raise HTTPException(400, "Unknown verdict.")
    if run.status != "success":
        raise HTTPException(400, "Only a query that ran successfully can be confirmed.")
    run.feedback = "corrected" if run.edited else "correct"
    trusted = user.role in ("admin", "steward") or get_settings(db)["feedback_mode"] == "instant"
    status = "approved" if trusted else "pending"
    upsert_pair(db, conn, run.question, run.final_sql, "correction" if run.edited else "confirmed", status, user.id,
                analysis=(run.analysis or {}).get("spec"))
    audit(db, request, user, "query.feedback", conn.name, f"run #{run.id} {run.feedback} -> training {status}")
    db.commit()
    return {"run": run_dto(run, rows=False), "training": status}


@router.put("/chat/runs/{run_id}/chart")
def save_chart(run_id: int, chart: dict, user: User = Depends(current_user), db: Session = Depends(get_db)):
    run = _own_run(db, user, run_id)
    run.chart = {k: chart.get(k) for k in ("type", "x", "y", "series", "stacked", "horizontal", "view", "hide") if k in chart}
    db.commit()
    return {"ok": True}


@router.get("/chat/runs/{run_id}/export.xlsx")
def export_xlsx(run_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    import openpyxl
    from openpyxl.styles import Font
    run = _own_run(db, user, run_id)
    if run.result_rows is None:
        raise HTTPException(400, "Results are not stored for this query. Run it again first.")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Results"
    ws.append([c["name"] for c in run.columns])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for row in run.result_rows:
        ws.append(row)
    ws.freeze_panes = "A2"
    info = wb.create_sheet("Query")
    for k, v in (("Question", run.question), ("SQL", run.final_sql), ("Model", run.model_label),
                 ("Run at (UTC)", run.created_at.isoformat(timespec="seconds")), ("Rows", run.row_count)):
        info.append([k, v])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f'attachment; filename="query-{run.id}.xlsx"'})


# ---- conversations & history ------------------------------------------------------
@router.get("/chat/conversations")
def conversations(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(Conversation, Connection.name).join(Connection, Connection.id == Conversation.connection_id)
                      .where(Conversation.user_id == user.id).order_by(Conversation.updated_at.desc()).limit(300)).all()
    return [{"id": c.id, "title": c.title, "connection_id": c.connection_id, "connection_name": name,
             "updated_at": c.updated_at.isoformat()} for c, name in rows]


@router.get("/chat/conversations/{conv_id}")
def conversation(conv_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    conv = _own_conv(db, user, conv_id)
    return {"id": conv.id, "title": conv.title, "connection_id": conv.connection_id,
            "runs": [run_dto(r) for r in conv.runs]}


@router.put("/chat/conversations/{conv_id}")
def rename(conv_id: int, body: TitleIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    conv = _own_conv(db, user, conv_id)
    conv.title = body.title.strip()[:200] or conv.title
    db.commit()
    return {"ok": True}


@router.delete("/chat/conversations/{conv_id}")
def delete_conversation(conv_id: int, request: Request, user: User = Depends(current_user),
                        db: Session = Depends(get_db)):
    conv = _own_conv(db, user, conv_id)
    audit(db, request, user, "conversation.deleted", conv.title)
    db.delete(conv)
    db.commit()
    return {"ok": True}


@router.get("/chat/history")
def history(q: str = "", user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Search the user's past questions and SQL."""
    stmt = select(QueryRun, Connection.name).join(Connection, Connection.id == QueryRun.connection_id) \
        .where(QueryRun.user_id == user.id)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(QueryRun.question.ilike(like), QueryRun.final_sql.ilike(like)))
    rows = db.execute(stmt.order_by(QueryRun.id.desc()).limit(200)).all()
    return [{"id": r.id, "conversation_id": r.conversation_id, "question": r.question, "status": r.status,
             "row_count": r.row_count, "feedback": r.feedback, "connection_name": name, "model_label": r.model_label,
             "created_at": r.created_at.isoformat()} for r, name in rows]
