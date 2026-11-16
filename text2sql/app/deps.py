"""Shared FastAPI dependencies: current user, roles, settings, audit, access checks."""
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import config, security
from .db import get_db
from .models import AuditLog, Company, Connection, ConnectionAccess, ConnectionGroupAccess, Setting, User, UserGroupMember

# settings only the platform administrator changes (they apply to every company); all others are per company
PLATFORM_SETTINGS = {"session_hours", "lockout_attempts", "lockout_minutes", "smtp_host", "smtp_port", "smtp_security",
                     "smtp_user", "smtp_password", "smtp_from"}


def sees_sql(user) -> bool:
    """Whether this person is shown SQL and Python code. Stewards and admins always are (they review and
    fix it); an analyst can be set to "results only" by an administrator."""
    return user.role != "analyst" or user.show_sql is not False


def company_key(company_id: int, key: str) -> str:
    return f"c{company_id}:{key}"


def get_settings(db: Session, company_id: int | None = None) -> dict:
    """Defaults, overridden by installation-wide values, overridden by the company's own values."""
    out = dict(config.DEFAULT_SETTINGS)
    rows = {s.key: s.value.get("v") for s in db.scalars(select(Setting))}
    for k in out:
        if k in rows:
            out[k] = rows[k]
        if company_id and k not in PLATFORM_SETTINGS and company_key(company_id, k) in rows:
            out[k] = rows[company_key(company_id, k)]
    return out


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    return (fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else ""))[:64]


def audit(db: Session, request: Request | None, user: User | None, action: str, target: str = "", detail: str = "",
          company_id: int | None = -1):
    """company_id: -1 = the acting user's company; None = a platform-wide event."""
    db.add(AuditLog(user_id=user.id if user else None, user_email=user.email if user else "",
                    company_id=(user.company_id if user else None) if company_id == -1 else company_id,
                    action=action, target=str(target)[:500], detail=str(detail)[:4000],
                    ip=client_ip(request) if request else ""))


def _user_from_cookie(request: Request, db: Session, scopes: tuple) -> User:
    claims = security.read_token(request.cookies.get(config.COOKIE_NAME, ""))
    if not claims or claims.get("scope") not in scopes:
        raise HTTPException(401, "Not signed in")
    user = db.get(User, int(claims["sub"]))
    if not user or not user.is_active or user.token_version != claims.get("tv"):
        raise HTTPException(401, "Session expired")
    company = db.get(Company, user.company_id) if user.company_id else None
    if company is not None and not company.is_active:
        raise HTTPException(401, "Your company's access has been suspended. Contact the platform administrator.")
    request.state.scope = claims["scope"]
    return user


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """Fully signed-in user (password + 2FA where enabled, no pending setup)."""
    user = _user_from_cookie(request, db, ("full",))
    # Enforced on every request, so turning on mandatory 2FA applies to live sessions too.
    if user.must_change_password or (not user.totp_enabled and get_settings(db, user.company_id)["enforce_2fa"]):
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


def platform_admin(user: User = Depends(current_user)) -> User:
    if not user.is_platform_admin:
        raise HTTPException(403, "Only a platform administrator can do this.")
    return user


def same_company(user: User, obj) -> bool:
    """Is this row (user, group, data model, report ...) in the acting user's company?"""
    return obj is not None and getattr(obj, "company_id", None) == user.company_id


def can_use(db: Session, user: User, conn: Connection) -> bool:
    if conn is None or conn.company_id != user.company_id:      # never another company's data model
        return False
    if user.role == "admin":
        return True
    if not conn.is_active:
        return False
    if not conn.restricted:
        return True
    if db.scalar(select(ConnectionAccess.id).where(
            ConnectionAccess.connection_id == conn.id, ConnectionAccess.user_id == user.id)) is not None:
        return True
    # ...or through any user group they belong to
    return db.scalar(select(ConnectionGroupAccess.id).join(
        UserGroupMember, UserGroupMember.group_id == ConnectionGroupAccess.group_id).where(
        ConnectionGroupAccess.connection_id == conn.id, UserGroupMember.user_id == user.id)) is not None


def get_connection(db: Session, user: User, conn_id: int) -> Connection:
    conn = db.get(Connection, conn_id)
    if not conn or not can_use(db, user, conn):
        raise HTTPException(404, "Data model not found")
    return conn
