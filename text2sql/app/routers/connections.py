import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .. import connectors, security
from ..db import get_db, now
from ..deps import admin_only, audit, can_use, current_user, get_connection, steward_up
from ..models import Connection, ConnectionAccess, TrainingItem, User

router = APIRouter(prefix="/api/connections", tags=["connections"])


class ConnIn(BaseModel):
    name: str
    description: str = ""
    db_type: str
    config: dict = {}
    is_active: bool = True
    restricted: bool = False
    allow_samples: bool = False
    sample_columns: list[str] = []
    masked_columns: list[str] = []


class AccessIn(BaseModel):
    user_ids: list[int]


def _public(c: Connection, db: Session, full: bool) -> dict:
    tables = (c.schema_json or {}).get("tables", [])
    out = {"id": c.id, "name": c.name, "description": c.description, "db_type": c.db_type,
           "db_label": connectors.DB_TYPES[c.db_type]["label"], "is_active": c.is_active,
           "table_count": len(tables),
           "schema_synced_at": c.schema_synced_at.isoformat() if c.schema_synced_at else None}
    if full:
        cfg = security.decrypt_json(c.config_enc)
        out["config"] = {k: ("" if k in connectors.SECRET_FIELDS else v) for k, v in cfg.items()}
        out["has_password"] = bool(cfg.get("password"))
        out.update(restricted=c.restricted, allow_samples=c.allow_samples, sample_columns=c.sample_columns or [],
                   masked_columns=c.masked_columns or [],
                   training_count=db.scalar(select(func.count(TrainingItem.id)).where(
                       TrainingItem.connection_id == c.id, TrainingItem.status == "approved")))
    return out


def _validate(body: ConnIn):
    if body.db_type not in connectors.DB_TYPES:
        raise HTTPException(400, "Unknown database type.")
    if not body.name.strip():
        raise HTTPException(400, "Name is required.")


@router.get("/types")
def types(_: User = Depends(current_user)):
    return connectors.DB_TYPES


@router.get("")
def list_connections(user: User = Depends(current_user), db: Session = Depends(get_db)):
    full = user.role in ("admin", "steward")
    return [_public(c, db, full) for c in db.scalars(select(Connection).order_by(Connection.name))
            if can_use(db, user, c)]


@router.post("")
def create(body: ConnIn, request: Request, user: User = Depends(admin_only), db: Session = Depends(get_db)):
    _validate(body)
    if db.scalar(select(Connection.id).where(Connection.name == body.name.strip())):
        raise HTTPException(400, "A data model with this name already exists.")
    c = Connection(name=body.name.strip(), description=body.description, db_type=body.db_type,
                   config_enc=security.encrypt_json(body.config), is_active=body.is_active,
                   restricted=body.restricted, allow_samples=body.allow_samples,
                   sample_columns=body.sample_columns, masked_columns=body.masked_columns, created_by=user.id)
    db.add(c)
    db.flush()
    audit(db, request, user, "connection.created", c.name, body.db_type)
    db.commit()
    return _public(c, db, True)


@router.put("/{conn_id}")
def update(conn_id: int, body: ConnIn, request: Request, user: User = Depends(admin_only),
           db: Session = Depends(get_db)):
    _validate(body)
    c = db.get(Connection, conn_id)
    if not c:
        raise HTTPException(404, "Not found")
    old = security.decrypt_json(c.config_enc)
    cfg = dict(body.config)
    for k in connectors.SECRET_FIELDS:        # blank secret = keep the stored one
        if not cfg.get(k) and old.get(k):
            cfg[k] = old[k]
    if body.allow_samples and not c.allow_samples:
        audit(db, request, user, "connection.samples_enabled", c.name, ", ".join(body.sample_columns))
    c.name, c.description, c.db_type = body.name.strip(), body.description, body.db_type
    c.config_enc = security.encrypt_json(cfg)
    c.is_active, c.restricted, c.allow_samples = body.is_active, body.restricted, body.allow_samples
    c.sample_columns, c.masked_columns, c.updated_at = body.sample_columns, body.masked_columns, now()
    if not body.allow_samples and c.schema_json:    # purge previously collected sample values
        for t in c.schema_json.get("tables", []):
            for col in t["columns"]:
                col.pop("samples", None)
        c.schema_json = dict(c.schema_json)
    connectors.forget(c.id)
    audit(db, request, user, "connection.updated", c.name)
    db.commit()
    return _public(c, db, True)


