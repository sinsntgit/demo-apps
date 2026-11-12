import re

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .. import mailer, reporting
from ..db import get_db, now
from ..deps import audit, current_user
from ..models import ROLES, EmailSender, QueryRun, Report, ReportShare, ReportSnapshot, User, UserGroup, UserGroupMember

router = APIRouter(prefix="/api/reports", tags=["reports"])


class ReportIn(BaseModel):
    title: str = "Untitled report"
    description: str = ""
    header_text: str = ""
    footer_text: str = ""
    page_numbers: bool = True
    components: list = []


class AddIn(BaseModel):
    run_id: int


class ScheduleIn(BaseModel):
    enabled: bool = False
    frequency: str = "weekly"       # daily | weekdays | weekly | monthly
    time: str = "08:00"
    weekday: int = 0                # Monday = 0
    monthday: int = 1
    tz: str = "UTC"
    recipients: list[str] = []      # any other email addresses
    user_ids: list[int] = []        # people with an account: each gets the report with their own data access
    group_ids: list[int] = []       # every member of these groups
    sender_id: int | None = None    # which email sender to send from (default sender if blank)


class SharesIn(BaseModel):
    shares: list[dict]


class SnapshotIn(BaseModel):
    send: bool = False


def _get(db, user, report_id, edit=False, owner=False) -> Report:
    r = db.get(Report, report_id)
    if not r or not reporting.can_view(db, user, r):
        raise HTTPException(404, "Report not found")
    if owner and not reporting.is_owner(user, r):
        raise HTTPException(403, "Only the report's owner or an administrator can do this.")
    if edit and not reporting.can_edit(db, user, r):
        raise HTTPException(403, "You can view this report but not change it.")
    return r


def _summary(db, user, r: Report, owners: dict) -> dict:
    return {"id": r.id, "title": r.title, "description": r.description, "owner": owners.get(r.owner_id, ""),
            "mine": r.owner_id == user.id, "can_edit": reporting.can_edit(db, user, r),
            "is_owner": reporting.is_owner(user, r), "updated_at": r.updated_at.isoformat(),
            "results": sum(c["type"] == "result" for c in r.components or []),
            "scheduled": bool((r.schedule or {}).get("enabled")),
            "next_run_at": r.next_run_at.isoformat() if r.next_run_at else None}


def _full(db, user, r: Report) -> dict:
    owner = db.get(User, r.owner_id)
    out = {**_summary(db, user, r, {r.owner_id: (owner.name or owner.email) if owner else ""}),
           "header_text": r.header_text, "footer_text": r.footer_text, "page_numbers": r.page_numbers,
           "components": [{k: v for k, v in c.items() if k != "sql"} for c in r.components or []]}
    if reporting.is_owner(user, r):
        out["schedule"] = r.schedule or ScheduleIn().model_dump()
        out["shares"] = [{"scope": s.scope, "user_id": s.user_id, "role": s.role, "group_id": s.group_id, "can_edit": s.can_edit}
                         for s in db.scalars(select(ReportShare).where(ReportShare.report_id == r.id))]
        out["email_ready"] = mailer.configured(db)
    return out


@router.get("")
def list_reports(user: User = Depends(current_user), db: Session = Depends(get_db)):
    reports = reporting.visible_reports(db, user)
    owners = {u.id: u.name or u.email for u in db.scalars(select(User))}
    return [_summary(db, user, r, owners) for r in reports]


