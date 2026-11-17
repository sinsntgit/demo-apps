"""Companies (tenants) - managed by platform administrators - and each company's logo."""
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .. import config, security
from ..db import get_db, now
from ..deps import admin_only, audit, current_user, platform_admin
from ..models import (ROLES, Company, Connection, ConnectionAccess, ConversationShare, DataFilter, QueryRun, RephraseLog, Report,
                      ReportShare, User, UserGroupMember)

router = APIRouter(prefix="/api", tags=["companies"])
LOGOS = config.DATA_DIR / "logos"
MAX_LOGO = 512 * 1024
# image formats accepted for logos, recognised by their first bytes (SVG is refused: it can carry scripts)
SIGNATURES = {b"\x89PNG\r\n\x1a\n": ("png", "image/png"), b"\xff\xd8\xff": ("jpg", "image/jpeg")}


class CompanyIn(BaseModel):
    name: str
    admin_email: str = ""
    admin_name: str = ""
    samples: bool = True


class CompanyUpdate(BaseModel):
    name: str
    is_active: bool = True


class AdminIn(BaseModel):
    email: str
    name: str = ""


def _summary(db: Session, c: Company, me: User) -> dict:
    since = now() - timedelta(days=30)
    users = list(db.scalars(select(User).where(User.company_id == c.id)))
    conn_ids = list(db.scalars(select(Connection.id).where(Connection.company_id == c.id)))
    runs = db.execute(select(func.count(), func.coalesce(func.sum(QueryRun.cost), 0.0))
                      .where(QueryRun.company_id == c.id, QueryRun.created_at >= since)).one()
    reph = db.scalar(select(func.coalesce(func.sum(RephraseLog.cost), 0.0)).where(
        RephraseLog.connection_id.in_(conn_ids), RephraseLog.created_at >= since)) if conn_ids else 0.0
    return {"id": c.id, "name": c.name, "is_active": c.is_active, "is_mine": c.id == me.company_id, "has_logo": bool(c.logo_file),
            "pptx_template": c.pptx_template or "",
            "users": len(users), "data_models": len(conn_ids),
            "reports": db.scalar(select(func.count()).where(Report.company_id == c.id)),
            "admins": [{"id": u.id, "email": u.email, "name": u.name, "is_active": u.is_active} for u in users if u.role == "admin"],
            "questions_30d": runs[0], "spend_30d": round(float(runs[1]) + float(reph or 0), 4),
            "created_at": c.created_at.isoformat()}


def _get(db: Session, company_id: int) -> Company:
    c = db.get(Company, company_id)
    if not c:
        raise HTTPException(404, "Company not found")
    return c


def _new_admin(db: Session, company: Company, email: str, name: str) -> tuple[User, str]:
    email = email.strip().lower()
    if "@" not in email:
        raise HTTPException(400, "Enter a valid email address.")
    if db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(400, "A user with this email already exists (an email address belongs to one company).")
    temp = security.random_password()
    u = User(email=email, name=name.strip(), role="admin", company_id=company.id, password_hash=security.hash_password(temp),
             must_change_password=True)
    db.add(u)
    return u, temp


@router.get("/admin/companies")
def companies(me: User = Depends(platform_admin), db: Session = Depends(get_db)):
    """Every company with its size and last-30-day use. No company's data is shown here, only counts."""
    return [_summary(db, c, me) for c in db.scalars(select(Company).order_by(Company.name))]


@router.post("/admin/companies")
def create_company(body: CompanyIn, request: Request, me: User = Depends(platform_admin), db: Session = Depends(get_db)):
    name = body.name.strip()[:200]
    if not name:
        raise HTTPException(400, "Give the company a name.")
    if db.scalar(select(Company.id).where(func.lower(Company.name) == name.lower())):
        raise HTTPException(400, "A company with this name already exists.")
    c = Company(name=name, hidden_models=[], hidden_senders=[])
    db.add(c)
    db.flush()
    out = {}
    if body.admin_email.strip():
        u, temp = _new_admin(db, c, body.admin_email, body.admin_name)
        out = {"admin_email": u.email, "temporary_password": temp}
    if body.samples:
        from ..main import add_retail_sample
        add_retail_sample(db, c.id)
    audit(db, request, me, "company.created", name, f"admin={body.admin_email.strip() or '-'} samples={body.samples}", company_id=None)
    db.commit()
    if body.samples:
        from ..main import add_sample_model
        add_sample_model("sap_training.json", c.id)
    return {**_summary(db, c, me), **out}


