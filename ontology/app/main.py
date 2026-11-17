import logging

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from . import builder, config, onto, sample, security
from .db import Base, SessionLocal, engine
from .models import LLMModel, Ontology, User
from .routers import admin, auth, datasources, ontologies

log = logging.getLogger("ontostudio")
STATIC = config.BASE_DIR / "static"


def upgrade_schema():
    """Lightweight upgrade step: add columns that newer versions introduced to existing tables.
    New tables are handled by create_all. Never rename or drop a column - add a new one."""
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


def bootstrap():
    """Create tables; on first run add the admin user, a model entry to fill in, and a sample ontology."""
    Base.metadata.create_all(engine)
    upgrade_schema()
    builder.recover()
    with SessionLocal() as db:
        if db.scalar(select(User.id).limit(1)):
            return
        password = config.ADMIN_PASSWORD or security.random_password()
        admin_user = User(email=config.ADMIN_EMAIL.lower(), name="Administrator", role="admin",
                          password_hash=security.hash_password(password), must_change_password=not config.ADMIN_PASSWORD)
        db.add(admin_user)
        db.flush()
        if not config.ADMIN_PASSWORD:
            print(f"\n{'=' * 64}\n First-run admin account\n   email:    {config.ADMIN_EMAIL}\n   password: {password}\n"
                  f" (you will be asked to change it at first sign-in)\n{'=' * 64}", flush=True)
        db.add(LLMModel(name="Claude Opus 5.5", provider="anthropic", model_id="claude-opus-5-5", effort="high",
                        enabled=False, is_default=True, price_in=4.0, price_out=20.0))
        o = Ontology(name=sample.NAME, domain=sample.DOMAIN, scope=sample.SCOPE, owner_id=admin_user.id, owner_email=admin_user.email,
                     visibility="shared", status="ready", model_label="hand-written sample")
        db.add(o)
        db.flush()
        builder.save_version(db, o, sample.content(), "Sample ontology installed with the application", "system")
        db.commit()


@asynccontextmanager
async def lifespan(_: FastAPI):
    bootstrap()
    yield


app = FastAPI(title=f"{config.APP_NAME} - ontology studio", lifespan=lifespan, docs_url=None,
              openapi_url="/api/openapi.json", redoc_url=None)


@app.middleware("http")
async def security_layer(request: Request, call_next):
    # CSRF: state-changing API calls must come from our own front end (a custom header cannot be set
    # cross-site without CORS, which is not enabled) - on top of SameSite=Strict cookies.
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


for r in (auth.router, ontologies.router, datasources.router, admin.router):
    app.include_router(r)


@app.get("/api/health")
def health():
    return {"status": "ok", "version": config.VERSION}


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    if path.startswith("api/"):
        return JSONResponse({"detail": "Not found"}, status_code=404)
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
