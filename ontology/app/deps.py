"""Shared FastAPI dependencies: current user, roles, settings, audit, access checks."""
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import config, security
from .db import get_db
from .models import AuditLog, Folder, FolderAccess, Ontology, Setting, User


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
builder_up = require("admin", "ontologist")


# ---- access: enforced here, on every path; the UI only hides things ---------------------------
RANK = {None: 0, "": 0, "view": 1, "edit": 2, "manage": 3}


def folder_level(db: Session, user: User, folder_id: int | None) -> str | None:
    """The user's access to a folder: manage (owner / admin), edit, view or None. Inherited from parent folders."""
    best, seen = None, set()
    while folder_id and folder_id not in seen:
        seen.add(folder_id)
        f = db.get(Folder, folder_id)
        if not f:
            break
        lvl = "manage" if f.owner_id == user.id else f.everyone or None
        grant = db.scalar(select(FolderAccess.level).where(FolderAccess.folder_id == f.id, FolderAccess.user_id == user.id))
        for x in (lvl, grant):
            if RANK[x] > RANK[best]:
                best = x
        folder_id = f.parent_id
    if user.role == "admin":
        return "manage"
    if user.role == "viewer" and best:
        return "view"                       # the Viewer role never edits, whatever a folder grants
    return best


def level(db: Session, user: User, o: Ontology) -> str | None:
    """The user's access to an ontology: manage, edit, view or None."""
    if user.role == "admin":
        return "manage"
    best = "manage" if o.owner_id == user.id else "view" if o.visibility == "shared" else None
    f = folder_level(db, user, o.folder_id)
    if RANK[f] > RANK[best]:
        best = "edit" if f == "manage" and o.owner_id != user.id else f     # a folder's owner can edit what others put in it
    if user.role == "viewer" and best:
        return "view"
    return best


def get_ontology(db: Session, user: User, oid: int, need: str = "view") -> Ontology:
    o = db.get(Ontology, oid)
    lvl = level(db, user, o) if o else None
    if not lvl:
        raise HTTPException(404, "Ontology not found")
    if RANK[lvl] < RANK[need]:
        raise HTTPException(403, "You have read-only access to this ontology." if need == "edit"
                            else "Only the owner or an administrator can do this.")
    o.my_level = lvl
    return o


def get_folder(db: Session, user: User, fid: int, need: str = "view") -> Folder:
    f = db.get(Folder, fid)
    lvl = folder_level(db, user, fid) if f else None
    if not lvl:
        raise HTTPException(404, "Folder not found")
    if RANK[lvl] < RANK[need]:
        raise HTTPException(403, "You do not have permission to change this folder.")
    f.my_level = lvl
    return f