@router.get("/people")
def people(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Directory for the sharing and scheduling pickers: people, groups and email senders."""
    counts: dict = {}
    for m in db.scalars(select(UserGroupMember)):
        counts[m.group_id] = counts.get(m.group_id, 0) + 1
    return {"roles": list(ROLES),
            "users": [{"id": u.id, "name": u.name or u.email, "email": u.email, "role": u.role, "me": u.id == user.id}
                      for u in db.scalars(select(User).where(User.is_active).order_by(User.email))],
            "groups": [{"id": g.id, "name": g.name, "description": g.description, "members": counts.get(g.id, 0)}
                       for g in db.scalars(select(UserGroup).order_by(UserGroup.name))],
            "senders": [{"id": x.id, "label": f"{x.label} <{x.from_email}>", "is_default": x.is_default,
                         "simulated": x.mode == "simulate"}
                        for x in db.scalars(select(EmailSender).where(EmailSender.active)
                                            .order_by(EmailSender.is_default.desc(), EmailSender.label))]}


@router.post("")
def create(body: ReportIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    try:
        comps = reporting.clean_components(db, user, body.components, [])
    except ValueError as e:
        raise HTTPException(400, str(e))
    r = Report(owner_id=user.id, title=body.title.strip()[:300] or "Untitled report", description=body.description,
               header_text=body.header_text[:300], footer_text=body.footer_text[:300], page_numbers=body.page_numbers,
               components=comps)
    db.add(r)
    db.flush()
    audit(db, request, user, "report.created", r.title)
    db.commit()
    return _full(db, user, r)


@router.get("/{report_id}")
def get_report(report_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _full(db, user, _get(db, user, report_id))


@router.put("/{report_id}")
def update(report_id: int, body: ReportIn, request: Request, user: User = Depends(current_user),
           db: Session = Depends(get_db)):
    r = _get(db, user, report_id, edit=True)
    try:
        r.components = reporting.clean_components(db, user, body.components, r.components or [])
    except ValueError as e:
        raise HTTPException(400, str(e))
    r.title = body.title.strip()[:300] or r.title
    r.description, r.header_text, r.footer_text = body.description, body.header_text[:300], body.footer_text[:300]
    r.page_numbers, r.updated_at = body.page_numbers, now()
    audit(db, request, user, "report.updated", r.title)
    db.commit()
    return _full(db, user, r)


@router.delete("/{report_id}")
def remove(report_id: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = _get(db, user, report_id, owner=True)
    for s in db.scalars(select(ReportSnapshot).where(ReportSnapshot.report_id == r.id)):
        reporting.snapshot_path(r.id, s.id).unlink(missing_ok=True)
    db.execute(delete(ReportShare).where(ReportShare.report_id == r.id))
    db.execute(delete(ReportSnapshot).where(ReportSnapshot.report_id == r.id))
    audit(db, request, user, "report.deleted", r.title)
    db.delete(r)
    db.commit()
    return {"ok": True}


@router.post("/{report_id}/components")
def add_result(report_id: int, body: AddIn, request: Request, user: User = Depends(current_user),
               db: Session = Depends(get_db)):
    """Append one of the user's answered questions to a report (used from the chat's Export menu)."""
    r = _get(db, user, report_id, edit=True)
    run = db.get(QueryRun, body.run_id)
    if not run or run.user_id != user.id or run.status != "success":
        raise HTTPException(400, "Only your own successfully answered questions can be added.")
    if len(r.components or []) >= reporting.MAX_COMPONENTS:
        raise HTTPException(400, "This report is full.")
    r.components = [*(r.components or []), reporting.result_component(run)]
    r.updated_at = now()
    audit(db, request, user, "report.result_added", r.title, f"run #{run.id}")
    db.commit()
    return {"ok": True, "title": r.title}


@router.get("/{report_id}/render")
def render(report_id: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Re-runs every result for the person opening the report."""
    r = _get(db, user, report_id)
    out = reporting.render(db, r, user)
    audit(db, request, user, "report.opened", r.title)
    db.commit()
    return out


