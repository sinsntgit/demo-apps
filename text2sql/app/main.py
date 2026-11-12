import logging
import os
import shutil
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from . import config, security
from .db import Base, SessionLocal, engine
from .models import Connection, LLMModel, TrainingItem, User
from .routers import admin, analytics, auth, chat, connections, reports, training

log = logging.getLogger("text2sql")
STATIC = config.BASE_DIR / "static"


def upgrade_schema():
    """Lightweight upgrade step: add columns that newer versions introduced to existing tables,
    and carry settings forward. New tables are handled by create_all."""
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    with engine.begin() as con:
        for table in Base.metadata.sorted_tables:
            have = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name not in have:
                    ddl = f'ALTER TABLE {table.name} ADD COLUMN {col.name} {col.type.compile(engine.dialect)}'
                    con.execute(text(ddl))
                    log.info("Schema upgrade: %s", ddl)
    with SessionLocal() as db:      # the single SMTP setting of earlier versions becomes an email sender
        from .deps import get_settings
        from .models import EmailSender
        cfg = get_settings(db)
        if cfg.get("smtp_host") and cfg.get("smtp_from") and not db.scalar(select(EmailSender.id).limit(1)):
            db.add(EmailSender(label="Default sender", from_email=cfg["smtp_from"], host=cfg["smtp_host"],
                               port=int(cfg.get("smtp_port") or 587), secure=cfg.get("smtp_security") == "ssl",
                               username=cfg.get("smtp_user") or "", password_enc=cfg.get("smtp_password") or "",
                               is_default=True))
            db.commit()


def bootstrap():
    """Create tables; on first run add the admin user and a ready-to-try sample data model."""
    Base.metadata.create_all(engine)
    upgrade_schema()
    with SessionLocal() as db:
        if db.scalar(select(User.id).limit(1)):
            return
        password = config.ADMIN_PASSWORD or security.random_password()
        db.add(User(email=config.ADMIN_EMAIL.lower(), name="Administrator", role="admin",
                    password_hash=security.hash_password(password),
                    must_change_password=not config.ADMIN_PASSWORD))
        if not config.ADMIN_PASSWORD:
            banner = f"\n{'=' * 64}\n First-run admin account\n   email:    {config.ADMIN_EMAIL}\n" \
                     f"   password: {password}\n (you will be asked to change it at first sign-in)\n{'=' * 64}"
            print(banner, flush=True)
        db.add(LLMModel(name="Claude Opus 5.5", provider="anthropic", model_id="claude-opus-5-5",
                        enabled=False, is_default=True, price_in=4.0, price_out=20.0))
        sample = config.BASE_DIR / "sample_data" / "retail"
        if sample.is_dir():
            conn = Connection(name="Sample: Retail sales", db_type="files",
                              description="Demo data model built from CSV files (customers, products, orders).",
                              config_enc=security.encrypt_json({}))
            db.add(conn)
            db.flush()
            dest = config.FILES_DIR / str(conn.id)
            dest.mkdir(parents=True, exist_ok=True)
            for f in sample.glob("*.csv"):
                shutil.copy(f, dest / f.name)
            from . import connectors
            try:
                conn.schema_json = connectors.introspect(conn, {})
                from .db import now
                conn.schema_synced_at = now()
            except Exception as e:      # sample data is a convenience, never a startup blocker
                log.warning("Sample data model could not be loaded: %s", e)
            db.add(TrainingItem(connection_id=conn.id, kind="documentation", title="Revenue definition",
                                content="Revenue (also called sales) = quantity * unit_price * (1 - discount) on "
                                        "order_items, counting only orders whose status is 'completed'. "
                                        "An order's month is taken from orders.order_date."))
            db.add(TrainingItem(connection_id=conn.id, kind="sql_pair", question="What is total revenue by product category?",
                                sql="SELECT p.category, ROUND(SUM(oi.quantity * oi.unit_price * (1 - oi.discount)), 2) AS revenue\n"
                                    "FROM order_items oi\nJOIN orders o ON o.order_id = oi.order_id\n"
                                    "JOIN products p ON p.product_id = oi.product_id\n"
                                    "WHERE o.status = 'completed'\nGROUP BY p.category\nORDER BY revenue DESC"))
        db.commit()


@asynccontextmanager
async def lifespan(_: FastAPI):
    bootstrap()
    stop = None
    if os.environ.get("T2S_SCHEDULER", "1") == "1":      # set to 0 on extra instances if you prefer one scheduler
        from . import reporting
        stop = reporting.start_scheduler()
    yield
    if stop:
        stop.set()


app = FastAPI(title=f"{config.APP_NAME} - Text-to-SQL platform", lifespan=lifespan, docs_url=None,
              openapi_url="/api/openapi.json", redoc_url=None)


@app.middleware("http")
async def security_layer(request: Request, call_next):
    # CSRF: state-changing API calls must come from our own front end (custom header cannot
    # be set cross-site without CORS, which is not enabled) - on top of SameSite=Strict cookies.
    if request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS") \
            and request.headers.get("x-requested-with") != "fetch":
        return JSONResponse({"detail": "Missing X-Requested-With header."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    if config.COOKIE_SECURE:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


for r in (auth.router, connections.router, training.router, chat.router, admin.router, analytics.router, reports.router):
    app.include_router(r)


@app.get("/api/health")
def health():
    return {"status": "ok"}


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    if path.startswith("api/"):
        return JSONResponse({"detail": "Not found"}, status_code=404)
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
