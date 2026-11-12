from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import config, security
from ..db import get_db, now
from ..deps import audit, client_ip, current_user, get_settings, setup_user
from ..models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    email: str
    password: str


class CodeIn(BaseModel):
    code: str


class PasswordIn(BaseModel):
    current: str
    new: str


class DisableIn(BaseModel):
    password: str
    code: str


def _set_cookie(response: Response, user: User, scope: str, hours: float):
    response.set_cookie(config.COOKIE_NAME, security.make_token(user, scope, hours), max_age=int(hours * 3600),
                        httponly=True, samesite="strict", secure=config.COOKIE_SECURE, path="/")


def _requirements(user: User, settings: dict) -> list[str]:
    req = []
    if user.must_change_password:
        req.append("change_password")
    if settings["enforce_2fa"] and not user.totp_enabled:
        req.append("setup_2fa")
    return req


def _finish(response: Response, db: Session, user: User) -> dict:
    settings = get_settings(db)
    req = _requirements(user, settings)
    _set_cookie(response, user, "setup" if req else "full", settings["session_hours"])
    return {"step": "done", "requirements": req}


def _me(user: User, db: Session, scope: str) -> dict:
    settings = get_settings(db)
    return {"id": user.id, "email": user.email, "name": user.name, "role": user.role,
            "totp_enabled": user.totp_enabled, "recovery_codes_left": len(user.recovery_codes or []),
            "requirements": _requirements(user, settings), "scope": scope, "app_name": config.APP_NAME,
            "enforce_2fa": settings["enforce_2fa"]}


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    ip = client_ip(request)
    if not security.limiter.allow(f"login:{ip}", 20, 300):
        raise HTTPException(429, "Too many sign-in attempts. Try again in a few minutes.")
    settings = get_settings(db)
    user = db.scalar(select(User).where(User.email == body.email.strip().lower()))
    if user and security.is_locked(user):
        audit(db, request, user, "login.locked")
        db.commit()
        raise HTTPException(423, "Account temporarily locked after repeated failed sign-ins. Try again later.")
    if not user or not user.is_active or not security.verify_password(body.password, user.password_hash):
        if user:
            security.register_failure(user, settings["lockout_attempts"], settings["lockout_minutes"])
            audit(db, request, user, "login.failed")
            db.commit()
        else:
            security.verify_password(body.password, "$2b$12$" + "x" * 53)   # equalise timing
        raise HTTPException(401, "Incorrect email or password.")
    if user.totp_enabled:
        _set_cookie(response, user, "mfa", 0.17)
        db.commit()
        return {"step": "mfa"}
    user.failed_attempts, user.last_login_at = 0, now()
    audit(db, request, user, "login.success")
    out = _finish(response, db, user)
    db.commit()
    return out


@router.post("/mfa")
def mfa(body: CodeIn, request: Request, response: Response, db: Session = Depends(get_db)):
    claims = security.read_token(request.cookies.get(config.COOKIE_NAME, ""))
    if not claims or claims.get("scope") != "mfa":
        raise HTTPException(401, "Sign in again.")
    user = db.get(User, int(claims["sub"]))
    if not user or not user.is_active or user.token_version != claims.get("tv") or not user.totp_enabled:
        raise HTTPException(401, "Sign in again.")
    if security.is_locked(user):
        raise HTTPException(423, "Account temporarily locked. Try again later.")
    settings = get_settings(db)
    counter = security.verify_totp(security.decrypt(user.totp_secret_enc), body.code, user.totp_last_counter)
    used_recovery = False
    if counter is None:
        remaining = security.use_recovery_code(user.recovery_codes or [], body.code)
        if remaining is None:
            security.register_failure(user, settings["lockout_attempts"], settings["lockout_minutes"])
            audit(db, request, user, "login.mfa_failed")
            db.commit()
            raise HTTPException(401, "That code is not valid.")
        user.recovery_codes, used_recovery = remaining, True
    else:
        user.totp_last_counter = counter
    user.failed_attempts, user.last_login_at = 0, now()
    audit(db, request, user, "login.success", detail="recovery code" if used_recovery else "2fa")
    out = _finish(response, db, user)
    db.commit()
    return out


