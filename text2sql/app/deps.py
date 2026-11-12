"""Shared FastAPI dependencies: current user, roles, settings, audit, access checks."""
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import config, security
from .db import get_db
from .models import AuditLog, Connection, ConnectionAccess, Setting, User


def get_settings(db: Session) -> dict:
    out = dict(config.DEFAULT_SETTINGS)
    for s in db.scalars(select(Setting)):
        if s.key in out:
            out[s.key] = s.value.get("v")
    return out


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    return (fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else ""))[:64]


def audit(db: Session, request: Request | None, user: User | None, action: str, target: str = "", detail: str = ""):
    db.add(AuditLog(user_id=user.id if user else None, user_email=user.email if user else "",
                    action=action, target=str(target)[:500], detail=str(detail)[:4000],
                    ip=client_ip(request) if request else ""))


def _user_from_cookie(request: Request, db: Session, scopes: tuple) -> User:
    claims = security.read_token(request.cookies.get(config.COOKIE_NAME, ""))
    if not claims or claims.get("scope") not in scopes:
        raise HTTPException(401, "Not signed in")
    user = db.get(User, int(claims["sub"]))
    if not user or not user.is_active or user.token_version != claims.get("tv"):
        raise HTTPException(401, "Session expired")
    request.state.scope = claims["scope"]
    return user


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """Fully signed-in user (password + 2FA where enabled, no pending setup)."""
    user = _user_from_cookie(request, db, ("full",))
    # Enforced on every request, so turning on mandatory 2FA applies to live sessions too.
    if user.must_change_password or (not user.totp_enabled and get_settings(db)["enforce_2fa"]):
        raise HTTPException(401, "Account setup required")
    return user


def setup_user(request: Request, db: Session = Depends(get_db)) -> User:
    """Signed in, possibly still required to change password / enrol 2FA."""
    return _user_from_cookie(request, db, ("full", "setup"))


def require(*roles):
    def dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(403, "You do not have permission to do this.")
        return user
    return dep


admin_only = require("admin")
steward_up = require("admin", "steward")


def can_use(db: Session, user: User, conn: Connection) -> bool:
    if user.role == "admin":
        return True
    if not conn.is_active:
        return False
    if not conn.restricted:
        return True
    return db.scalar(select(ConnectionAccess.id).where(
        ConnectionAccess.connection_id == conn.id, ConnectionAccess.user_id == user.id)) is not None


def get_connection(db: Session, user: User, conn_id: int) -> Connection:
    conn = db.get(Connection, conn_id)
    if not conn or not can_use(db, user, conn):
        raise HTTPException(404, "Data model not found")
    return conn