@router.delete("/{conn_id}")
def remove(conn_id: int, request: Request, user: User = Depends(admin_only), db: Session = Depends(get_db)):
    c = db.get(Connection, conn_id)
    if not c:
        raise HTTPException(404, "Not found")
    connectors.forget(c.id)
    audit(db, request, user, "connection.deleted", c.name)
    db.delete(c)
    db.commit()
    return {"ok": True}


@router.post("/{conn_id}/test")
def test(conn_id: int, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    c = get_connection(db, user, conn_id)
    try:
        return {"ok": True, "message": connectors.test(c, security.decrypt_json(c.config_enc))}
    except connectors.ConnectorError as e:
        return {"ok": False, "message": str(e)}


@router.post("/{conn_id}/sync")
def sync_schema(conn_id: int, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    c = get_connection(db, user, conn_id)
    try:
        schema = connectors.introspect(c, security.decrypt_json(c.config_enc))
    except connectors.ConnectorError as e:
        raise HTTPException(400, f"Could not read the schema: {e}")
    c.schema_json, c.schema_synced_at = schema, now()
    audit(db, request, user, "connection.schema_synced", c.name, f"{len(schema['tables'])} tables")
    db.commit()
    return {"tables": len(schema["tables"]), "columns": sum(len(t["columns"]) for t in schema["tables"])}


@router.get("/{conn_id}/schema")
def schema(conn_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = get_connection(db, user, conn_id)
    tables = (c.schema_json or {}).get("tables", [])
    return {"synced_at": c.schema_synced_at.isoformat() if c.schema_synced_at else None,
            "tables": [{**t, "fqn": connectors.table_fqn(t), "ddl": connectors.table_ddl(t)} for t in tables]}


@router.get("/{conn_id}/access")
def get_access(conn_id: int, _: User = Depends(admin_only), db: Session = Depends(get_db)):
    return {"user_ids": list(db.scalars(select(ConnectionAccess.user_id).where(
        ConnectionAccess.connection_id == conn_id)))}


@router.put("/{conn_id}/access")
def set_access(conn_id: int, body: AccessIn, request: Request, user: User = Depends(admin_only),
               db: Session = Depends(get_db)):
    c = db.get(Connection, conn_id)
    if not c:
        raise HTTPException(404, "Not found")
    db.execute(delete(ConnectionAccess).where(ConnectionAccess.connection_id == conn_id))
    for uid in set(body.user_ids):
        db.add(ConnectionAccess(connection_id=conn_id, user_id=uid))
    audit(db, request, user, "connection.access_changed", c.name, f"{len(set(body.user_ids))} users")
    db.commit()
    return {"ok": True}


# ---- files for Excel / CSV data models ------------------------------------------------
def _files_conn(db, user, conn_id) -> tuple[Connection, dict]:
    c = get_connection(db, user, conn_id)
    if c.db_type != "files":
        raise HTTPException(400, "This data model is not a file folder.")
    return c, security.decrypt_json(c.config_enc)


@router.get("/{conn_id}/files")
def files(conn_id: int, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    c, cfg = _files_conn(db, user, conn_id)
    return {"folder": str(connectors.files_folder(c.id, cfg)), "files": connectors.list_files(c.id, cfg)}


@router.post("/{conn_id}/files")
async def upload_files(conn_id: int, request: Request, uploads: list[UploadFile] = File(...),
                       user: User = Depends(steward_up), db: Session = Depends(get_db)):
    c, cfg = _files_conn(db, user, conn_id)
    folder = connectors.files_folder(c.id, cfg)
    folder.mkdir(parents=True, exist_ok=True)
    saved = []
    for up in uploads:
        name = re.sub(r"[^\w.\- ]", "_", Path(up.filename or "file").name)
        if Path(name).suffix.lower() not in connectors.FILE_EXT:
            raise HTTPException(400, f"{name}: only CSV, TSV, Excel and Parquet files are supported.")
        data = await up.read()
        if len(data) > 200 * 1024 * 1024:
            raise HTTPException(400, f"{name}: file is larger than 200 MB.")
        (folder / name).write_bytes(data)
        saved.append(name)
    audit(db, request, user, "connection.files_uploaded", c.name, ", ".join(saved))
    db.commit()
    return {"saved": saved}


@router.delete("/{conn_id}/files/{name}")
def delete_file(conn_id: int, name: str, request: Request, user: User = Depends(steward_up),
                db: Session = Depends(get_db)):
    c, cfg = _files_conn(db, user, conn_id)
    path = connectors.files_folder(c.id, cfg) / Path(name).name
    if not path.is_file():
        raise HTTPException(404, "File not found")
    path.unlink()
    audit(db, request, user, "connection.file_deleted", c.name, name)
    db.commit()
    return {"ok": True}