@router.get("/me")
def me(request: Request, user: User = Depends(setup_user), db: Session = Depends(get_db)):
    return _me(user, db, request.state.scope)


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    claims = security.read_token(request.cookies.get(config.COOKIE_NAME, ""))
    if claims:
        user = db.get(User, int(claims["sub"]))
        if user:
            audit(db, request, user, "logout")
            db.commit()
    response.delete_cookie(config.COOKIE_NAME, path="/")
    return {"ok": True}


@router.post("/change-password")
def change_password(body: PasswordIn, request: Request, response: Response,
                    user: User = Depends(setup_user), db: Session = Depends(get_db)):
    if not security.verify_password(body.current, user.password_hash):
        raise HTTPException(400, "Current password is incorrect.")
    problem = security.password_problem(body.new)
    if problem:
        raise HTTPException(400, problem)
    if body.new == body.current:
        raise HTTPException(400, "Choose a password different from the current one.")
    user.password_hash = security.hash_password(body.new)
    user.must_change_password = False
    user.token_version += 1          # signs out every other session
    audit(db, request, user, "password.changed")
    out = _finish(response, db, user)
    db.commit()
    return out


@router.post("/2fa/setup")
def twofa_setup(user: User = Depends(setup_user), db: Session = Depends(get_db)):
    if user.totp_enabled:
        raise HTTPException(400, "Two-factor authentication is already enabled.")
    secret = security.new_totp_secret()
    user.totp_secret_enc = security.encrypt(secret)
    db.commit()
    return {"secret": secret, "qr_svg": security.qr_svg(security.totp_uri(secret, user.email))}


@router.post("/2fa/enable")
def twofa_enable(body: CodeIn, request: Request, response: Response,
                 user: User = Depends(setup_user), db: Session = Depends(get_db)):
    if user.totp_enabled or not user.totp_secret_enc:
        raise HTTPException(400, "Start two-factor setup first.")
    counter = security.verify_totp(security.decrypt(user.totp_secret_enc), body.code)
    if counter is None:
        raise HTTPException(400, "That code is not valid. Check your device's clock and try the current code.")
    codes, hashes = security.new_recovery_codes()
    user.totp_enabled, user.totp_last_counter, user.recovery_codes = True, counter, hashes
    audit(db, request, user, "2fa.enabled")
    out = _finish(response, db, user)
    db.commit()
    return {**out, "recovery_codes": codes}


@router.post("/2fa/disable")
def twofa_disable(body: DisableIn, request: Request, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    if get_settings(db)["enforce_2fa"]:
        raise HTTPException(400, "Your organisation requires two-factor authentication.")
    if not user.totp_enabled:
        raise HTTPException(400, "Two-factor authentication is not enabled.")
    if not security.verify_password(body.password, user.password_hash) or \
            security.verify_totp(security.decrypt(user.totp_secret_enc), body.code, user.totp_last_counter) is None:
        raise HTTPException(400, "Password or code is incorrect.")
    user.totp_enabled, user.totp_secret_enc, user.recovery_codes = False, None, []
    audit(db, request, user, "2fa.disabled")
    db.commit()
    return {"ok": True}


@router.post("/2fa/recovery-codes")
def regenerate_codes(body: CodeIn, request: Request, user: User = Depends(current_user),
                     db: Session = Depends(get_db)):
    if not user.totp_enabled:
        raise HTTPException(400, "Two-factor authentication is not enabled.")
    counter = security.verify_totp(security.decrypt(user.totp_secret_enc), body.code, user.totp_last_counter)
    if counter is None:
        raise HTTPException(400, "That code is not valid.")
    codes, hashes = security.new_recovery_codes()
    user.recovery_codes, user.totp_last_counter = hashes, counter
    audit(db, request, user, "2fa.recovery_codes_regenerated")
    db.commit()
    return {"recovery_codes": codes}