@router.put("/admin/companies/{company_id}")
def update_company(company_id: int, body: CompanyUpdate, request: Request, me: User = Depends(platform_admin),
                   db: Session = Depends(get_db)):
    c = _get(db, company_id)
    name = body.name.strip()[:200]
    if not name:
        raise HTTPException(400, "Give the company a name.")
    if db.scalar(select(Company.id).where(func.lower(Company.name) == name.lower(), Company.id != c.id)):
        raise HTTPException(400, "A company with this name already exists.")
    if not body.is_active and c.id == me.company_id:
        raise HTTPException(400, "You cannot suspend your own company.")
    if c.is_active and not body.is_active:            # sign everyone out
        for u in db.scalars(select(User).where(User.company_id == c.id)):
            u.token_version += 1
    c.name, c.is_active = name, body.is_active
    audit(db, request, me, "company.updated", c.name, f"active={c.is_active}", company_id=None)
    db.commit()
    return _summary(db, c, me)


@router.post("/admin/companies/{company_id}/admins")
def add_admin(company_id: int, body: AdminIn, request: Request, me: User = Depends(platform_admin), db: Session = Depends(get_db)):
    c = _get(db, company_id)
    u, temp = _new_admin(db, c, body.email, body.name)
    audit(db, request, me, "company.admin_added", c.name, u.email, company_id=None)
    db.commit()
    return {"email": u.email, "temporary_password": temp}


class CompanyUserIn(BaseModel):
    email: str
    name: str = ""
    role: str = "analyst"
    show_sql: bool = True


class MoveIn(BaseModel):
    role: str = "analyst"
    show_sql: bool = True
    reports_to: int | None = None      # an administrator of the old company who takes over the person's reports


def _person(u: User) -> dict:
    return {"id": u.id, "email": u.email, "name": u.name, "role": u.role, "is_active": u.is_active,
            "show_sql": u.show_sql is not False, "is_platform_admin": bool(u.is_platform_admin),
            "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None}


@router.get("/admin/companies/{company_id}/users")
def company_users(company_id: int, me: User = Depends(platform_admin), db: Session = Depends(get_db)):
    """The people of one company (names, roles) - so a platform administrator can add or move them. No data."""
    c = _get(db, company_id)
    people = list(db.scalars(select(User).where(User.company_id == c.id).order_by(User.email)))
    owned = dict(db.execute(select(Report.owner_id, func.count()).where(Report.company_id == c.id).group_by(Report.owner_id)).all())
    return [{**_person(u), "reports": owned.get(u.id, 0)} for u in people]


@router.post("/admin/companies/{company_id}/users")
def add_company_user(company_id: int, body: CompanyUserIn, request: Request, me: User = Depends(platform_admin),
                     db: Session = Depends(get_db)):
    """Add a person of any role straight into a company."""
    c = _get(db, company_id)
    if body.role not in ROLES:
        raise HTTPException(400, "Unknown role.")
    u, temp = _new_admin(db, c, body.email, body.name)
    u.role, u.show_sql = body.role, (body.show_sql if body.role == "analyst" else True)
    db.flush()
    detail = f"{u.email} as {u.role}{'' if u.show_sql else ', results only'}"
    audit(db, request, me, "company.user_added", c.name, detail, company_id=None)
    audit(db, request, me, "user.created", u.email, f"{detail} - added by the platform administrator", company_id=c.id)
    db.commit()
    return {**_person(u), "temporary_password": temp}


@router.post("/admin/companies/{company_id}/users/{user_id}/move")
def move_user(company_id: int, user_id: int, body: MoveIn, request: Request, me: User = Depends(platform_admin),
              db: Session = Depends(get_db)):
    """Move a person to this company. Everything that tied them to their old company is removed: group
    memberships, direct data-model access, personal row filters, things shared with them personally and
    their place on report schedules. Their reports are handed to an administrator of the old company with
    any schedule paused; their chats stay with the old company. They are signed out."""
    target = _get(db, company_id)
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "Not found")
    if body.role not in ROLES:
        raise HTTPException(400, "Unknown role.")
    if u.company_id == target.id:
        raise HTTPException(400, f"{u.email} is already in {target.name}.")
    if u.id == me.id:
        raise HTTPException(400, f"You are signed in as {me.email}, so this is your own account: you cannot move it. "
                                 "Sign in as another platform administrator to do it.")
    old = db.get(Company, u.company_id) if u.company_id else None
    old_name = old.name if old else "no company"
    if u.role == "admin" and u.is_active and db.scalar(select(func.count()).where(
            User.role == "admin", User.is_active, User.id != u.id, User.company_id == u.company_id)) == 0:
        raise HTTPException(400, f"{u.email} is the last active administrator of {old_name}. Add another administrator "
                                 "to that company first (＋ User), then move them.")
    reports = list(db.scalars(select(Report).where(Report.owner_id == u.id)))
    heir = None
    if reports:
        heir = db.get(User, body.reports_to) if body.reports_to else None
        if not heir or heir.id == u.id or heir.company_id != u.company_id or heir.role != "admin" or not heir.is_active:
            raise HTTPException(400, f"{u.email} owns {len(reports)} report(s). Choose an active administrator of "
                                     f"{old_name} to take them over.")
    paused = 0
    for r in reports:
        r.owner_id = heir.id
        if (r.schedule or {}).get("enabled"):
            r.schedule, r.next_run_at = {**r.schedule, "enabled": False}, None
            paused += 1
    # their place on other reports' schedules in the old company
    for r in db.scalars(select(Report).where(Report.company_id == u.company_id, Report.schedule.is_not(None))):
        ids = (r.schedule or {}).get("user_ids") or []
        if any(int(i) == u.id for i in ids):
            r.schedule = {**r.schedule, "user_ids": [i for i in ids if int(i) != u.id]}
    for model in (UserGroupMember, ConnectionAccess, DataFilter, ReportShare, ConversationShare):
        db.execute(delete(model).where(model.user_id == u.id))
    u.company_id, u.role = target.id, body.role
    u.show_sql = body.show_sql if body.role == "analyst" else True
    if u.role != "admin":
        u.is_platform_admin = False
    u.token_version += 1                       # signed out: the next sign-in opens the new company
    detail = (f"{u.email}: {old_name} → {target.name} as {u.role}"
              + (f"; {len(reports)} report(s) handed to {heir.email}" if reports else "")
              + (f", {paused} schedule(s) paused" if paused else ""))
    audit(db, request, me, "company.user_moved", target.name, detail, company_id=None)
    if old:
        audit(db, request, me, "user.moved_out", u.email, detail, company_id=old.id)
    audit(db, request, me, "user.moved_in", u.email, detail, company_id=target.id)
    db.commit()
    return {**_person(u), "reports_handed_over": len(reports), "schedules_paused": paused,
            "reports_to": heir.email if heir else None}


