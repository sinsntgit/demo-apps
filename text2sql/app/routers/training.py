import csv
import io
import json
import re

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from .. import docparse, retrieval, sqlguard
from ..db import get_db, now
from ..deps import audit, get_connection, steward_up
from ..models import TrainingItem, User

router = APIRouter(prefix="/api/training", tags=["training"])
KINDS = ("ddl", "documentation", "sql_pair", "document")


class ItemIn(BaseModel):
    kind: str
    title: str = ""
    content: str = ""
    question: str = ""
    sql: str = ""


def _dto(t: TrainingItem) -> dict:
    return {"id": t.id, "kind": t.kind, "title": t.title, "content": t.content, "question": t.question,
            "sql": t.sql, "source": t.source, "status": t.status, "document_name": t.document_name,
            "created_at": t.created_at.isoformat(), "updated_at": t.updated_at.isoformat()}


def norm_question(q: str) -> str:
    return re.sub(r"\W+", " ", q.lower()).strip()


def upsert_pair(db: Session, conn, question: str, sql: str, source: str, status: str, user_id,
                analysis: dict | None = None) -> TrainingItem:
    """One pair per (data model, question): a newer answer replaces the older one.
    For predictive questions the chosen method + columns are kept with the example (in `content`)."""
    key = norm_question(question)
    extra = json.dumps(analysis) if analysis else ""
    for p in db.scalars(select(TrainingItem).where(TrainingItem.connection_id == conn.id,
                                                   TrainingItem.kind == "sql_pair")):
        if norm_question(p.question) == key:
            p.sql, p.source, p.status, p.updated_at, p.content = sql, source, status, now(), extra
            return p
    item = TrainingItem(connection_id=conn.id, kind="sql_pair", question=question.strip(), sql=sql, content=extra,
                        source=source, status=status, created_by=user_id)
    db.add(item)
    return item


def _check_item(body: ItemIn, conn):
    if body.kind not in KINDS:
        raise HTTPException(400, "Unknown training type.")
    if body.kind == "sql_pair":
        if not body.question.strip() or not body.sql.strip():
            raise HTTPException(400, "Both a question and its SQL are required.")
        try:
            body.sql = sqlguard.check(body.sql, conn.db_type).sql
        except sqlguard.SQLBlocked as e:
            raise HTTPException(400, f"SQL rejected: {e}")
    elif not body.content.strip():
        raise HTTPException(400, "Content is required.")


@router.get("/{conn_id}")
def list_items(conn_id: int, kind: str = "", status: str = "", q: str = "",
               user: User = Depends(steward_up), db: Session = Depends(get_db)):
    get_connection(db, user, conn_id)
    stmt = select(TrainingItem).where(TrainingItem.connection_id == conn_id)
    if kind:
        stmt = stmt.where(TrainingItem.kind == kind)
    if status:
        stmt = stmt.where(TrainingItem.status == status)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(TrainingItem.title.ilike(like), TrainingItem.content.ilike(like),
                              TrainingItem.question.ilike(like), TrainingItem.sql.ilike(like)))
    items = list(db.scalars(stmt.order_by(TrainingItem.updated_at.desc()).limit(1000)))
    counts = dict(db.execute(select(TrainingItem.kind, func.count()).where(
        TrainingItem.connection_id == conn_id, TrainingItem.status == "approved").group_by(TrainingItem.kind)).all())
    pending = db.scalar(select(func.count()).where(TrainingItem.connection_id == conn_id,
                                                   TrainingItem.status == "pending"))
    from ..models import QueryRun
    issues_open = db.scalar(select(func.count()).where(QueryRun.connection_id == conn_id, QueryRun.issue_status == "open"))
    return {"items": [_dto(i) for i in items], "counts": counts, "pending": pending, "issues_open": issues_open}


@router.post("/{conn_id}")
def create(conn_id: int, body: ItemIn, request: Request, user: User = Depends(steward_up),
           db: Session = Depends(get_db)):
    conn = get_connection(db, user, conn_id)
    _check_item(body, conn)
    if body.kind == "sql_pair":
        item = upsert_pair(db, conn, body.question, body.sql, "manual", "approved", user.id)
    else:
        item = TrainingItem(connection_id=conn_id, kind=body.kind, title=body.title.strip(), content=body.content,
                            source="manual", created_by=user.id)
        db.add(item)
    audit(db, request, user, "training.added", conn.name, body.kind)
    db.commit()
    return _dto(item)


@router.put("/item/{item_id}")
def update(item_id: int, body: ItemIn, request: Request, user: User = Depends(steward_up),
           db: Session = Depends(get_db)):
    item = db.get(TrainingItem, item_id)
    if not item:
        raise HTTPException(404, "Not found")
    conn = get_connection(db, user, item.connection_id)
    body.kind = item.kind
    _check_item(body, conn)
    item.title, item.content, item.question, item.sql = body.title.strip(), body.content, body.question.strip(), body.sql
    item.updated_at = now()
    audit(db, request, user, "training.updated", conn.name, f"{item.kind} #{item.id}")
    db.commit()
    return _dto(item)


