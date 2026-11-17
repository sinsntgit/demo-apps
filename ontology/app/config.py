"""Runtime configuration, read from environment variables."""
import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("ONTO_DATA_DIR", BASE_DIR / "data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Metadata store. SQLite by default; point at Postgres for multi-instance deployments.
DATABASE_URL = os.environ.get("ONTO_DATABASE_URL", f"sqlite:///{DATA_DIR / 'ontostudio.db'}")

APP_NAME = os.environ.get("ONTO_APP_NAME", "OntoStudio")
VERSION = "1.4"
COOKIE_NAME = "onto_session"
COOKIE_SECURE = os.environ.get("ONTO_COOKIE_SECURE", "0") == "1"   # set to 1 behind HTTPS

ADMIN_EMAIL = os.environ.get("ONTO_ADMIN_EMAIL", "admin@example.com")
ADMIN_PASSWORD = os.environ.get("ONTO_ADMIN_PASSWORD")             # generated if unset


def _load_secret() -> str:
    """Master secret: signs sessions and encrypts stored API keys."""
    env = os.environ.get("ONTO_SECRET_KEY")
    if env:
        return env
    path = DATA_DIR / ".secret"
    if path.exists():
        return path.read_text().strip()
    value = secrets.token_urlsafe(48)
    path.write_text(value)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return value


SECRET_KEY = _load_secret()

DEFAULT_SETTINGS = {
    "enforce_2fa": False,          # every user must enrol in 2FA before using the app
    "session_hours": 12,
    "lockout_attempts": 5,
    "lockout_minutes": 15,
    "builds_per_hour": 10,         # AI build / refine runs per user per hour
    "tests_per_min": 10,           # test-bed runs per user per minute
    "max_parallel_jobs": 3,        # AI jobs running at once (others wait in a queue)
    "default_use_cases": 8,        # use cases generated with a new ontology
    "max_classes": 250,            # hard cap on classes in one ontology
    "base_namespace": "https://example.org/ontology/",   # prefix of the IRIs in OWL / Turtle exports
    "share_sample_values": True,   # data sources may send sample values (not only statistics) to the AI model
    # appearance (Admin > Appearance)
    "app_title": "",               # name shown in the menu, sign-in page and documents; blank = ONTO_APP_NAME
    "accent": "blue",              # blue | teal | green | purple | orange | red | slate
    "default_theme": "system",     # system | light | dark - used until a person picks their own
    "login_message": "",           # a line shown on the sign-in page
    "footer_text": "",             # added to the footer of PDF, PowerPoint and Excel exports (e.g. "Confidential")
}
ACCENTS = {"blue": ("#2a78d6", "#5a9cec"), "teal": ("#0e7c86", "#4fc3cc"), "green": ("#1a7f4b", "#58c58a"), "purple": ("#6b3fc4", "#b79cf2"),
           "orange": ("#b3541e", "#f0a26b"), "red": ("#c0362c", "#f0827a"), "slate": ("#3d4a5c", "#a9b6c8")}

# How many classes the builder aims for at each depth.
DEPTHS = {"compact": (15, 25), "standard": (35, 55), "comprehensive": (70, 100)}
