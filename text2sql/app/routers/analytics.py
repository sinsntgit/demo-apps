"""Model-performance and usage analytics for admins and data stewards."""
from collections import Counter, defaultdict
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..db import get_db, now
from ..deps import steward_up
from ..models import Connection, QueryRun, TrainingItem, User
from .chat import run_dto

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


def _filtered(days: int, connection_id: int | None, model_id: int | None, user_id: int | None):
    stmt = select(QueryRun).where(QueryRun.created_at >= now() - timedelta(days=days))
    if connection_id:
        stmt = stmt.where(QueryRun.connection_id == connection_id)
    if model_id:
        stmt = stmt.where(QueryRun.model_id == model_id)
    if user_id:
        stmt = stmt.where(QueryRun.user_id == user_id)
    return stmt


def _agg(runs: list[QueryRun]) -> dict:
    n = len(runs)
    ok = sum(r.status == "success" for r in runs)
    rated = [r for r in runs if r.feedback]
    correct = sum(r.feedback == "correct" for r in rated)
    executed = [r for r in runs if r.status in ("success", "error", "blocked")]
    return {
        "queries": n,
        "success": ok,
        "errors": sum(r.status in ("error", "blocked") for r in runs),
        "clarifications": sum(r.status == "clarification" for r in runs),
        "success_rate": ok / len(executed) if executed else None,
        "rated": len(rated),
        "correct": correct,
        "corrected": sum(r.feedback == "corrected" for r in rated),
        "incorrect": sum(r.feedback == "incorrect" for r in rated),
        # share of rated answers whose model-written SQL was accepted without edits
        "accuracy": correct / len(rated) if rated else None,
        "self_repaired": sum(r.attempts > 1 and r.status == "success" for r in runs),
        "avg_llm_ms": round(sum(r.llm_ms for r in runs) / n) if n else 0,
        "avg_db_ms": round(sum(r.db_ms for r in executed) / len(executed)) if executed else 0,
        "input_tokens": sum(r.input_tokens for r in runs),
        "output_tokens": sum(r.output_tokens for r in runs),
        "cost": round(sum(r.cost for r in runs), 4),
    }


@router.get("/summary")
def summary(days: int = 30, connection_id: int | None = None, model_id: int | None = None,
            user_id: int | None = None, _: User = Depends(steward_up), db: Session = Depends(get_db)):
    days = min(max(days, 1), 365)
    runs = list(db.scalars(_filtered(days, connection_id, model_id, user_id)))
    users = {u.id: u.email for u in db.scalars(select(User))}
    conns = {c.id: c.name for c in db.scalars(select(Connection))}

    by_day = defaultdict(list)
    for r in runs:
        by_day[r.created_at.date().isoformat()].append(r)
    start = (now() - timedelta(days=days - 1)).date()
    series = []
    for i in range(days):
        d = (start + timedelta(days=i)).isoformat()
        a = _agg(by_day.get(d, []))
        series.append({"day": d, "queries": a["queries"], "success": a["success"], "errors": a["errors"],
                       "cost": a["cost"], "accuracy": a["accuracy"]})

    def group(key, label):
        buckets = defaultdict(list)
        for r in runs:
            buckets[key(r)].append(r)
        out = [{"key": k, "label": label(k), **_agg(v)} for k, v in buckets.items()]
        return sorted(out, key=lambda x: -x["queries"])

    errors = Counter((r.error or "")[:160] for r in runs if r.status in ("error", "blocked"))
    pending = db.scalar(select(TrainingItem.id).where(TrainingItem.status == "pending").limit(1)) is not None
    return {
        "totals": {**_agg(runs), "active_users": len({r.user_id for r in runs})},
        "series": series,
        "by_model": group(lambda r: r.model_label or "(deleted model)", lambda k: k),
        "by_connection": group(lambda r: r.connection_id, lambda k: conns.get(k, f"#{k}")),
        "by_user": group(lambda r: r.user_id, lambda k: users.get(k, f"#{k}"))[:25],
        "top_errors": [{"error": e, "count": c} for e, c in errors.most_common(8)],
        "has_pending_training": pending,
        "filters": {"users": [{"id": k, "label": v} for k, v in sorted(users.items(), key=lambda x: x[1])],
                    "connections": [{"id": k, "label": v} for k, v in sorted(conns.items(), key=lambda x: x[1])]},
    }


@router.get("/queries")
def queries(days: int = 30, connection_id: int | None = None, model_id: int | None = None,
            user_id: int | None = None, status: str = "", feedback: str = "", q: str = "", page: int = 1,
            _: User = Depends(steward_up), db: Session = Depends(get_db)):
    stmt = _filtered(min(max(days, 1), 365), connection_id, model_id, user_id)
    if status:
        stmt = stmt.where(QueryRun.status == status)
    if feedback == "none":
        stmt = stmt.where(QueryRun.feedback == "")
    elif feedback:
        stmt = stmt.where(QueryRun.feedback == feedback)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(QueryRun.question.ilike(like), QueryRun.final_sql.ilike(like)))
    size = 50
    rows = list(db.scalars(stmt.order_by(QueryRun.id.desc()).offset((max(page, 1) - 1) * size).limit(size + 1)))
    users = {u.id: u.email for u in db.scalars(select(User))}
    conns = {c.id: c.name for c in db.scalars(select(Connection))}
    return {"more": len(rows) > size, "items": [
        {"id": r.id, "at": r.created_at.isoformat(), "user": users.get(r.user_id, ""),
         "connection": conns.get(r.connection_id, ""), "model": r.model_label, "question": r.question,
         "status": r.status, "feedback": r.feedback, "edited": r.edited, "rows": r.row_count,
         "llm_ms": r.llm_ms, "db_ms": r.db_ms, "tokens": r.input_tokens + r.output_tokens,
         "cost": round(r.cost, 5), "attempts": r.attempts} for r in rows[:size]]}


@router.get("/queries/{run_id}")
def query_detail(run_id: int, _: User = Depends(steward_up), db: Session = Depends(get_db)):
    r = db.get(QueryRun, run_id)
    if not r:
        raise HTTPException(404, "Not found")
    user = db.get(User, r.user_id)
    conn = db.get(Connection, r.connection_id)
    return {**run_dto(r), "user": user.email if user else "", "connection": conn.name if conn else ""}