@router.post("/admin/companies/{company_id}/admins/{user_id}/reset-password")
def reset_admin(company_id: int, user_id: int, request: Request, me: User = Depends(platform_admin), db: Session = Depends(get_db)):
    """For a company whose administrators are locked out. Only administrators of that company."""
    c = _get(db, company_id)
    u = db.get(User, user_id)
    if not u or u.company_id != c.id or u.role != "admin":
        raise HTTPException(404, "Not found")
    temp = security.random_password()
    u.password_hash, u.must_change_password, u.token_version = security.hash_password(temp), True, u.token_version + 1
    u.locked_until, u.failed_attempts = None, 0
    audit(db, request, me, "company.admin_password_reset", c.name, u.email, company_id=None)
    db.commit()
    return {"email": u.email, "temporary_password": temp}


# ---- logos ----------------------------------------------------------------------------------
async def _save_logo(db: Session, c: Company, upload: UploadFile) -> None:
    data = await upload.read(MAX_LOGO + 1)
    if len(data) > MAX_LOGO:
        raise HTTPException(400, "The logo must be at most 512 KB.")
    kind = next((v for sig, v in SIGNATURES.items() if data.startswith(sig)), None)
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        kind = ("webp", "image/webp")
    if not kind:
        raise HTTPException(400, "Upload a PNG, JPEG or WebP image. (SVG is not accepted.)")
    LOGOS.mkdir(parents=True, exist_ok=True)
    for old in LOGOS.glob(f"{c.id}.*"):
        old.unlink()
    name = f"{c.id}.{kind[0]}"
    (LOGOS / name).write_bytes(data)
    c.logo_file = name


def _remove_logo(c: Company) -> None:
    for old in LOGOS.glob(f"{c.id}.*"):
        old.unlink()
    c.logo_file = ""


