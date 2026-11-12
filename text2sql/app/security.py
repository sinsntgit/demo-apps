"""Passwords, sessions, 2FA (TOTP), secret encryption, rate limiting."""
import base64
import hashlib
import hmac
import io
import json
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import timedelta

import bcrypt
import jwt
import pyotp
import qrcode
import qrcode.image.svg
from cryptography.fernet import Fernet, InvalidToken

from . import config
from .db import now

_fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(("enc:" + config.SECRET_KEY).encode()).digest()))
_JWT_KEY = hashlib.sha256(("jwt:" + config.SECRET_KEY).encode()).hexdigest()


# ---- secrets at rest -------------------------------------------------------
def encrypt(text: str) -> str:
    return _fernet.encrypt(text.encode()).decode() if text else ""


def decrypt(token: str) -> str:
    if not token:
        return ""
    try:
        return _fernet.decrypt(token.encode()).decode()
    except InvalidToken:
        raise ValueError("Stored secret cannot be decrypted - was T2S_SECRET_KEY changed?")


def encrypt_json(obj) -> str:
    return encrypt(json.dumps(obj))


def decrypt_json(token: str):
    return json.loads(decrypt(token) or "{}")


# ---- passwords ---------------------------------------------------------------
def password_problem(pw: str) -> str | None:
    if len(pw) < 10:
        return "Password must be at least 10 characters."
    if not (re.search(r"[a-z]", pw) and re.search(r"[A-Z]", pw) and re.search(r"\d", pw)):
        return "Password must contain upper-case, lower-case and a digit."
    return None


def _prehash(pw: str) -> bytes:   # bcrypt only reads 72 bytes
    return base64.b64encode(hashlib.sha256(pw.encode()).digest())


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(_prehash(pw), bcrypt.gensalt(rounds=12)).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_prehash(pw), hashed.encode())
    except ValueError:
        return False


def random_password() -> str:
    return "Tq" + secrets.token_urlsafe(12) + "7a"


# ---- session tokens ------------------------------------------------------------
def make_token(user, scope: str, hours: float) -> str:
    """scope: 'full' | 'setup' (must enrol 2FA / change password) | 'mfa' (password ok, code pending)."""
    payload = {"sub": str(user.id), "scope": scope, "tv": user.token_version,
               "exp": int(time.time() + hours * 3600)}
    return jwt.encode(payload, _JWT_KEY, algorithm="HS256")


def read_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, _JWT_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


# ---- TOTP 2FA --------------------------------------------------------------------
def new_totp_secret() -> str:
    return pyotp.random_base32()


def totp_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=config.APP_NAME)


def qr_svg(data: str) -> str:
    img = qrcode.make(data, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue().decode()


def verify_totp(secret: str, code: str, last_counter: int = 0) -> int | None:
    """Returns the matched time-step counter, or None. Rejects reuse of a code."""
    code = re.sub(r"\s", "", code or "")
    if not re.fullmatch(r"\d{6}", code):
        return None
    totp = pyotp.TOTP(secret)
    current = int(time.time()) // 30
    for counter in (current - 1, current, current + 1):
        if counter > last_counter and hmac.compare_digest(totp.at(counter * 30), code):
            return counter
    return None


def _code_hash(code: str) -> str:
    norm = re.sub(r"[^a-z0-9]", "", code.lower())
    return hmac.new(_JWT_KEY.encode(), norm.encode(), hashlib.sha256).hexdigest()


def new_recovery_codes(n: int = 8) -> tuple[list[str], list[str]]:
    codes = [f"{secrets.token_hex(3)}-{secrets.token_hex(3)}" for _ in range(n)]
    return codes, [_code_hash(c) for c in codes]


def use_recovery_code(hashes: list[str], code: str) -> list[str] | None:
    """Returns the remaining hashes if the code was valid, else None."""
    h = _code_hash(code or "")
    if h in hashes:
        return [x for x in hashes if x != h]
    return None


# ---- lockout & rate limiting -------------------------------------------------------
def is_locked(user) -> bool:
    return bool(user.locked_until and user.locked_until > now())


def register_failure(user, max_attempts: int, minutes: int):
    user.failed_attempts = (user.failed_attempts or 0) + 1
    if user.failed_attempts >= max_attempts:
        user.locked_until = now() + timedelta(minutes=minutes)
        user.failed_attempts = 0


class RateLimiter:
    """Sliding-window limiter, in memory (per process)."""

    def __init__(self):
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window_s: int = 60) -> bool:
        t = time.time()
        with self._lock:
            q = self._hits[key]
            while q and q[0] < t - window_s:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(t)
            return True


limiter = RateLimiter()
