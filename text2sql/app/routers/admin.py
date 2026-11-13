import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from .. import config, llm, mailer, rowfilter, security
from ..db import get_db
from ..deps import admin_only, audit, get_settings
from ..models import (ROLES, AuditLog, Connection, ConnectionAccess, ConnectionGroupAccess, DataFilter, EmailLog, EmailSender, LLMModel,
                      Setting, User, UserGroup, UserGroupMember)

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
           "lockout_minutes": (1, 1440), "smtp_port": (1, 65535), "analysis_max_rows": (100, 500000)}


def _public_settings(db: Session) -> dict:
    return {k: v for k, v in get_settings(db).items() if not k.startswith("smtp_")}


@router.get("/settings")
def settings(_: User = Depends(admin_only), db: Session = Depends(get_db)):
    return _public_settings(db)


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
        elif key == "smtp_security" and val not in ("starttls", "ssl", "none"):
            raise HTTPException(400, "smtp_security must be starttls, ssl or none.")
        elif key == "smtp_password":
            if not val:
                continue                    # blank = keep the stored password
            val = security.encrypt(str(val))
        elif isinstance(default, str):
            val = str(val or "").strip()[:500]
        row = db.get(Setting, key)
        if row:
            row.value = {"v": val}
        else:
            db.add(Setting(key=key, value={"v": val}))
        changed.append(f"{key}={'***' if key == 'smtp_password' else val}")
    audit(db, request, admin, "settings.updated", "", ", ".join(changed))
    db.commit()
    return _public_settings(db)


# ---- email senders -------------------------------------------------------------------
class SenderIn(BaseModel):
    label: str
    from_name: str = ""
    from_email: str
    reply_to: str = ""
    mode: str = "smtp"              # smtp | simulate
    host: str = ""
    port: int = 587
    secure: bool = False
    username: str = ""
    password: str = ""              # blank on update = keep
    active: bool = True
    is_default: bool = False


class TestMailIn(BaseModel):
    to: str


def _sender(x: EmailSender) -> dict:
    return {"id": x.id, "label": x.label, "from_name": x.from_name, "from_email": x.from_email, "reply_to": x.reply_to,
            "mode": x.mode, "host": x.host, "port": x.port, "secure": x.secure, "username": x.username,
            "has_password": bool(x.password_enc), "active": x.active, "is_default": x.is_default,
            "last_error": x.last_error, "verified_at": x.verified_at.isoformat() if x.verified_at else None}


def _apply_sender(x: EmailSender, body: SenderIn, db: Session):
    if not body.label.strip():
        raise HTTPException(400, "Give the sender a label.")
    if "@" not in body.from_email:
        raise HTTPException(400, "Enter the From email address.")
    if body.mode not in ("smtp", "simulate"):
        raise HTTPException(400, "Unknown delivery mode.")
    if body.mode == "smtp" and not body.host.strip():
        raise HTTPException(400, "Enter the SMTP host, or choose a provider preset.")
    if not 1 <= body.port <= 65535:
        raise HTTPException(400, "Port must be between 1 and 65535.")
    x.label, x.from_name, x.from_email = body.label.strip()[:200], body.from_name.strip()[:200], body.from_email.strip()
    x.reply_to, x.mode, x.host, x.port = body.reply_to.strip(), body.mode, body.host.strip(), body.port
    x.secure, x.username, x.active = body.secure, body.username.strip(), body.active
    if body.password:
        x.password_enc = security.encrypt(body.password)
    if body.is_default:
        db.execute(update(EmailSender).values(is_default=False))
    x.is_default = body.is_default


@router.get("/senders")
def senders(_: User = Depends(admin_only), db: Session = Depends(get_db)):
    return [_sender(x) for x in db.scalars(select(EmailSender).order_by(EmailSender.is_default.desc(), EmailSender.label))]


