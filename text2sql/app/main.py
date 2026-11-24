import logging
import os
import shutil
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from . import config, security
from . import connectors as connectors_mod
from .db import Base, SessionLocal, engine
from .models import Connection, LLMModel, TrainingItem, User
from .routers import admin, analytics, auth, chat, combined, companies, connections, graph, reports, training

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
    _per_company_names(insp)
    _first_company()
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


def _per_company_names(insp):
    """Older databases made data-model, group and AI-model names unique for the whole installation.
    Names are now unique per company: rebuild those tables without the old constraint (data kept)."""
    from sqlalchemy import text
    from sqlalchemy.schema import CreateIndex, CreateTable
    for name in ("connections", "user_groups", "llm_models"):
        table = Base.metadata.tables[name]
        old = [u for u in insp.get_unique_constraints(name) if u.get("column_names") == ["name"]]
        old_idx = [i for i in insp.get_indexes(name) if i.get("unique") and i.get("column_names") == ["name"]]
        if engine.dialect.name == "sqlite":     # also UNIQUE written on the column itself (SQLite's automatic indexes)
            with engine.connect() as con:
                for row in con.execute(text(f"PRAGMA index_list({name})")).mappings():
                    cols = [r["name"] for r in con.execute(text(f"PRAGMA index_info('{row['name']}')")).mappings()]
                    if row["unique"] and cols == ["name"]:
                        old.append({"name": row["name"]})
        if not old and not old_idx:
            continue
        log.info("Schema upgrade: names in %s become unique per company", name)
        if engine.dialect.name != "sqlite":         # PostgreSQL & co: drop the constraint, add the per-company one
            with engine.begin() as con:
                for u in old:
                    con.execute(text(f'ALTER TABLE {name} DROP CONSTRAINT IF EXISTS "{u["name"]}"'))
                for i in old_idx:
                    con.execute(text(f'DROP INDEX IF EXISTS "{i["name"]}"'))
                con.execute(text(f'ALTER TABLE {name} ADD CONSTRAINT uq_{name}_company_name UNIQUE (company_id, name)'))
            continue
        cols = ", ".join(c.name for c in table.columns)

        def value(c):           # columns added by an earlier upgrade step are NULL in old rows
            arg = c.default.arg if c.default is not None else None
            if c.nullable or arg is None:
                return c.name
            if callable(arg):
                name_ = getattr(arg, "__name__", "")
                return f"COALESCE({c.name}, '[]')" if name_ == "list" else f"COALESCE({c.name}, '{{}}')" if name_ == "dict" else \
                    f"COALESCE({c.name}, CURRENT_TIMESTAMP)" if name_ == "now" else c.name
            return f"COALESCE({c.name}, {int(arg) if isinstance(arg, bool) else repr(arg)})"
        source = ", ".join(value(c) for c in table.columns)
        ddl = str(CreateTable(table).compile(engine)).replace(f"CREATE TABLE {name} (", f"CREATE TABLE {name}__new (", 1)
        raw = engine.raw_connection()          # SQLite's documented way: copy into a new table, swap names
        try:
            cur = raw.cursor()
            cur.execute("PRAGMA foreign_keys=OFF")
            cur.execute(f"DROP TABLE IF EXISTS {name}__new")
            cur.execute(ddl)
            cur.execute(f"INSERT INTO {name}__new ({cols}) SELECT {source} FROM {name}")
            cur.execute(f"DROP TABLE {name}")
            cur.execute(f"ALTER TABLE {name}__new RENAME TO {name}")
            raw.commit()
            for idx in table.indexes:
                cur.execute(str(CreateIndex(idx).compile(engine)).replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS", 1))
            raw.commit()
            cur.execute("PRAGMA foreign_keys=ON")
        finally:
            raw.close()


def _first_company():
    """Existing installations: everything becomes the first company; existing administrators manage the platform.
    AI models and email senders become platform items shared with that company."""
    from sqlalchemy import text, update
    from .models import AuditLog, Company, EmailLog, EmailSender, QueryRun, Report, UserGroup
    with SessionLocal() as db:
        if db.scalar(select(Company.id).limit(1)) or not db.scalar(select(User.id).limit(1)):
            return
        c = Company(name="Default company", hidden_models=[], hidden_senders=[])
        db.add(c)
        db.flush()
        for model in (User, Connection, Report, UserGroup, AuditLog, EmailLog):
            db.execute(update(model).where(model.company_id.is_(None)).values(company_id=c.id))
        db.execute(update(User).where(User.role == "admin").values(is_platform_admin=True))
        db.execute(update(User).where(User.is_platform_admin.is_(None)).values(is_platform_admin=False))
        db.execute(text("UPDATE query_runs SET company_id = (SELECT company_id FROM connections WHERE connections.id = query_runs.connection_id) WHERE company_id IS NULL"))
        for model in (LLMModel, EmailSender):
            for item in db.scalars(select(model)):
                item.share_all, item.shared_companies = False, [c.id]
        db.commit()
        log.info("Multi-company upgrade: existing data is now company '%s'", c.name)


def bootstrap():
    """Create tables; on first run add the first company, its platform administrator and sample data models."""
    Base.metadata.create_all(engine)
    upgrade_schema()
    from .models import Company
    with SessionLocal() as db:
        if not db.scalar(select(User.id).limit(1)):
            _first_run(db)
        first = db.scalar(select(Company.id).order_by(Company.id).limit(1))
    if first:
        add_samples(first)


def add_samples(company_id: int):
    """The bundled samples a company gets (each once - a deleted sample does not come back): SAP, CRM, and the
    combined SAP + CRM model with its customer-number match confirmed."""
    add_sample_model("sap_training.json", company_id)
    add_sample_model("crm_training.json", company_id)
    add_combined_sample(company_id)


COMBINED_SAMPLE = "Sample: SAP + CRM"


def add_combined_sample(company_id: int):
    """A ready-made combined data model of the SAP and CRM samples. The match CRM accounts.sap_no = SAP kna1.KUNNR is
    confirmed with the 'strip leading zeros' rule; other suggestions are left for a steward to look at."""
    from .db import now
    from .models import CombinedMember, GraphEdge, Setting
    flag = _sample_flag("combined_sap_crm", company_id)
    with SessionLocal() as db:
        if db.get(Setting, flag):
            return
        by_name = {c.name: c for c in db.scalars(select(Connection).where(Connection.company_id == company_id))}
        sap, crm = by_name.get("Sample: SAP Sales & Finance"), by_name.get("Sample: CRM")
        if COMBINED_SAMPLE in by_name or not sap or not crm or not sap.schema_json or not crm.schema_json:
            if COMBINED_SAMPLE in by_name or (sap is None and crm is None):
                db.add(Setting(key=flag, value={"v": True}))
                db.commit()
            return
        comb = Connection(company_id=company_id, name=COMBINED_SAMPLE, db_type="combined", config_enc=security.encrypt_json({"overlap_check": True}),
                          description="The SAP sample and the CRM sample together: CRM accounts are SAP customers, matched on the customer number "
                                      "with SAP's leading zeros removed.")
        db.add(comb)
        db.flush()
        db.add(CombinedMember(company_id=company_id, combined_id=comb.id, member_id=sap.id, alias="sap", position=0))
        db.add(CombinedMember(company_id=company_id, combined_id=comb.id, member_id=crm.id, alias="crm", position=1))
        db.add(GraphEdge(company_id=company_id, left_connection_id=sap.id, left_table="kna1", left_columns=["KUNNR"], right_connection_id=crm.id,
                         right_table="accounts", right_columns=["sap_no"], kind="match", cardinality="1:1", normalisation="strip_zeros",
                         origin="steward", status="confirmed", confidence=1.0, decided_at=now(),
                         evidence=["Confirmed in the bundled sample: CRM keeps the SAP customer number without its leading zeros"]))
        db.add(Setting(key=flag, value={"v": True}))
        db.commit()
        try:                                      # the other suggestions, from names and descriptions only
            from . import config as cfgmod, matching
            matching.find(db, comb, None, {**cfgmod.DEFAULT_SETTINGS}, check_values=False)
            db.commit()
        except Exception as e:                    # a convenience, never a start-up blocker
            log.warning("Suggestions for the combined sample could not be made: %s", e)
            db.rollback()
        log.info("Added the combined sample to company #%s", company_id)


def _sample_flag(spec_file: str, company_id: int) -> str:
    """'Already added' marker. The first company keeps the marker of single-company versions."""
    from .models import Company
    with SessionLocal() as db:
        first = db.scalar(select(Company.id).order_by(Company.id).limit(1))
    return "sample_added:" + spec_file + ("" if company_id == first else f":{company_id}")


def add_sample_model(spec_file: str, company_id: int):
    """Add a bundled sample data model with its training to one company - once, so a sample the
    company's admin deleted does not come back. Runs on new and on existing installations (after an update)."""
    import json
    from .db import now
    from .models import Setting
    spec_path = config.BASE_DIR / "sample_data" / spec_file
    flag = _sample_flag(spec_file, company_id)
    if not spec_path.is_file():
        return
    with SessionLocal() as db:
        if db.get(Setting, flag):
            return
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        folder = config.BASE_DIR / "sample_data" / spec["folder"]
        if db.scalar(select(Connection.id).where(Connection.name == spec["name"], Connection.company_id == company_id)) or not folder.is_dir():
            db.add(Setting(key=flag, value={"v": True}))
            db.commit()
            return
        conn = Connection(name=spec["name"], db_type="files", description=spec["description"], config_enc=security.encrypt_json({}),
                          company_id=company_id)
        db.add(conn)
        db.flush()
        dest = config.FILES_DIR / str(conn.id)
        connectors_mod.clear_managed_folder(conn.id)
        dest.mkdir(parents=True, exist_ok=True)
        for f in folder.glob("*.csv"):
            shutil.copy(f, dest / f.name)
        from . import connectors
        try:
            conn.schema_json = connectors.introspect(conn, {})
            conn.schema_synced_at = now()
        except Exception as e:      # sample data is a convenience, never a startup blocker
            log.warning("Sample data model %s could not be loaded: %s", spec["name"], e)
        for d in spec.get("dictionary", []):        # field meanings: always sent with the schema
            db.add(TrainingItem(connection_id=conn.id, kind="ddl", title=d["title"], content=d["content"]))
        for d in spec.get("documentation", []):
            db.add(TrainingItem(connection_id=conn.id, kind="documentation", title=d["title"], content=d["content"]))
        for e in spec.get("examples", []):
            db.add(TrainingItem(connection_id=conn.id, kind="sql_pair", question=e["question"], sql=e["sql"],
                                content=json.dumps(e["analysis"]) if e.get("analysis") else ""))
        db.add(Setting(key=flag, value={"v": True}))
        db.commit()
        log.info("Added sample data model %s to company #%s", spec["name"], company_id)


def add_retail_sample(db, company_id: int):
    """The small retail sample (CSV files) with a little training, for one company."""
    sample = config.BASE_DIR / "sample_data" / "retail"
    if not sample.is_dir() or db.scalar(select(Connection.id).where(Connection.name == "Sample: Retail sales",
                                                                    Connection.company_id == company_id)):
        return
    conn = Connection(name="Sample: Retail sales", db_type="files", company_id=company_id,
                      description="Demo data model built from CSV files (customers, products, orders).",
                      config_enc=security.encrypt_json({}))
    db.add(conn)
    db.flush()
    dest = config.FILES_DIR / str(conn.id)
    connectors_mod.clear_managed_folder(conn.id)
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


def _first_run(db):
    """First start: the first company, its administrator (who also manages the platform), a placeholder
    AI model shared with that company, and the retail sample data model."""
    from .models import Company
    company = Company(name="Default company", hidden_models=[], hidden_senders=[])
    db.add(company)
    db.flush()
    password = config.ADMIN_PASSWORD or security.random_password()
    db.add(User(email=config.ADMIN_EMAIL.lower(), name="Administrator", role="admin", company_id=company.id,
                is_platform_admin=True, password_hash=security.hash_password(password),
                must_change_password=not config.ADMIN_PASSWORD))
    if not config.ADMIN_PASSWORD:
        banner = f"\n{'=' * 64}\n First-run admin account\n   email:    {config.ADMIN_EMAIL}\n" \
                 f"   password: {password}\n (you will be asked to change it at first sign-in)\n{'=' * 64}"
        print(banner, flush=True)
    db.add(LLMModel(name="Claude Opus 5.5", provider="anthropic", model_id="claude-opus-5-5", shared_companies=[company.id],
                    enabled=False, is_default=True, price_in=4.0, price_out=20.0))
    add_retail_sample(db, company.id)
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


for r in (auth.router, connections.router, training.router, chat.router, admin.router, analytics.router, reports.router, graph.router,
          combined.router,
          companies.router):
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
