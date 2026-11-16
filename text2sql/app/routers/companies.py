"""Companies (tenants) - managed by platform administrators - and each company's logo."""
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import config, security
from ..db import get_db, now
from ..deps import admin_only, audit, current_user, platform_admin
from ..models import Company, Connection, QueryRun, RephraseLog, Report, User

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
        raise HTTPException(400, "Enter a valid email address for the company administrator.")
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
