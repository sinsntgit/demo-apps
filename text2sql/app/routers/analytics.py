"""Model-performance and usage analytics for admins and data stewards."""
from collections import Counter, defaultdict
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..db import get_db, now
from ..deps import steward_up
from ..models import Connection, QueryRun, RephraseLog, TrainingItem, User
from .chat import run_dto

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


def _filtered(days: int, connection_id: int | None, model_id: int | None, user_id: int | None, company_id: int | None):
    stmt = select(QueryRun).where(QueryRun.created_at >= now() - timedelta(days=days), QueryRun.company_id == company_id)
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


def failure_reason(r: QueryRun) -> str:
    """Why an answer across data models went wrong (or needs a look), in words a steward can act on; '' when it went fine."""
    warnings = (r.context or {}).get("warnings") or []
    if r.status == "clarification":
        return "The AI asked a clarifying question"
    if r.status == "blocked":
        return "Blocked by the read-only check"
    if r.status == "error":
        e = r.error or ""
        if "rows, the limit" in e:
            return "Row limit reached - ask for totals, or raise the limit"
        if e.startswith("Step "):
            return "A step failed on its data model - improve that data model's training"
        if e.startswith("Combine step") or "combine step" in e.lower():
            return "The combine step failed"
        if "time limit" in e:
            return "Time limit reached"
        return "Other error"
    if any(w.startswith("No rows matched") for w in warnings):
        return "Nothing matched between the data models - check the key rule"
    if any("counted more than once" in w for w in warnings):
        return "Keys repeated on both sides - totals may be counted twice"
    if r.status == "success" and r.attempts > 1:
        return "Needed an automatic repair"
    return ""


@router.get("/summary")
def summary(days: int = 30, connection_id: int | None = None, model_id: int | None = None,
            user_id: int | None = None, me: User = Depends(steward_up), db: Session = Depends(get_db)):
    days = min(max(days, 1), 365)
    runs = list(db.scalars(_filtered(days, connection_id, model_id, user_id, me.company_id)))
    users = {u.id: u.email for u in db.scalars(select(User).where(User.company_id == me.company_id))}
    conns = {c.id: c.name for c in db.scalars(select(Connection).where(Connection.company_id == me.company_id))}

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
    pending = db.scalar(select(TrainingItem.id).where(TrainingItem.status == "pending", TrainingItem.connection_id.in_(list(conns))).limit(1)) is not None or \
        db.scalar(select(QueryRun.id).where(QueryRun.issue_status == "open", QueryRun.company_id == me.company_id).limit(1)) is not None
    stmt = select(RephraseLog).where(RephraseLog.created_at >= now() - timedelta(days=days), RephraseLog.connection_id.in_(list(conns)))
    if connection_id:
        stmt = stmt.where(RephraseLog.connection_id == connection_id)
    if model_id:
        stmt = stmt.where(RephraseLog.model_id == model_id)
    if user_id:
        stmt = stmt.where(RephraseLog.user_id == user_id)
    logs = list(db.scalars(stmt))

    def outcome(rs):        # how often the first model answer worked, without a clarification or a repair
        done = [r for r in rs if r.status in ("success", "error", "blocked", "clarification")]
        first = [r for r in done if r.status == "success" and r.attempts <= 1]
        return {"questions": len(rs), "first_time_rate": len(first) / len(done) if done else None,
                "avg_tokens": round(sum(r.input_tokens + r.output_tokens for r in rs) / len(rs)) if rs else 0}
    rephrase = {"count": len(logs), "used": sum(x.used for x in logs), "errors": sum(x.status == "error" for x in logs),
                "input_tokens": sum(x.input_tokens for x in logs), "output_tokens": sum(x.output_tokens for x in logs),
                "cost": round(sum(x.cost for x in logs), 4),
                "avg_tokens": round(sum(x.input_tokens + x.output_tokens for x in logs) / len(logs)) if logs else 0,
                "rephrased": outcome([r for r in runs if r.rephrase_id]), "as_typed": outcome([r for r in runs if not r.rephrase_id])}
    combined_ids = {c.id for c in db.scalars(select(Connection).where(Connection.company_id == me.company_id, Connection.db_type == "combined"))}
    across = [r for r in runs if r.connection_id in combined_ids]
    combined = {"questions": len(across), "across": outcome(across), "single": outcome([r for r in runs if r.connection_id not in combined_ids]),
                "reasons": [{"reason": k, "count": v} for k, v in Counter(r for r in map(failure_reason, across) if r).most_common()]}
    return {
        "totals": {**_agg(runs), "active_users": len({r.user_id for r in runs})},
        "rephrase": rephrase,
        "combined": combined,
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
            me: User = Depends(steward_up), db: Session = Depends(get_db)):
    stmt = _filtered(min(max(days, 1), 365), connection_id, model_id, user_id, me.company_id)
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
    users = {u.id: u.email for u in db.scalars(select(User).where(User.company_id == me.company_id))}
    conns = {c.id: c.name for c in db.scalars(select(Connection).where(Connection.company_id == me.company_id))}
    return {"more": len(rows) > size, "items": [
        {"id": r.id, "at": r.created_at.isoformat(), "user": users.get(r.user_id, ""),
         "connection": conns.get(r.connection_id, ""), "model": r.model_label, "question": r.question,
         "status": r.status, "feedback": r.feedback, "edited": r.edited, "rows": r.row_count,
         "llm_ms": r.llm_ms, "db_ms": r.db_ms, "tokens": r.input_tokens + r.output_tokens,
         "cost": round(r.cost, 5), "attempts": r.attempts} for r in rows[:size]]}


@router.get("/queries/{run_id}")
def query_detail(run_id: int, me: User = Depends(steward_up), db: Session = Depends(get_db)):
    r = db.get(QueryRun, run_id)
    if not r or r.company_id != me.company_id:
        raise HTTPException(404, "Not found")
    user = db.get(User, r.user_id)
    conn = db.get(Connection, r.connection_id)
    return {**run_dto(r), "user": user.email if user else "", "connection": conn.name if conn else ""}
