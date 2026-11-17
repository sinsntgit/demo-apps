"""The data-source library: databases and uploaded datasets / documents, set up once and used by many ontologies."""
import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .. import datasources as dsrc
from .. import profiling, security, sources
from ..db import get_db
from ..deps import audit, builder_up, current_user, get_ontology, level as onto_level
from ..models import DataSource, DataSourceAccess, DataSourceItem, Job, LLMModel, Ontology, OntologyDataSource, User

router = APIRouter(prefix="/api", tags=["datasources"])


def _summary(db: Session, ds: DataSource, lvl: str) -> dict:
    counts = dict(db.execute(select(DataSourceItem.kind, func.count(DataSourceItem.id)).where(DataSourceItem.data_source_id == ds.id)
                             .group_by(DataSourceItem.kind)).all())
    cfg = dsrc.config(ds) if ds.kind == "database" else {}
    return {"id": ds.id, "name": ds.name, "description": ds.description, "kind": ds.kind, "owner": ds.owner_email, "visibility": ds.visibility,
            "level": lvl, "status": ds.status, "error": ds.error, "notes": ds.notes or [], "tables": counts.get("table", 0),
            "documents": counts.get("document", 0), "documentation": ds.documentation, "sample_values": ds.sample_values, "personal_samples": ds.personal_samples,
            "graph_personal": bool(ds.graph_personal), "keep_files": ds.keep_files is not False, "refreshed_at": ds.refreshed_at.isoformat() if ds.refreshed_at else None,
            "used_by": db.scalar(select(func.count(OntologyDataSource.id)).where(OntologyDataSource.data_source_id == ds.id)),
            "connection": {k: cfg.get(k, "") for k in DB_PUBLIC} | {"has_password": bool(cfg.get("password"))} if cfg else None,
            "db_label": f"{sources.DB_TYPES.get(cfg.get('db_type'), {}).get('label', '')} {cfg.get('database', '')} on {cfg.get('host', '')}".strip() if cfg else ""}


DB_PUBLIC = ("db_type", "host", "port", "database", "user", "schema", "warehouse", "role")


@router.get("/datasources")
def list_sources(user: User = Depends(current_user), db: Session = Depends(get_db)):
    out = []
    for ds in db.scalars(select(DataSource).order_by(DataSource.name)):
        lvl = dsrc.level(db, user, ds)
        if lvl:
            out.append(_summary(db, ds, lvl))
    return {"items": out, "can_create": user.role in ("admin", "ontologist"),
            "db_types": {k: {"label": v["label"], "port": v["port"]} for k, v in sources.DB_TYPES.items()}}


class SourceIn(BaseModel):
    name: str
    description: str = ""
    documentation: str | None = None   # None on update = keep
    kind: str = "files"
    db_type: str = ""
    host: str = ""
    port: int | None = None
    database: str = ""
    user: str = ""
    password: str = ""             # blank on update = keep
    schema_name: str = ""
    warehouse: str = ""            # Snowflake
    role: str = ""                 # Snowflake
    visibility: str = "private"
    sample_values: bool = True
    personal_samples: bool = False
    graph_personal: bool | None = None   # personal columns may be loaded into knowledge graphs; None on update = keep
    keep_files: bool | None = None       # keep a copy of uploaded datasets on the server; None on update = keep


def _apply(ds: DataSource, body: SourceIn, creating: bool):
    from .. import onto
    name = onto.s(body.name, 255)
    if not name:
        raise HTTPException(400, "Give the data source a name.")
    if body.visibility not in ("private", "shared"):
        raise HTTPException(400, "Unknown visibility.")
    ds.name, ds.description, ds.visibility = name, onto.text(body.description, 4000), body.visibility
    if body.documentation is not None:
        ds.documentation = onto.text(body.documentation, 60000)
    ds.sample_values, ds.personal_samples = body.sample_values, body.personal_samples
    if body.graph_personal is not None:
        ds.graph_personal = body.graph_personal
    if body.keep_files is not None:
        ds.keep_files = body.keep_files
    if ds.kind == "database":
        if body.db_type not in sources.DB_TYPES or not body.host.strip() or not body.database.strip():
            raise HTTPException(400, "Choose the database type and enter the host and the database name.")
        old = dsrc.config(ds) if not creating else {}
        cfg = {"db_type": body.db_type, "host": body.host.strip(), "port": body.port, "database": body.database.strip(),
               "user": body.user.strip(), "schema": body.schema_name.strip(), "password": body.password or old.get("password", ""),
               "warehouse": body.warehouse.strip(), "role": body.role.strip()}
        if body.db_type == "snowflake" and not cfg["warehouse"]:
            raise HTTPException(400, "Snowflake needs a warehouse.")
        ds.config_enc = security.encrypt_json(cfg)