@router.get("/{report_id}/pdf")
def pdf(report_id: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = _get(db, user, report_id)
    data = reporting.build_pdf(reporting.render(db, r, user))
    audit(db, request, user, "report.exported", r.title)
    db.commit()
    name = re.sub(r"[^\w\- ]", "", r.title).strip()[:60] or "report"
    return Response(data, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{name}.pdf"'})


@router.put("/{report_id}/schedule")
def set_schedule(report_id: int, body: ScheduleIn, request: Request, user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    r = _get(db, user, report_id, owner=True)
    if body.frequency not in ("daily", "weekdays", "weekly", "monthly"):
        raise HTTPException(400, "Unknown frequency.")
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", body.time):
        raise HTTPException(400, "Time must be HH:MM (24-hour).")
    recipients = [x.strip() for x in body.recipients if x.strip()]
    bad = [x for x in recipients if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", x)]
    if bad:
        raise HTTPException(400, f"Not a valid email address: {bad[0]}")
    user_ids = [u for u in dict.fromkeys(body.user_ids) if db.get(User, u)]
    group_ids = [g for g in dict.fromkeys(body.group_ids) if db.get(UserGroup, g)]
    r.schedule = {**body.model_dump(), "recipients": recipients, "user_ids": user_ids, "group_ids": group_ids,
                  "weekday": body.weekday % 7, "monthday": min(max(body.monthday, 1), 28)}
    people_, extra = reporting.recipients(db, r)
    if len(people_) + len(extra) > 200:
        raise HTTPException(400, "At most 200 recipients in total.")
    r.next_run_at = reporting.next_run(r.schedule)
    audit(db, request, user, "report.schedule_changed", r.title,
          f"{body.frequency} {body.time} {body.tz}; {len(people_)} people + {len(extra)} other address(es)" if body.enabled else "off")
    db.commit()
    return {"schedule": r.schedule, "next_run_at": r.next_run_at.isoformat() if r.next_run_at else None,
            "recipient_count": len(people_) + len(extra)}


@router.put("/{report_id}/shares")
def set_shares(report_id: int, body: SharesIn, request: Request, user: User = Depends(current_user),
               db: Session = Depends(get_db)):
    r = _get(db, user, report_id, owner=True)
    db.execute(delete(ReportShare).where(ReportShare.report_id == r.id))
    n = 0
    for s in body.shares[:200]:
        if s.get("scope") == "role" and s.get("role") in ROLES:
            db.add(ReportShare(report_id=r.id, scope="role", role=s["role"], can_edit=bool(s.get("can_edit"))))
            n += 1
        elif s.get("scope") == "group" and db.get(UserGroup, int(s.get("group_id") or 0)):
            db.add(ReportShare(report_id=r.id, scope="group", group_id=int(s["group_id"]), can_edit=bool(s.get("can_edit"))))
            n += 1
        elif s.get("scope") == "user" and db.get(User, int(s.get("user_id") or 0)):
            db.add(ReportShare(report_id=r.id, scope="user", user_id=int(s["user_id"]), can_edit=bool(s.get("can_edit"))))
            n += 1
    audit(db, request, user, "report.sharing_changed", r.title, f"{n} share(s)")
    db.commit()
    return {"ok": True}


@router.get("/{report_id}/snapshots")
def snapshots(report_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Saved PDFs. They were rendered with the owner's access, so only the owner and admins see them."""
    r = _get(db, user, report_id, owner=True)
    return [{"id": s.id, "at": s.created_at.isoformat(), "trigger": s.trigger, "status": s.status,
             "file_name": s.file_name, "emailed_to": s.emailed_to or [], "note": s.note}
            for s in db.scalars(select(ReportSnapshot).where(ReportSnapshot.report_id == r.id)
                                .order_by(ReportSnapshot.id.desc()))]


@router.post("/{report_id}/snapshots")
def snapshot_now(report_id: int, body: SnapshotIn, request: Request, user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    r = _get(db, user, report_id, owner=True)
    snap = reporting.make_snapshot(db, r, "manual", send=body.send)
    audit(db, request, user, "report.snapshot", r.title, snap.note or snap.status)
    db.commit()
    return {"id": snap.id, "status": snap.status, "note": snap.note, "emailed_to": snap.emailed_to or []}


@router.get("/{report_id}/snapshots/{snapshot_id}/pdf")
def snapshot_pdf(report_id: int, snapshot_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = _get(db, user, report_id, owner=True)
    snap = db.get(ReportSnapshot, snapshot_id)
    path = reporting.snapshot_path(r.id, snapshot_id)
    if not snap or snap.report_id != r.id or not path.is_file():
        raise HTTPException(404, "Snapshot not found")
    return FileResponse(path, media_type="application/pdf", filename=snap.file_name or "report.pdf")