@router.delete("/item/{item_id}")
def remove(item_id: int, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    item = db.get(TrainingItem, item_id)
    if not item:
        raise HTTPException(404, "Not found")
    conn = get_connection(db, user, item.connection_id)
    audit(db, request, user, "training.deleted", conn.name, f"{item.kind} #{item.id}")
    db.delete(item)
    db.commit()
    return {"ok": True}


@router.post("/item/{item_id}/{decision}")
def review(item_id: int, decision: str, request: Request, user: User = Depends(steward_up),
           db: Session = Depends(get_db)):
    if decision not in ("approve", "reject"):
        raise HTTPException(404, "Not found")
    item = db.get(TrainingItem, item_id)
    if not item:
        raise HTTPException(404, "Not found")
    conn = get_connection(db, user, item.connection_id)
    item.status, item.updated_at = ("approved" if decision == "approve" else "rejected"), now()
    audit(db, request, user, f"training.{decision}d", conn.name, f"{item.kind} #{item.id}")
    db.commit()
    return _dto(item)


@router.post("/{conn_id}/upload")
async def upload_document(conn_id: int, request: Request, upload: UploadFile = File(...),
                          user: User = Depends(steward_up), db: Session = Depends(get_db)):
    conn = get_connection(db, user, conn_id)
    name = upload.filename or "document"
    try:
        text = docparse.extract(name, await upload.read())
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception:
        raise HTTPException(400, "Could not read this file. Is it corrupted or password-protected?")
    chunks = retrieval.chunk(text)
    if not chunks:
        raise HTTPException(400, "No readable text was found in this file.")
    db.execute(delete(TrainingItem).where(TrainingItem.connection_id == conn_id, TrainingItem.kind == "document",
                                          TrainingItem.document_name == name))     # re-upload replaces
    for i, ch in enumerate(chunks):
        db.add(TrainingItem(connection_id=conn_id, kind="document", title=f"{name} (part {i + 1}/{len(chunks)})",
                            content=ch, source="upload", document_name=name, created_by=user.id))
    audit(db, request, user, "training.document_uploaded", conn.name, f"{name}: {len(chunks)} chunks")
    db.commit()
    return {"document": name, "chunks": len(chunks)}


@router.delete("/{conn_id}/document")
def delete_document(conn_id: int, name: str, request: Request, user: User = Depends(steward_up),
                    db: Session = Depends(get_db)):
    conn = get_connection(db, user, conn_id)
    db.execute(delete(TrainingItem).where(TrainingItem.connection_id == conn_id, TrainingItem.kind == "document",
                                          TrainingItem.document_name == name))
    audit(db, request, user, "training.document_deleted", conn.name, name)
    db.commit()
    return {"ok": True}


@router.post("/{conn_id}/import-pairs")
async def import_pairs(conn_id: int, request: Request, upload: UploadFile = File(...),
                       user: User = Depends(steward_up), db: Session = Depends(get_db)):
    """Bulk-load question/SQL pairs from CSV (columns: question, sql) or JSON ([{question, sql}])."""
    conn = get_connection(db, user, conn_id)
    raw = (await upload.read()).decode("utf-8-sig", errors="replace")
    try:
        if (upload.filename or "").lower().endswith(".json"):
            rows = json.loads(raw)
        else:
            rows = list(csv.DictReader(io.StringIO(raw)))
    except Exception:
        raise HTTPException(400, "Could not parse the file. Use CSV with 'question' and 'sql' columns, or JSON.")
    added, errors = 0, []
    for n, r in enumerate(rows if isinstance(rows, list) else [], 1):
        r = {str(k).strip().lower(): v for k, v in r.items()} if isinstance(r, dict) else {}
        question, sql = str(r.get("question") or "").strip(), str(r.get("sql") or r.get("query") or "").strip()
        if not question or not sql:
            errors.append(f"Row {n}: missing question or sql")
            continue
        try:
            sql = sqlguard.check(sql, conn.db_type).sql
        except sqlguard.SQLBlocked as e:
            errors.append(f"Row {n}: {e}")
            continue
        upsert_pair(db, conn, question, sql, "import", "approved", user.id)
        db.flush()
        added += 1
    audit(db, request, user, "training.pairs_imported", conn.name, f"{added} pairs")
    db.commit()
    return {"added": added, "errors": errors[:50]}


@router.get("/{conn_id}/export")
def export(conn_id: int, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    get_connection(db, user, conn_id)
    items = db.scalars(select(TrainingItem).where(TrainingItem.connection_id == conn_id,
                                                  TrainingItem.status == "approved"))
    return [{k: v for k, v in _dto(i).items() if k in ("kind", "title", "content", "question", "sql", "source",
                                                       "document_name")} for i in items]


# ---- reported problems: users say an answer is incorrect -> a steward fixes the training ----------------
class ResolveIn(BaseModel):
    action: str                 # example | note | dismiss
    question: str = ""          # example: the question the corrected SQL answers (default: the user's)
    sql: str = ""               # example: the corrected SQL
    title: str = ""             # note: business rule title
    content: str = ""           # note: business rule text
    comment: str = ""           # shown to the user who reported it


class TestSqlIn(BaseModel):
    sql: str


@router.get("/{conn_id}/issues")
def issues(conn_id: int, status: str = "open", user: User = Depends(steward_up), db: Session = Depends(get_db)):
    """Answers users reported as incorrect, with what is wrong and why, for a steward to act on."""
    from ..models import ISSUE_TYPES, QueryRun
    get_connection(db, user, conn_id)
    stmt = select(QueryRun).where(QueryRun.connection_id == conn_id, QueryRun.issue_status != "")
    if status == "open":
        stmt = stmt.where(QueryRun.issue_status == "open")
    rows = list(db.scalars(stmt.order_by(QueryRun.id.desc()).limit(300)))
    names = {u.id: u.name or u.email for u in db.scalars(select(User))}
    return [{"run_id": r.id, "question": r.question, "sql": r.final_sql, "user": names.get(r.user_id, ""),
             "issue_type": r.issue_type, "issue_label": ISSUE_TYPES.get(r.issue_type, r.issue_type), "reason": r.feedback_note,
             "status": r.issue_status, "resolution": r.issue_resolution, "row_count": r.row_count,
             "resolved_by": names.get(r.issue_resolved_by, "") if r.issue_resolved_by else "",
             "created_at": r.created_at.isoformat()} for r in rows]


@router.post("/{conn_id}/test-sql")
def test_sql(conn_id: int, body: TestSqlIn, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    """Run a corrected query before saving it (read-only guard, the steward's own filters, first 20 rows)."""
    from .. import connectors, engine
    from ..deps import get_settings
    conn = get_connection(db, user, conn_id)
    try:
        res = engine.run_sql(db, conn, body.sql, get_settings(db), user)
    except (sqlguard.SQLBlocked, connectors.ConnectorError) as e:
        raise HTTPException(400, str(e))
    return {"columns": res["columns"], "rows": res["rows"][:20], "row_count": res["row_count"]}


@router.post("/issues/{run_id}/resolve")
def resolve_issue(run_id: int, body: ResolveIn, request: Request, user: User = Depends(steward_up),
                  db: Session = Depends(get_db)):
    """Turn a reported problem into training - a corrected verified example or a business rule - or dismiss it."""
    from .. import connectors, engine
    from ..deps import get_settings
    from ..models import QueryRun
    run = db.get(QueryRun, run_id)
    if not run or not run.issue_status:
        raise HTTPException(404, "Not found")
    conn = get_connection(db, user, run.connection_id)
    comment = body.comment.strip()[:1000]
    if body.action == "example":
        question = body.question.strip() or run.question
        try:
            checked = sqlguard.check(body.sql, conn.db_type).sql
            engine.run_sql(db, conn, checked, get_settings(db), user)          # it must actually run
        except (sqlguard.SQLBlocked, connectors.ConnectorError) as e:
            raise HTTPException(400, f"The corrected SQL did not run: {e}")
        upsert_pair(db, conn, question, checked, "correction", "approved", user.id, analysis=(run.analysis or {}).get("spec"))
        run.issue_status = "fixed"
        run.issue_resolution = comment or "The answer was corrected and added to training. Ask the question again to get the corrected result."
    elif body.action == "note":
        if not body.content.strip():
            raise HTTPException(400, "Write the business rule first.")
        db.add(TrainingItem(connection_id=conn.id, kind="documentation", title=body.title.strip()[:500] or f"Correction: {run.question[:80]}",
                            content=body.content.strip(), source="correction", status="approved", created_by=user.id))
        run.issue_status = "noted"
        run.issue_resolution = comment or "A business rule was added to training. Ask the question again to get the corrected result."
    elif body.action == "dismiss":
        run.issue_status = "dismissed"
        run.issue_resolution = comment or "Reviewed by a data steward: the answer was found to be correct."
    else:
        raise HTTPException(400, "Unknown action.")
    run.issue_resolved_by, run.issue_resolved_at = user.id, now()
    audit(db, request, user, "training.issue_resolved", conn.name, f"run #{run.id} {run.issue_status}")
    db.commit()
    return {"ok": True, "status": run.issue_status}