@router.post("/datasources")
def create_source(body: SourceIn, request: Request, user: User = Depends(builder_up), db: Session = Depends(get_db)):
    if body.kind not in ("database", "files"):
        raise HTTPException(400, "Unknown kind of data source.")
    ds = DataSource(kind=body.kind, owner_id=user.id, owner_email=user.email, name="")
    _apply(ds, body, True)
    db.add(ds)
    db.flush()
    if ds.kind == "database":
        if not security.limiter.allow(f"dbread:{user.id}", 20, 600):
            raise HTTPException(429, "Too many database reads. Try again in a few minutes.")
        try:
            dsrc.read_database(db, ds)
        except profiling.ProfileError as e:
            db.rollback()
            audit(db, request, user, "datasource.read_failed", body.name, str(e)[:300])
            db.commit()
            raise HTTPException(400, str(e))
    audit(db, request, user, "datasource.created", ds.name, ds.kind)
    db.commit()
    return _summary(db, ds, "manage")


@router.get("/datasources/{dsid}")
def get_source(dsid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ds = dsrc.get(db, user, dsid)
    items = list(db.scalars(select(DataSourceItem).where(DataSourceItem.data_source_id == dsid).order_by(DataSourceItem.kind.desc(), DataSourceItem.name)))
    used = []
    for link in db.scalars(select(OntologyDataSource).where(OntologyDataSource.data_source_id == dsid)):
        o = db.get(Ontology, link.ontology_id)
        if o and onto_level(db, user, o):
            used.append({"id": o.id, "name": o.name})
    return {**_summary(db, ds, ds.my_level), "used_by_list": used,
            "job": _describe_job(db, dsid),
            "items": [{"id": i.id, "kind": i.kind, "name": i.name, "file_name": i.file_name, "size": i.size, "chars": i.chars, "note": i.note,
                       "description": i.description, "ai": i.described_by_ai, "include": i.include, "profile": i.profile,
                       "kept": bool(i.stored) if ds.kind == "files" and i.kind == "table" else None, "updated_at": i.updated_at.isoformat()} for i in items]}


@router.put("/datasources/{dsid}")
def update_source(dsid: int, body: SourceIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ds = dsrc.get(db, user, dsid, "manage")
    before = (ds.sample_values, ds.personal_samples)
    kept_before = ds.keep_files is not False
    _apply(ds, body, False)
    if kept_before and ds.keep_files is False:                    # the copies kept so far are deleted now
        for i in db.scalars(select(DataSourceItem).where(DataSourceItem.data_source_id == ds.id)):
            i.stored = ""
        dsrc.forget_files(db, ds)
    audit(db, request, user, "datasource.updated", ds.name, f"visibility={ds.visibility} samples={ds.sample_values} personal={ds.personal_samples} graph_personal={bool(ds.graph_personal)}")
    db.commit()
    out = _summary(db, ds, ds.my_level)
    out["reread_needed"] = (not before[1]) and ds.personal_samples       # samples of personal columns are only collected on the next read
    return out


class DocIn(BaseModel):
    documentation: str


@router.put("/datasources/{dsid}/documentation")
def set_documentation(dsid: int, body: DocIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    from .. import onto
    ds = dsrc.get(db, user, dsid, "manage")
    ds.documentation = onto.text(body.documentation, 60000)
    audit(db, request, user, "datasource.documentation", ds.name, f"{len(ds.documentation):,} characters")
    db.commit()
    return {"ok": True}


@router.post("/datasources/{dsid}/refresh")
def refresh_source(dsid: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ds = dsrc.get(db, user, dsid, "manage")
    if ds.kind != "database":
        raise HTTPException(400, "Uploaded files are re-read when you upload a newer version of them (a file with the same name replaces the earlier one).")
    if not security.limiter.allow(f"dbread:{user.id}", 20, 600):
        raise HTTPException(429, "Too many database reads. Try again in a few minutes.")
    try:
        res = dsrc.read_database(db, ds)
    except profiling.ProfileError as e:
        ds.status, ds.error = "error", str(e)
        audit(db, request, user, "datasource.read_failed", ds.name, str(e)[:300])
        db.commit()
        raise HTTPException(400, str(e))
    audit(db, request, user, "datasource.refreshed", ds.name, f"{len(res['tables'])} tables in {res['seconds']}s")
    db.commit()
    return _summary(db, ds, ds.my_level)


@router.post("/datasources/{dsid}/files")
async def add_files(dsid: int, request: Request, files: list[UploadFile] = File(...), paths: str = Form("[]"),
                    user: User = Depends(current_user), db: Session = Depends(get_db)):
    from .. import onto
    ds = dsrc.get(db, user, dsid, "manage")
    try:
        rel = json.loads(paths)
    except ValueError:
        rel = []
    batch = []
    for n, f in enumerate(files):
        name = onto.s(rel[n] if n < len(rel) and rel[n] else f.filename, 500) or "file"
        if name.rsplit("/", 1)[-1].startswith((".", "~$")):
            continue
        batch.append((name, await f.read()))
    have = db.scalar(select(func.count(DataSourceItem.id)).where(DataSourceItem.data_source_id == dsid))
    if have + len(batch) > 500:
        raise HTTPException(400, "A data source can hold at most 500 tables and documents.")
    added, failed = dsrc.add_files(db, ds, batch)
    audit(db, request, user, "datasource.files_added", ds.name, f"{len(added)} added, {len(failed)} not readable")
    db.commit()
    return {"added": added, "failed": failed}


class ItemIn(BaseModel):
    description: str | None = None
    include: bool | None = None
    columns: dict[str, str] | None = None      # column name -> business description


@router.put("/datasources/{dsid}/items/{iid}")
def update_item(dsid: int, iid: int, body: ItemIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    from .. import onto
    ds = dsrc.get(db, user, dsid, "manage")
    i = db.get(DataSourceItem, iid)
    if not i or i.data_source_id != dsid:
        raise HTTPException(404, "Not found")
    if body.description is not None:
        if onto.text(body.description, 2000) != i.description:
            i.described_by_ai = False                   # a person has now written or confirmed it
        i.description = onto.text(body.description, 2000)
    if body.include is not None:
        i.include = body.include
    if body.columns and i.profile:
        p = json.loads(json.dumps(i.profile))
        for c in p["columns"]:
            if c["name"] in body.columns:
                new = onto.text(body.columns[c["name"]], 1000)
                if new != c.get("description", ""):
                    c.pop("ai", None)
                c["description"] = new
        i.profile = p
    audit(db, request, user, "datasource.item_updated", ds.name, i.name)
    db.commit()
    return {"ok": True}


@router.get("/datasources/{dsid}/items/{iid}")
def item_text(dsid: int, iid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    dsrc.get(db, user, dsid)
    i = db.get(DataSourceItem, iid)
    if not i or i.data_source_id != dsid:
        raise HTTPException(404, "Not found")
    return {"name": i.name, "kind": i.kind, "note": i.note, "text": i.text[:60000], "truncated": len(i.text) > 60000}


@router.delete("/datasources/{dsid}/items/{iid}")
def delete_item(dsid: int, iid: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ds = dsrc.get(db, user, dsid, "manage")
    i = db.get(DataSourceItem, iid)
    if not i or i.data_source_id != dsid:
        raise HTTPException(404, "Not found")
    audit(db, request, user, "datasource.item_deleted", ds.name, i.name)
    db.delete(i)
    db.flush()
    dsrc.forget_files(db, ds, [i])
    dsrc.relink(db, ds)
    db.commit()
    return {"ok": True}


@router.delete("/datasources/{dsid}")
def delete_source(dsid: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ds = dsrc.get(db, user, dsid, "manage")
    audit(db, request, user, "datasource.deleted", ds.name)
    db.delete(ds)
    db.commit()
    dsrc.forget_files(db, ds)
    return {"ok": True}


class AccessIn(BaseModel):
    visibility: str = "private"
    users: list[int] = []


@router.get("/datasources/{dsid}/access")
def get_access(dsid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ds = dsrc.get(db, user, dsid, "manage")
    granted = set(db.scalars(select(DataSourceAccess.user_id).where(DataSourceAccess.data_source_id == dsid)))
    return {"visibility": ds.visibility, "owner": ds.owner_email,
            "users": [{"id": u.id, "email": u.email, "name": u.name, "role": u.role, "granted": u.id in granted}
                      for u in db.scalars(select(User).where(User.is_active, User.id != ds.owner_id).order_by(User.email))]}


@router.put("/datasources/{dsid}/access")
def set_access(dsid: int, body: AccessIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    ds = dsrc.get(db, user, dsid, "manage")
    if body.visibility not in ("private", "shared"):
        raise HTTPException(400, "Unknown visibility.")
    ds.visibility = body.visibility
    db.execute(delete(DataSourceAccess).where(DataSourceAccess.data_source_id == dsid))
    names = []
    for uid in set(body.users):
        u = db.get(User, uid)
        if u and u.id != ds.owner_id:
            db.add(DataSourceAccess(data_source_id=dsid, user_id=uid))
            names.append(u.email)
    audit(db, request, user, "datasource.access", ds.name, f"visibility={ds.visibility}; " + ", ".join(sorted(names)))
    db.commit()
    return {"ok": True}


# ---- AI drafts business descriptions from the documentation ------------------------------------------
def _describe_job(db: Session, dsid: int) -> dict | None:
    j = db.scalar(select(Job).where(Job.kind == "describe", Job.data_source_id == dsid).order_by(Job.id.desc()))
    if not j:
        return None
    return {"id": j.id, "status": j.status, "stage": j.stage, "progress": j.progress, "error": j.error, "result": j.result, "model": j.model_label,
            "at": j.created_at.isoformat(), "cost": round(j.cost, 4)}


class DescribeIn(BaseModel):
    model_id: int | None = None
    overwrite: bool = False          # also replace descriptions that are AI drafts (never those written by people)


@router.post("/datasources/{dsid}/describe")
def describe(dsid: int, body: DescribeIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    from .. import builder
    from ..deps import get_settings
    ds = dsrc.get(db, user, dsid, "manage")
    if not db.scalar(select(DataSourceItem.id).where(DataSourceItem.data_source_id == dsid, DataSourceItem.kind == "table").limit(1)):
        raise HTTPException(400, "This data source has no tables to describe yet.")
    running = _describe_job(db, dsid)
    if running and running["status"] in ("queued", "running", "paused"):
        raise HTTPException(409, "The AI is already describing this data source.")
    m = db.get(LLMModel, body.model_id) if body.model_id else db.scalar(select(LLMModel).where(LLMModel.enabled).order_by(LLMModel.is_default.desc()))
    if not m or not m.enabled:
        raise HTTPException(400, "No AI model is available. An administrator must add and enable one under Admin › AI models.")
    if not security.limiter.allow(f"build:{user.id}", int(get_settings(db)["builds_per_hour"]), 3600):
        raise HTTPException(429, "You have reached the hourly limit for AI runs. Try again later, or ask an administrator to raise it.")
    j = Job(kind="describe", ontology_id=None, data_source_id=dsid, ontology_name=f"Data source: {ds.name}"[:255], user_id=user.id, user_email=user.email,
            model_id=m.id, model_label=m.name, params={"data_source_id": dsid, "overwrite": body.overwrite}, stage="Waiting to start")
    db.add(j)
    audit(db, request, user, "datasource.describe", ds.name, f"model={m.name}")
    db.commit()
    builder.start(j.id)
    return _describe_job(db, dsid)


# ---- linking data sources to an ontology -------------------------------------------------------------
@router.get("/ontologies/{oid}/datasources")
def linked(oid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    get_ontology(db, user, oid)
    out = []
    for link in db.scalars(select(OntologyDataSource).where(OntologyDataSource.ontology_id == oid)):
        ds = db.get(DataSource, link.data_source_id)
        if ds:
            lvl = dsrc.level(db, user, ds)
            out.append({**_summary(db, ds, lvl or ""), "can_use": bool(lvl)} if lvl else
                       {"id": ds.id, "name": ds.name, "kind": ds.kind, "can_use": False, "owner": ds.owner_email})
    return out


class LinkIn(BaseModel):
    data_source_id: int


@router.post("/ontologies/{oid}/datasources")
def link(oid: int, body: LinkIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid, "edit")
    ds = dsrc.get(db, user, body.data_source_id)
    if not db.scalar(select(OntologyDataSource.id).where(OntologyDataSource.ontology_id == oid, OntologyDataSource.data_source_id == ds.id)):
        db.add(OntologyDataSource(ontology_id=oid, data_source_id=ds.id))
        audit(db, request, user, "ontology.datasource_linked", o.name, ds.name)
        db.commit()
    return {"ok": True}


@router.delete("/ontologies/{oid}/datasources/{dsid}")
def unlink(oid: int, dsid: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid, "edit")
    db.execute(delete(OntologyDataSource).where(OntologyDataSource.ontology_id == oid, OntologyDataSource.data_source_id == dsid))
    audit(db, request, user, "ontology.datasource_unlinked", o.name, str(dsid))
    db.commit()
    return {"ok": True}