@router.get("/company/logo")
def my_logo(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The signed-in person's own company logo (never another company's)."""
    c = db.get(Company, user.company_id) if user.company_id else None
    path = LOGOS / c.logo_file if c and c.logo_file else None
    if not path or not path.is_file():
        raise HTTPException(404, "No logo")
    media = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}[Path(c.logo_file).suffix[1:]]
    return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=300",
                                                          "Content-Security-Policy": "default-src 'none'"})


@router.post("/company/logo")
async def upload_my_logo(request: Request, upload: UploadFile = File(...), admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    c = _get(db, admin.company_id)
    await _save_logo(db, c, upload)
    audit(db, request, admin, "company.logo_changed", c.name)
    db.commit()
    return {"ok": True}


@router.delete("/company/logo")
def delete_my_logo(request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    c = _get(db, admin.company_id)
    _remove_logo(c)
    audit(db, request, admin, "company.logo_removed", c.name)
    db.commit()
    return {"ok": True}


@router.post("/admin/companies/{company_id}/logo")
async def upload_logo(company_id: int, request: Request, upload: UploadFile = File(...), me: User = Depends(platform_admin),
                      db: Session = Depends(get_db)):
    c = _get(db, company_id)
    await _save_logo(db, c, upload)
    audit(db, request, me, "company.logo_changed", c.name, company_id=None)
    db.commit()
    return {"ok": True}


def logo_path(db: Session, company_id: int | None) -> Path | None:
    """For report PDFs."""
    c = db.get(Company, company_id) if company_id else None
    p = LOGOS / c.logo_file if c and c.logo_file else None
    return p if p and p.is_file() else None


# ---- PowerPoint templates ---------------------------------------------------------------------
TEMPLATES = config.DATA_DIR / "templates"
MAX_TEMPLATE = 25 * 1024 * 1024
_POTX = b"application/vnd.openxmlformats-officedocument.presentationml.template.main+xml"
_PPTX = b"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"


async def _save_template(c: Company, upload: UploadFile) -> None:
    """Accept a .pptx or .potx; check it really is one (and not a zip bomb); store it as <id>.pptx."""
    import io
    import zipfile
    data = await upload.read(MAX_TEMPLATE + 1)
    if len(data) > MAX_TEMPLATE:
        raise HTTPException(400, "The template must be at most 25 MB.")
    try:
        zin = zipfile.ZipFile(io.BytesIO(data))
        if "ppt/presentation.xml" not in zin.namelist() or sum(i.file_size for i in zin.infolist()) > 300 * 1024 * 1024:
            raise ValueError
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:     # a .potx becomes a .pptx
            for item in zin.infolist():
                blob = zin.read(item.filename)
                if item.filename == "[Content_Types].xml":
                    blob = blob.replace(_POTX, _PPTX)
                zout.writestr(item, blob)
        data = out.getvalue()
        from pptx import Presentation
        Presentation(io.BytesIO(data))                 # it must open
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "That is not a PowerPoint file. Upload a .pptx or .potx template.")
    TEMPLATES.mkdir(parents=True, exist_ok=True)
    (TEMPLATES / f"{c.id}.pptx").write_bytes(data)
    c.pptx_template = Path(upload.filename or "template.pptx").name[:255]


def template_path(db: Session, company_id: int | None) -> Path | None:
    c = db.get(Company, company_id) if company_id else None
    p = TEMPLATES / f"{c.id}.pptx" if c and c.pptx_template else None
    return p if p and p.is_file() else None


@router.post("/admin/companies/{company_id}/template")
async def upload_template(company_id: int, request: Request, upload: UploadFile = File(...), me: User = Depends(platform_admin),
                          db: Session = Depends(get_db)):
    c = _get(db, company_id)
    await _save_template(c, upload)
    audit(db, request, me, "company.template_changed", c.name, c.pptx_template, company_id=None)
    db.commit()
    return {"ok": True, "pptx_template": c.pptx_template}


@router.delete("/admin/companies/{company_id}/template")
def remove_template(company_id: int, request: Request, me: User = Depends(platform_admin), db: Session = Depends(get_db)):
    c = _get(db, company_id)
    (TEMPLATES / f"{c.id}.pptx").unlink(missing_ok=True)
    c.pptx_template = ""
    audit(db, request, me, "company.template_removed", c.name, company_id=None)
    db.commit()
    return {"ok": True}


@router.post("/company/template")
async def upload_my_template(request: Request, upload: UploadFile = File(...), admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    c = _get(db, admin.company_id)
    await _save_template(c, upload)
    audit(db, request, admin, "company.template_changed", c.name, c.pptx_template)
    db.commit()
    return {"ok": True, "pptx_template": c.pptx_template}


@router.delete("/company/template")
def remove_my_template(request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    c = _get(db, admin.company_id)
    (TEMPLATES / f"{c.id}.pptx").unlink(missing_ok=True)
    c.pptx_template = ""
    audit(db, request, admin, "company.template_removed", c.name)
    db.commit()
    return {"ok": True}
