import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from .. import config, llm, security
from ..db import get_db
from ..deps import admin_only, audit, get_settings
from ..models import ROLES, AuditLog, LLMModel, Setting, User

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ---- users -----------------------------------------------------------------------
class UserIn(BaseModel):
    email: str
    name: str = ""
    role: str = "analyst"
    is_active: bool = True


def _user(u: User) -> dict:
    return {"id": u.id, "email": u.email, "name": u.name, "role": u.role, "is_active": u.is_active,
            "totp_enabled": u.totp_enabled, "locked": security.is_locked(u),
            "must_change_password": u.must_change_password,
            "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
            "created_at": u.created_at.isoformat()}


def _admins_left(db: Session, excluding: int) -> int:
    return db.scalar(select(func.count()).where(User.role == "admin", User.is_active, User.id != excluding))


@router.get("/users")
def users(_: User = Depends(admin_only), db: Session = Depends(get_db)):
    return [_user(u) for u in db.scalars(select(User).order_by(User.email))]


@router.post("/users")
def create_user(body: UserIn, request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(400, "Enter a valid email address.")
    if body.role not in ROLES:
        raise HTTPException(400, "Unknown role.")
    if db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(400, "A user with this email already exists.")
    temp = security.random_password()
    u = User(email=email, name=body.name.strip(), role=body.role, is_active=body.is_active,
             password_hash=security.hash_password(temp), must_change_password=True)
    db.add(u)
    audit(db, request, admin, "user.created", email, body.role)
    db.commit()
    return {**_user(u), "temporary_password": temp}


@router.put("/users/{user_id}")
def update_user(user_id: int, body: UserIn, request: Request, admin: User = Depends(admin_only),
                db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "Not found")
    if body.role not in ROLES:
        raise HTTPException(400, "Unknown role.")
    if u.role == "admin" and (body.role != "admin" or not body.is_active) and _admins_left(db, u.id) == 0:
        raise HTTPException(400, "This is the last active administrator.")
    if not body.is_active and u.is_active:
        u.token_version += 1
    u.name, u.role, u.is_active = body.name.strip(), body.role, body.is_active
    audit(db, request, admin, "user.updated", u.email, f"role={u.role} active={u.is_active}")
    db.commit()
    return _user(u)


@router.post("/users/{user_id}/{action}")
def user_action(user_id: int, action: str, request: Request, admin: User = Depends(admin_only),
                db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "Not found")
    out = {"ok": True}
    if action == "reset-password":
        temp = security.random_password()
        u.password_hash, u.must_change_password = security.hash_password(temp), True
        u.token_version += 1
        out["temporary_password"] = temp
    elif action == "reset-2fa":
        u.totp_enabled, u.totp_secret_enc, u.recovery_codes = False, None, []
        u.token_version += 1
    elif action == "unlock":
        u.locked_until, u.failed_attempts = None, 0
    else:
        raise HTTPException(404, "Not found")
    audit(db, request, admin, f"user.{action}", u.email)
    db.commit()
    return out


@router.delete("/users/{user_id}")
def delete_user(user_id: int, request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "Not found")
    if u.id == admin.id:
        raise HTTPException(400, "You cannot delete your own account.")
    if u.role == "admin" and _admins_left(db, u.id) == 0:
        raise HTTPException(400, "This is the last active administrator.")
    audit(db, request, admin, "user.deleted", u.email)
    db.delete(u)
    db.commit()
    return {"ok": True}


# ---- models ----------------------------------------------------------------------
class ModelIn(BaseModel):
    name: str
    provider: str
    model_id: str
    base_url: str = ""
    api_key: str = ""           # blank on update = keep
    effort: str = ""
    enabled: bool = True
    is_default: bool = False
    price_in: float = 0
    price_out: float = 0


def _model(m: LLMModel) -> dict:
    return {"id": m.id, "name": m.name, "provider": m.provider, "model_id": m.model_id, "base_url": m.base_url,
            "has_key": bool(m.api_key_enc), "effort": m.effort, "enabled": m.enabled, "is_default": m.is_default,
            "price_in": m.price_in, "price_out": m.price_out}


def _apply_model(m: LLMModel, body: ModelIn, db: Session):
    if body.provider not in llm.PROVIDERS:
        raise HTTPException(400, "Unknown provider.")
    if not body.name.strip() or not body.model_id.strip():
        raise HTTPException(400, "Name and model ID are required.")
    if body.effort not in ("", "low", "medium", "high", "xhigh", "max"):
        raise HTTPException(400, "Unknown effort level.")
    if llm.PROVIDERS[body.provider]["needs_url"] and not body.base_url.strip():
        raise HTTPException(400, "A base URL is required for self-hosted models.")
    m.name, m.provider, m.model_id = body.name.strip(), body.provider, body.model_id.strip()
    m.base_url, m.effort, m.enabled = body.base_url.strip(), body.effort, body.enabled
    m.price_in, m.price_out = body.price_in, body.price_out
    if body.api_key:
        m.api_key_enc = security.encrypt(body.api_key.strip())
    if body.is_default:
        db.execute(update(LLMModel).values(is_default=False))
    m.is_default = body.is_default


@router.get("/models")
def models(_: User = Depends(admin_only), db: Session = Depends(get_db)):
    return {"providers": llm.PROVIDERS, "models": [_model(m) for m in db.scalars(select(LLMModel).order_by(LLMModel.name))]}


@router.post("/models")
def create_model(body: ModelIn, request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    if db.scalar(select(LLMModel.id).where(LLMModel.name == body.name.strip())):
        raise HTTPException(400, "A model with this name already exists.")
    m = LLMModel()
    _apply_model(m, body, db)
    db.add(m)
    audit(db, request, admin, "model.created", m.name, f"{m.provider}/{m.model_id}")
    db.commit()
    return _model(m)


@router.put("/models/{model_id}")
def update_model(model_id: int, body: ModelIn, request: Request, admin: User = Depends(admin_only),
                 db: Session = Depends(get_db)):
    m = db.get(LLMModel, model_id)
    if not m:
        raise HTTPException(404, "Not found")
    _apply_model(m, body, db)
    audit(db, request, admin, "model.updated", m.name)
    db.commit()
    return _model(m)


@router.delete("/models/{model_id}")
def delete_model(model_id: int, request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    m = db.get(LLMModel, model_id)
    if not m:
        raise HTTPException(404, "Not found")
    audit(db, request, admin, "model.deleted", m.name)
    db.delete(m)
    db.commit()
    return {"ok": True}


@router.post("/models/{model_id}/test")
def test_model(model_id: int, _: User = Depends(admin_only), db: Session = Depends(get_db)):
    m = db.get(LLMModel, model_id)
    if not m:
        raise HTTPException(404, "Not found")
    try:
        res = llm.complete(m, "You are a connectivity check. Reply with the single word OK.", "ping")
        return {"ok": True, "message": f"Model responded in {res.ms} ms."}
    except llm.LLMError as e:
        return {"ok": False, "message": str(e)}
    except ValueError as e:
        return {"ok": False, "message": str(e)}


# ---- settings ----------------------------------------------------------------------
_LIMITS = {"max_rows": (1, 50000), "query_timeout_s": (5, 900), "rate_limit_per_min": (1, 600),
           "session_hours": (1, 168), "max_repair_attempts": (0, 5), "lockout_attempts": (3, 20),
           "lockout_minutes": (1, 1440)}


@router.get("/settings")
def settings(_: User = Depends(admin_only), db: Session = Depends(get_db)):
    return get_settings(db)


@router.put("/settings")
def save_settings(body: dict, request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    changed = []
    for key, default in config.DEFAULT_SETTINGS.items():
        if key not in body:
            continue
        val = body[key]
        if isinstance(default, bool):
            val = bool(val)
        elif isinstance(default, int):
            try:
                val = int(val)
            except (TypeError, ValueError):
                raise HTTPException(400, f"{key} must be a number.")
            lo, hi = _LIMITS[key]
            if not lo <= val <= hi:
                raise HTTPException(400, f"{key} must be between {lo} and {hi}.")
        elif key == "feedback_mode" and val not in ("approval", "instant"):
            raise HTTPException(400, "feedback_mode must be 'approval' or 'instant'.")
        row = db.get(Setting, key)
        if row:
            row.value = {"v": val}
        else:
            db.add(Setting(key=key, value={"v": val}))
        changed.append(f"{key}={val}")
    audit(db, request, admin, "settings.updated", "", ", ".join(changed))
    db.commit()
    return get_settings(db)


# ---- audit log ---------------------------------------------------------------------
def _audit_query(q: str, action: str):
    stmt = select(AuditLog)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(AuditLog.user_email.ilike(like), AuditLog.target.ilike(like), AuditLog.detail.ilike(like)))
    if action:
        stmt = stmt.where(AuditLog.action.like(f"{action}%"))
    return stmt.order_by(AuditLog.id.desc())


@router.get("/audit")
def audit_log(q: str = "", action: str = "", page: int = 1, _: User = Depends(admin_only),
              db: Session = Depends(get_db)):
    size = 100
    rows = list(db.scalars(_audit_query(q, action).offset((max(page, 1) - 1) * size).limit(size + 1)))
    return {"more": len(rows) > size,
            "items": [{"id": a.id, "at": a.created_at.isoformat(), "user": a.user_email, "action": a.action,
                       "target": a.target, "detail": a.detail, "ip": a.ip} for a in rows[:size]]}


@router.get("/audit.csv")
def audit_csv(q: str = "", action: str = "", _: User = Depends(admin_only), db: Session = Depends(get_db)):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["time_utc", "user", "action", "target", "detail", "ip"])
    for a in db.scalars(_audit_query(q, action).limit(50000)):
        w.writerow([a.created_at.isoformat(), a.user_email, a.action, a.target, a.detail, a.ip])
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="audit-log.csv"'})