@router.post("/senders")
def create_sender(body: SenderIn, request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    x = EmailSender()
    _apply_sender(x, body, db)
    if not db.scalar(select(EmailSender.id).limit(1)):
        x.is_default = True
    db.add(x)
    audit(db, request, admin, "sender.created", x.label, x.from_email)
    db.commit()
    return _sender(x)


@router.put("/senders/{sender_id}")
def update_sender(sender_id: int, body: SenderIn, request: Request, admin: User = Depends(admin_only),
                  db: Session = Depends(get_db)):
    x = db.get(EmailSender, sender_id)
    if not x:
        raise HTTPException(404, "Not found")
    _apply_sender(x, body, db)
    audit(db, request, admin, "sender.updated", x.label)
    db.commit()
    return _sender(x)


@router.delete("/senders/{sender_id}")
def delete_sender(sender_id: int, request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    x = db.get(EmailSender, sender_id)
    if not x:
        raise HTTPException(404, "Not found")
    audit(db, request, admin, "sender.deleted", x.label)
    db.delete(x)
    db.commit()
    return {"ok": True}


@router.post("/senders/{sender_id}/verify")
def verify_sender(sender_id: int, _: User = Depends(admin_only), db: Session = Depends(get_db)):
    x = db.get(EmailSender, sender_id)
    if not x:
        raise HTTPException(404, "Not found")
    try:
        out = {"ok": True, "message": mailer.verify(db, x)}
    except mailer.MailError as e:
        out = {"ok": False, "message": str(e)}
    db.commit()
    return out


@router.post("/senders/{sender_id}/test")
def test_sender(sender_id: int, body: TestMailIn, request: Request, admin: User = Depends(admin_only),
                db: Session = Depends(get_db)):
    x = db.get(EmailSender, sender_id)
    if not x:
        raise HTTPException(404, "Not found")
    to = [a.strip() for a in body.to.replace(";", ",").split(",") if "@" in a]
    try:
        how = mailer.send(db, x, to, f"{config.APP_NAME} test email",
                          f"This is a test message from {config.APP_NAME}, sent from the sender \"{x.label}\".\n\n"
                          "If you received it, scheduled reports can be emailed from this address.", context="test")
        out = {"ok": True, "simulated": how == "simulated",
               "message": (f"Simulated - nothing was actually sent to {', '.join(to)}." if how == "simulated"
                           else f"Test email sent to {', '.join(to)}.")}
    except mailer.MailError as e:
        out = {"ok": False, "message": str(e)}
    audit(db, request, admin, "sender.test", x.label, out["message"])
    db.commit()
    return out


@router.get("/email-log")
def email_log(_: User = Depends(admin_only), db: Session = Depends(get_db)):
    return [{"at": e.created_at.isoformat(), "sender": e.sender_label, "to": e.to_addr, "subject": e.subject,
             "status": e.status, "error": e.error, "context": e.context}
            for e in db.scalars(select(EmailLog).order_by(EmailLog.id.desc()).limit(200))]


# ---- user groups ----------------------------------------------------------------------
class GroupIn(BaseModel):
    name: str
    description: str = ""
    user_ids: list[int] = []


def _group(g: UserGroup, members: dict) -> dict:
    return {"id": g.id, "name": g.name, "description": g.description, "user_ids": members.get(g.id, [])}


def _save_group(g: UserGroup, body: GroupIn, db: Session):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Give the group a name.")
    clash = db.scalar(select(UserGroup).where(func.lower(UserGroup.name) == name.lower()))
    if clash and clash.id != g.id:
        raise HTTPException(400, "A group with this name already exists.")
    g.name, g.description = name[:200], body.description.strip()[:500]
    db.add(g)
    db.flush()
    db.execute(delete(UserGroupMember).where(UserGroupMember.group_id == g.id))
    for uid in set(body.user_ids):
        if db.get(User, uid):
            db.add(UserGroupMember(group_id=g.id, user_id=uid))


@router.get("/groups")
def groups(_: User = Depends(admin_only), db: Session = Depends(get_db)):
    members: dict = {}
    for m in db.scalars(select(UserGroupMember)):
        members.setdefault(m.group_id, []).append(m.user_id)
    return [_group(g, members) for g in db.scalars(select(UserGroup).order_by(UserGroup.name))]


@router.post("/groups")
def create_group(body: GroupIn, request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    g = UserGroup()
    _save_group(g, body, db)
    audit(db, request, admin, "group.created", g.name, f"{len(set(body.user_ids))} member(s)")
    db.commit()
    return {"id": g.id}


@router.put("/groups/{group_id}")
def update_group(group_id: int, body: GroupIn, request: Request, admin: User = Depends(admin_only),
                 db: Session = Depends(get_db)):
    g = db.get(UserGroup, group_id)
    if not g:
        raise HTTPException(404, "Not found")
    _save_group(g, body, db)
    audit(db, request, admin, "group.updated", g.name, f"{len(set(body.user_ids))} member(s)")
    db.commit()
    return {"id": g.id}


@router.delete("/groups/{group_id}")
def delete_group(group_id: int, request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    g = db.get(UserGroup, group_id)
    if not g:
        raise HTTPException(404, "Not found")
    from ..models import ReportShare
    db.execute(delete(ReportShare).where(ReportShare.scope == "group", ReportShare.group_id == g.id))
    db.execute(delete(ConnectionGroupAccess).where(ConnectionGroupAccess.group_id == g.id))
    db.execute(delete(DataFilter).where(DataFilter.scope == "group", DataFilter.group_id == g.id))
    audit(db, request, admin, "group.deleted", g.name)
    db.delete(g)
    db.commit()
    return {"ok": True}


# ---- data access: who can use each data model, and which rows they see -----------------
class AccessIn(BaseModel):
    is_active: bool
    restricted: bool
    user_ids: list[int] = []
    group_ids: list[int] = []


class FilterIn(BaseModel):
    connection_id: int
    table_name: str
    condition: str
    scope: str = "all"              # all | role | group | user
    role: str = ""
    user_id: int | None = None
    group_id: int | None = None
    description: str = ""
    enabled: bool = True


def _filter(f: DataFilter, users: dict, groups: dict | None = None) -> dict:
    who = "Everyone except administrators" if f.scope == "all" else f"Role: {f.role}" if f.scope == "role" \
        else f"Group: {(groups or {}).get(f.group_id, '(deleted)')}" if f.scope == "group" \
        else f"User: {users.get(f.user_id, '(deleted)')}"
    return {"id": f.id, "connection_id": f.connection_id, "table_name": f.table_name, "condition": f.condition,
            "scope": f.scope, "role": f.role, "user_id": f.user_id, "group_id": f.group_id, "description": f.description,
            "enabled": f.enabled, "applies_to": who}


@router.get("/access")
def access_overview(_: User = Depends(admin_only), db: Session = Depends(get_db)):
    users = {u.id: u for u in db.scalars(select(User).order_by(User.email))}
    names = {i: (u.name or u.email) for i, u in users.items()}
    grants: dict = {}
    for a in db.scalars(select(ConnectionAccess)):
        grants.setdefault(a.connection_id, []).append(a.user_id)
    group_grants: dict = {}
    for a in db.scalars(select(ConnectionGroupAccess)):
        group_grants.setdefault(a.connection_id, []).append(a.group_id)
    members: dict = {}
    for m in db.scalars(select(UserGroupMember)):
        members.setdefault(m.group_id, []).append(m.user_id)
    all_groups = list(db.scalars(select(UserGroup).order_by(UserGroup.name)))
    group_names = {g.id: g.name for g in all_groups}
    filters: dict = {}
    for f in db.scalars(select(DataFilter).order_by(DataFilter.table_name, DataFilter.id)):
        filters.setdefault(f.connection_id, []).append(_filter(f, names, group_names))
    return {
        "users": [{"id": u.id, "name": u.name or u.email, "email": u.email, "role": u.role, "is_active": u.is_active}
                  for u in users.values()],
        "placeholders": list(rowfilter.PLACEHOLDERS),
        "groups": [{"id": g.id, "name": g.name, "user_ids": members.get(g.id, [])} for g in all_groups],
        "connections": [{"id": c.id, "name": c.name, "db_type": c.db_type, "is_active": c.is_active,
                         "restricted": c.restricted, "user_ids": grants.get(c.id, []),
                         "group_ids": [g for g in group_grants.get(c.id, []) if g in group_names],
                         "tables": sorted({t["name"] for t in (c.schema_json or {}).get("tables", [])}),
                         "filters": filters.get(c.id, [])}
                        for c in db.scalars(select(Connection).order_by(Connection.name))]}


@router.put("/access/{conn_id}")
def set_access(conn_id: int, body: AccessIn, request: Request, admin: User = Depends(admin_only),
               db: Session = Depends(get_db)):
    c = db.get(Connection, conn_id)
    if not c:
        raise HTTPException(404, "Not found")
    c.is_active, c.restricted = body.is_active, body.restricted
    db.execute(delete(ConnectionAccess).where(ConnectionAccess.connection_id == conn_id))
    for uid in set(body.user_ids):
        if db.get(User, uid):
            db.add(ConnectionAccess(connection_id=conn_id, user_id=uid))
    db.execute(delete(ConnectionGroupAccess).where(ConnectionGroupAccess.connection_id == conn_id))
    for gid in set(body.group_ids):
        if db.get(UserGroup, gid):
            db.add(ConnectionGroupAccess(connection_id=conn_id, group_id=gid))
    audit(db, request, admin, "connection.access_changed", c.name,
          f"enabled={c.is_active} restricted={c.restricted} users={len(set(body.user_ids))} groups={len(set(body.group_ids))}")
    db.commit()
    return {"ok": True}


def _apply_filter(f: DataFilter, body: FilterIn, db: Session):
    conn = db.get(Connection, body.connection_id)
    if not conn:
        raise HTTPException(404, "Data model not found")
    if not body.table_name.strip():
        raise HTTPException(400, "Choose the table the filter applies to.")
    if body.scope not in ("all", "role", "group", "user"):
        raise HTTPException(400, "Unknown scope.")
    if body.scope == "group" and not (body.group_id and db.get(UserGroup, body.group_id)):
        raise HTTPException(400, "Choose the user group.")
    if body.scope == "role" and body.role not in ("analyst", "steward"):
        raise HTTPException(400, "Choose the role (analyst or steward). Administrators are never filtered.")
    if body.scope == "user" and not (body.user_id and db.get(User, body.user_id)):
        raise HTTPException(400, "Choose the user.")
    try:
        rowfilter.validate(body.condition, conn.db_type)
    except ValueError as e:
        raise HTTPException(400, str(e))
    f.connection_id, f.table_name, f.condition = conn.id, body.table_name.strip(), body.condition.strip()
    f.scope, f.role = body.scope, body.role if body.scope == "role" else ""
    f.user_id = body.user_id if body.scope == "user" else None
    f.group_id = body.group_id if body.scope == "group" else None
    f.description, f.enabled = body.description.strip()[:500], body.enabled
    return conn


@router.post("/filters")
def create_filter(body: FilterIn, request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    f = DataFilter()
    conn = _apply_filter(f, body, db)
    db.add(f)
    audit(db, request, admin, "filter.created", conn.name, f"{f.table_name}: {f.condition} [{f.scope}]")
    db.commit()
    return {"id": f.id}


@router.put("/filters/{filter_id}")
def update_filter(filter_id: int, body: FilterIn, request: Request, admin: User = Depends(admin_only),
                  db: Session = Depends(get_db)):
    f = db.get(DataFilter, filter_id)
    if not f:
        raise HTTPException(404, "Not found")
    conn = _apply_filter(f, body, db)
    audit(db, request, admin, "filter.updated", conn.name, f"{f.table_name}: {f.condition} [{f.scope}] enabled={f.enabled}")
    db.commit()
    return {"id": f.id}


@router.delete("/filters/{filter_id}")
def delete_filter(filter_id: int, request: Request, admin: User = Depends(admin_only), db: Session = Depends(get_db)):
    f = db.get(DataFilter, filter_id)
    if not f:
        raise HTTPException(404, "Not found")
    audit(db, request, admin, "filter.deleted", str(f.connection_id), f"{f.table_name}: {f.condition}")
    db.delete(f)
    db.commit()
    return {"ok": True}


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
