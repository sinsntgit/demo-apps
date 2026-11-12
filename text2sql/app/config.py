"""Runtime configuration, read from environment variables."""
import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("T2S_DATA_DIR", BASE_DIR / "data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)
FILES_DIR = DATA_DIR / "files"          # managed folders for Excel/CSV connections
FILES_DIR.mkdir(parents=True, exist_ok=True)

# Metadata store (users, connections, training, history). SQLite by default;
# point at Postgres for multi-instance deployments.
DATABASE_URL = os.environ.get("T2S_DATABASE_URL", f"sqlite:///{DATA_DIR / 'text2sql.db'}")

APP_NAME = os.environ.get("T2S_APP_NAME", "AskData")
COOKIE_NAME = "t2s_session"
COOKIE_SECURE = os.environ.get("T2S_COOKIE_SECURE", "0") == "1"   # set to 1 behind HTTPS

ADMIN_EMAIL = os.environ.get("T2S_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ.get("T2S_ADMIN_PASSWORD")             # generated if unset


def _load_secret() -> str:
    """Master secret: signs sessions and encrypts stored credentials."""
    env = os.environ.get("T2S_SECRET_KEY")
    if env:
        return env
    path = DATA_DIR / ".secret"
    if path.exists():
        return path.read_text().strip()
    value = secrets.token_urlsafe(48)
    path.write_text(value)
    path.chmod(0o600)
    return value


SECRET_KEY = _load_secret()

DEFAULT_SETTINGS = {
    "enforce_2fa": False,          # every user must enrol in 2FA before using the app
    "max_rows": 1000,              # rows fetched per query
    "query_timeout_s": 60,
    "feedback_mode": "approval",   # 'approval' | 'instant' for ordinary users
    "rate_limit_per_min": 20,      # questions per user per minute
    "session_hours": 12,
    "max_repair_attempts": 2,      # automatic SQL fix-ups after a database error
    "store_results": True,         # keep result snapshots in chat history
    "lockout_attempts": 5,
    "lockout_minutes": 15,
    # outgoing email, for scheduled reports
    "smtp_host": "",
    "smtp_port": 587,
    "smtp_security": "starttls",   # starttls | ssl | none
    "smtp_user": "",
    "smtp_password": "",           # stored encrypted
    "smtp_from": "",
    "public_url": "",              # e.g. https://askdata.yourcompany.com - used for links in emails
}
REPORTS_DIR = DATA_DIR / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)
