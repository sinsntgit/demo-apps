"""Reusable data sources: access, reading (profiling tables, extracting documents) and the material an
ontology build receives from them."""
import json
import re

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import profiling, security, sources
from .db import now
from .models import DataSource, DataSourceAccess, DataSourceItem, User

DB_FIELDS = ("db_type", "host", "port", "database", "user", "password", "schema")


def level(db: Session, user: User, ds: DataSource) -> str | None:
    """manage (owner, admin) | use | None. Viewers never use data sources: they cannot build."""
    if user.role == "admin" or ds.owner_id == user.id:
        return "manage"
    if user.role == "viewer":
        return None
    if ds.visibility == "shared" or db.scalar(select(DataSourceAccess.id).where(DataSourceAccess.data_source_id == ds.id,
                                                                                 DataSourceAccess.user_id == user.id)):
        return "use"
    return None


def get(db: Session, user: User, dsid: int, need: str = "use") -> DataSource:
    ds = db.get(DataSource, dsid)
    lvl = level(db, user, ds) if ds else None
    if not lvl:
        raise HTTPException(404, "Data source not found")
    if need == "manage" and lvl != "manage":
        raise HTTPException(403, "Only the owner of this data source or an administrator can change it.")
    ds.my_level = lvl
    return ds


def config(ds: DataSource) -> dict:
    return security.decrypt_json(ds.config_enc) if ds.config_enc else {}


def _url(cfg: dict) -> str:
    if cfg.get("db_type") not in sources.DB_TYPES:
        raise profiling.ProfileError("Unknown database type.")
    return sources.db_url(cfg["db_type"], cfg.get("host", ""), cfg.get("port"), cfg.get("database", ""), cfg.get("user", ""), cfg.get("password", ""))


def _keep_descriptions(old: dict | None, new: dict) -> dict:
    """A re-read keeps what people wrote about a table and its columns."""
    if not old:
        return new
    cols = {c["name"]: c for c in old.get("columns", [])}
    for c in new["columns"]:
        if cols.get(c["name"], {}).get("description"):
            c["description"] = cols[c["name"]]["description"]
    return new


def _store_tables(db: Session, ds: DataSource, tables: list, file_name: str = ""):
    existing = {(i.file_name, i.name): i for i in db.scalars(select(DataSourceItem).where(DataSourceItem.data_source_id == ds.id,
                                                                                           DataSourceItem.kind == "table"))}
    seen = set()
    for t in tables:
        key = (file_name, t["name"])
        seen.add(key)
        item = existing.get(key)
        if item:
            item.profile = _keep_descriptions(item.profile, t)
            item.note = _table_note(t)
            item.updated_at = now()
        else:
            db.add(DataSourceItem(data_source_id=ds.id, kind="table", name=t["name"][:500], file_name=file_name, profile=t, note=_table_note(t),
                                  include=not technical(t["name"])))
    if ds.kind == "database":                         # tables that no longer exist in the database go
        for key, item in existing.items():
            if key not in seen:
                db.delete(item)


def technical(name: str) -> bool:
    """Logs, staging, backups and migration bookkeeping are not business concepts: left out by default."""
    return bool(re.search(r"(^|_)(log|logs|audit|tmp|temp|stg|staging|backup|bak|migration|migrations|sysdiagrams?|etl)($|_)", name.lower()))


def _table_note(t: dict) -> str:
    refs = sum(bool(c.get("ref")) for c in t["columns"])
    return f"{t['row_count']:,} rows · {len(t['columns'])} columns" + (f" · {refs} reference(s)" if refs else "") if t.get("row_count") is not None \
        else f"{len(t['columns'])} columns · structure only"


def relink(db: Session, ds: DataSource):
    """Joins between tables of separately uploaded files are inferred again across the whole data source."""
    items = list(db.scalars(select(DataSourceItem).where(DataSourceItem.data_source_id == ds.id, DataSourceItem.kind == "table")))
    profs = [json.loads(json.dumps(i.profile)) for i in items]
    profiling.relink(profs)
    for i, p in zip(items, profs):
        i.profile = p
        i.note = _table_note(p)


def read_database(db: Session, ds: DataSource):
    cfg = config(ds)
    res = profiling.profile_database(_url(cfg), cfg.get("schema") or None, allow_personal=ds.personal_samples)
    _store_tables(db, ds, res["tables"])
    ds.notes, ds.status, ds.error, ds.refreshed_at = res["notes"], "ready", "", now()
    return res


def add_files(db: Session, ds: DataSource, files: list[tuple[str, bytes]]) -> tuple[list, list]:
    """Datasets are profiled (the file itself is not kept); documents are read (the text is kept).
    A file with the same name as an earlier one replaces it."""
    added, failed = [], []
    for name, data in files:
        try:
            if profiling.is_dataset(name, data):
                if len(data) > sources.MAX_FILE:
                    raise profiling.ProfileError("Larger than 25 MB.")
                tables = profiling.profile_file(name, data, allow_personal=ds.personal_samples)
                old = list(db.scalars(select(DataSourceItem).where(DataSourceItem.data_source_id == ds.id, DataSourceItem.file_name == name)))
                keep = {i.name: i for i in old if i.kind == "table"}
                for i in old:
                    if i.kind != "table" or i.name not in {t["name"] for t in tables}:
                        db.delete(i)
                for t in tables:
                    if t["name"] in keep:
                        keep[t["name"]].profile = _keep_descriptions(keep[t["name"]].profile, t)
                        keep[t["name"]].note, keep[t["name"]].size = _table_note(t), len(data)
                    else:
                        db.add(DataSourceItem(data_source_id=ds.id, kind="table", name=t["name"][:500], file_name=name, size=len(data),
                                              profile=t, note=_table_note(t), include=not technical(t["name"])))
                added.append({"name": name, "kind": "dataset", "tables": len(tables), "note": "; ".join(_table_note(t) for t in tables[:3])})
            else:
                kind, text, note = sources.extract(name, data)
                old = db.scalar(select(DataSourceItem).where(DataSourceItem.data_source_id == ds.id, DataSourceItem.kind == "document",
                                                             DataSourceItem.name == name))
                if old:
                    old.text, old.chars, old.size, old.note = text, len(text), len(data), note
                else:
                    db.add(DataSourceItem(data_source_id=ds.id, kind="document", name=name[:500], file_name=name, size=len(data),
                                          chars=len(text), text=text, note=(("database schema script · " if kind == "schema" else "") + note)[:500]))
                added.append({"name": name, "kind": "document", "note": note})
        except (profiling.ProfileError, sources.Unreadable) as e:
            failed.append({"name": name, "reason": str(e)})
    db.flush()
    relink(db, ds)
    ds.status = "ready" if added or ds.status == "ready" else ds.status
    ds.refreshed_at = now()
    return added, failed


def material(db: Session, ds: DataSource, share_samples: bool) -> tuple[str, list]:
    """-> (text describing the included tables, [(name, text)] of the included documents)."""
    items = list(db.scalars(select(DataSourceItem).where(DataSourceItem.data_source_id == ds.id, DataSourceItem.include).order_by(DataSourceItem.id)))
    samples = share_samples and ds.sample_values
    tables = []
    for i in items:
        if i.kind != "table" or not i.profile:
            continue
        p = json.loads(json.dumps(i.profile))
        p["description"] = i.description
        if not ds.personal_samples:                 # samples of personal columns stay out, whatever was stored earlier
            for c in p["columns"]:
                if c["personal"]:
                    c["top"], c["examples"] = [], []
        tables.append(profiling.describe(p, samples))
    head = f"=== DATA SOURCE: {ds.name} ({'database' if ds.kind == 'database' else 'uploaded datasets'}" + \
           (", statistics and sample values" if samples else ", statistics only - no values") + ") ==="
    if ds.description:
        head += f"\n{ds.description}"
    text = head + "\n" + "\n\n".join(tables) if tables else ""
    docs = [(f"{ds.name} / {i.name}", i.text) for i in items if i.kind == "document" and i.text]
    return text, docs
