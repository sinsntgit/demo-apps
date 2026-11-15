"""The library (folders, ontologies), source material, AI jobs, manual editing, diagrams, versions,
exports, the test bed and the reasoner. Access is checked on every route through deps.get_ontology /
deps.get_folder; the browser only hides what the server would refuse anyway."""
import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .. import builder, exports, layout, onto, reasoner, render, security, sources
from .. import library as prebuilt
from ..db import get_db, now
from ..deps import RANK, audit, builder_up, current_user, folder_level, get_folder, get_ontology, get_settings, level
from ..models import Folder, FolderAccess, Job, LLMModel, Ontology, OntologyVersion, Source, TestRun, User

router = APIRouter(prefix="/api", tags=["ontologies"])


# ---- models for the pickers ------------------------------------------------------------------
@router.get("/models")
def models(_: User = Depends(current_user), db: Session = Depends(get_db)):
    return [{"id": m.id, "name": m.name, "is_default": m.is_default}
            for m in db.scalars(select(LLMModel).where(LLMModel.enabled).order_by(LLMModel.is_default.desc(), LLMModel.name))]


def _model(db: Session, model_id: int | None) -> LLMModel:
    m = db.get(LLMModel, model_id) if model_id else db.scalar(select(LLMModel).where(LLMModel.enabled).order_by(LLMModel.is_default.desc()))
    if not m or not m.enabled:
        raise HTTPException(400, "No AI model is available. An administrator must add and enable one under Admin › AI models.")
    return m


# ---- AI usage --------------------------------------------------------------------------------
@router.get("/usage")
def usage(days: int = 30, user_id: int = 0, model: str = "", kind: str = "", user: User = Depends(current_user), db: Session = Depends(get_db)):
    """AI usage: jobs, model calls, tokens and estimated cost. Everyone sees their own; an administrator
    sees every user and can filter. The restriction is applied here, not in the browser."""
    from datetime import timedelta
    days = max(1, min(days, 366))
    since = now() - timedelta(days=days)
    q = select(Job).where(Job.created_at >= since)
    if user.role != "admin":
        q = q.where(Job.user_id == user.id)
    elif user_id:
        q = q.where(Job.user_id == user_id)
    rows = list(db.scalars(q.order_by(Job.id.desc())))
    models_seen = sorted({j.model_label for j in rows if j.model_label})
    kinds_seen = sorted({j.kind for j in rows})
    if model:
        rows = [j for j in rows if j.model_label == model]
    if kind:
        rows = [j for j in rows if j.kind == kind]

    def agg(key):
        out: dict = {}
        for j in rows:
            a = out.setdefault(key(j), {"jobs": 0, "calls": 0, "input_tokens": 0, "output_tokens": 0, "cost": 0.0, "failed": 0})
            a["jobs"] += 1; a["calls"] += j.calls; a["input_tokens"] += j.input_tokens; a["output_tokens"] += j.output_tokens
            a["cost"] += j.cost; a["failed"] += j.status == "error"
        return [{"key": k, **{m: (round(v, 4) if m == "cost" else v) for m, v in a.items()}} for k, a in out.items()]

    day = {d["key"]: d for d in agg(lambda j: j.created_at.date().isoformat())}
    series = []
    for i in range(days - 1, -1, -1):
        d = (now() - timedelta(days=i)).date().isoformat()
        series.append(day.get(d) or {"key": d, "jobs": 0, "calls": 0, "input_tokens": 0, "output_tokens": 0, "cost": 0.0, "failed": 0})
    tot = agg(lambda j: "all")
    done = [j for j in rows if j.finished_at]
    out = {"days": days, "is_admin": user.role == "admin",
           "totals": {**(tot[0] if tot else {"jobs": 0, "calls": 0, "input_tokens": 0, "output_tokens": 0, "cost": 0.0, "failed": 0}),
                      "ontologies": len({j.ontology_id for j in rows}), "users": len({j.user_id for j in rows}),
                      "avg_seconds": round(sum((j.finished_at - j.created_at).total_seconds() for j in done) / len(done), 1) if done else 0},
           "by_day": series, "by_kind": sorted(agg(lambda j: j.kind), key=lambda x: -x["cost"]),
           "by_model": sorted(agg(lambda j: j.model_label or "-"), key=lambda x: -x["cost"]),
           "by_ontology": sorted(agg(lambda j: j.ontology_name or "-"), key=lambda x: -x["cost"])[:15],
           "by_user": sorted(agg(lambda j: j.user_email or "-"), key=lambda x: -x["cost"]) if user.role == "admin" else [],
           "models": models_seen, "kinds": kinds_seen,
           "users": [{"id": u.id, "email": u.email} for u in db.scalars(select(User).order_by(User.email))] if user.role == "admin" else [],
           "recent": [{"id": j.id, "at": j.created_at.isoformat(), "user": j.user_email, "kind": j.kind, "ontology": j.ontology_name, "ontology_id": j.ontology_id,
                       "model": j.model_label, "status": j.status, "error": j.error, "calls": j.calls, "input_tokens": j.input_tokens,
                       "output_tokens": j.output_tokens, "cost": round(j.cost, 4),
                       "seconds": int((j.finished_at - j.created_at).total_seconds()) if j.finished_at else None} for j in rows[:100]]}
    return out


@router.get("/usage.csv")
def usage_csv(days: int = 30, user_id: int = 0, user: User = Depends(current_user), db: Session = Depends(get_db)):
    import csv
    import io
    from datetime import timedelta
    q = select(Job).where(Job.created_at >= now() - timedelta(days=max(1, min(days, 366))))
    if user.role != "admin":
        q = q.where(Job.user_id == user.id)
    elif user_id:
        q = q.where(Job.user_id == user_id)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["time_utc", "user", "job", "ontology", "model", "status", "model_calls", "input_tokens", "output_tokens", "estimated_cost_usd", "seconds"])
    for j in db.scalars(q.order_by(Job.id.desc())):
        w.writerow([j.created_at.isoformat(), j.user_email, j.kind, j.ontology_name, j.model_label, j.status, j.calls, j.input_tokens,
                    j.output_tokens, round(j.cost, 4), int((j.finished_at - j.created_at).total_seconds()) if j.finished_at else ""])
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="ai-usage.csv"'})


# ---- library ---------------------------------------------------------------------------------
def _summary(o: Ontology, lvl: str) -> dict:
    st = onto.stats(o.content) if o.content else {}
    return {"id": o.id, "name": o.name, "domain": o.domain, "status": o.status, "version": o.version, "folder_id": o.folder_id,
            "owner": o.owner_email, "visibility": o.visibility, "level": lvl, "model": o.model_label, "depth": o.depth,
            "updated_at": o.updated_at.isoformat(), "classes": st.get("classes", 0), "properties": st.get("object_properties", 0) + st.get("data_properties", 0),
            "use_cases": st.get("use_cases", 0)}


@router.get("/library")
def library(user: User = Depends(current_user), db: Session = Depends(get_db)):
    folders = []
    for f in db.scalars(select(Folder).order_by(Folder.name)):
        lvl = folder_level(db, user, f.id)
        if lvl:
            folders.append({"id": f.id, "name": f.name, "parent_id": f.parent_id, "level": lvl, "owner": f.owner_email, "everyone": f.everyone})
    seen = {f["id"] for f in folders}
    for f in folders:                                 # a folder whose parent is not visible shows at the top level
        if f["parent_id"] not in seen:
            f["parent_id"] = None
    items = []
    for o in db.scalars(select(Ontology).order_by(Ontology.updated_at.desc())):
        lvl = level(db, user, o)
        if lvl:
            s = _summary(o, lvl)
            if s["folder_id"] not in seen:
                s["folder_id"] = None
            items.append(s)
    return {"folders": folders, "ontologies": items, "can_create": user.role in ("admin", "ontologist")}


class FolderIn(BaseModel):
    name: str
    parent_id: int | None = None


def _folder_name(db, name: str, parent_id, skip: int = 0) -> str:
    name = onto.s(name, 120)
    if not name:
        raise HTTPException(400, "Give the folder a name.")
    clash = db.scalar(select(Folder.id).where(func.lower(Folder.name) == name.lower(), Folder.parent_id.is_(parent_id) if parent_id is None
                                              else Folder.parent_id == parent_id, Folder.id != skip))
    if clash:
        raise HTTPException(400, "A folder with this name already exists here.")
    return name


@router.post("/folders")
def create_folder(body: FolderIn, request: Request, user: User = Depends(builder_up), db: Session = Depends(get_db)):
    if body.parent_id:
        get_folder(db, user, body.parent_id, "edit")
    f = Folder(name=_folder_name(db, body.name, body.parent_id), parent_id=body.parent_id, owner_id=user.id, owner_email=user.email)
    db.add(f)
    audit(db, request, user, "folder.created", f.name)
    db.commit()
    return {"id": f.id}


@router.put("/folders/{fid}")
def update_folder(fid: int, body: FolderIn, request: Request, user: User = Depends(builder_up), db: Session = Depends(get_db)):
    f = get_folder(db, user, fid, "manage")
    if body.parent_id != f.parent_id:
        cur = body.parent_id
        while cur:                                    # a folder cannot be moved into itself or its own sub-folders
            if cur == f.id:
                raise HTTPException(400, "A folder cannot be moved inside itself.")
            cur = db.get(Folder, cur).parent_id if db.get(Folder, cur) else None
        if body.parent_id:
            get_folder(db, user, body.parent_id, "edit")
    f.name, f.parent_id = _folder_name(db, body.name, body.parent_id, f.id), body.parent_id
    audit(db, request, user, "folder.updated", f.name)
    db.commit()
    return {"ok": True}


@router.delete("/folders/{fid}")
def delete_folder(fid: int, request: Request, user: User = Depends(builder_up), db: Session = Depends(get_db)):
    f = get_folder(db, user, fid, "manage")
    if db.scalar(select(Ontology.id).where(Ontology.folder_id == fid).limit(1)) or db.scalar(select(Folder.id).where(Folder.parent_id == fid).limit(1)):
        raise HTTPException(400, "This folder is not empty. Move or delete what is inside it first.")
    db.execute(delete(FolderAccess).where(FolderAccess.folder_id == fid))
    audit(db, request, user, "folder.deleted", f.name)
    db.delete(f)
    db.commit()
    return {"ok": True}


class AccessIn(BaseModel):
    everyone: str = ""
    grants: list[dict] = []


@router.get("/folders/{fid}/access")
def folder_access(fid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    f = get_folder(db, user, fid, "manage")
    grants = {a.user_id: a.level for a in db.scalars(select(FolderAccess).where(FolderAccess.folder_id == fid))}
    return {"name": f.name, "owner": f.owner_email, "everyone": f.everyone,
            "inherits_from": db.get(Folder, f.parent_id).name if f.parent_id and db.get(Folder, f.parent_id) else None,
            "users": [{"id": u.id, "email": u.email, "name": u.name, "role": u.role, "level": grants.get(u.id, "")}
                      for u in db.scalars(select(User).where(User.is_active).order_by(User.email)) if u.id != f.owner_id]}


@router.put("/folders/{fid}/access")
def set_folder_access(fid: int, body: AccessIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    f = get_folder(db, user, fid, "manage")
    if body.everyone not in ("", "view", "edit"):
        raise HTTPException(400, "Unknown access level.")
    f.everyone = body.everyone
    db.execute(delete(FolderAccess).where(FolderAccess.folder_id == fid))
    given = []
    for g in body.grants:
        u = db.get(User, int(g.get("user_id") or 0))
        if u and g.get("level") in ("view", "edit") and u.id != f.owner_id:
            db.add(FolderAccess(folder_id=fid, user_id=u.id, level=g["level"]))
            given.append(f"{u.email}={g['level']}")
    audit(db, request, user, "folder.access", f.name, f"everyone={body.everyone or 'none'}; " + ", ".join(given))
    db.commit()
    return {"ok": True}


# ---- ontologies ------------------------------------------------------------------------------
class OntologyIn(BaseModel):
    name: str
    domain: str = ""
    scope: str = ""
    notes: str = ""
    requirements: str = ""
    use_cases: list[str] = []
    depth: str = "standard"
    folder_id: int | None = None
    visibility: str | None = None


def _apply(o: Ontology, body: OntologyIn):
    name = onto.s(body.name, 255)
    if not name:
        raise HTTPException(400, "Give the ontology a name.")
    if body.depth not in ("compact", "standard", "comprehensive"):
        raise HTTPException(400, "Unknown depth.")
    o.name, o.domain, o.scope = name, onto.s(body.domain, 500), onto.text(body.scope, 6000)
    o.notes, o.requirements, o.depth = onto.text(body.notes, 60000), onto.text(body.requirements, 20000), body.depth
    o.seed_use_cases = [onto.s(u, 600) for u in body.use_cases if onto.s(u)][:30]


@router.post("/ontologies")
def create(body: OntologyIn, request: Request, user: User = Depends(builder_up), db: Session = Depends(get_db)):
    if body.folder_id:
        get_folder(db, user, body.folder_id, "edit")
    o = Ontology(owner_id=user.id, owner_email=user.email, folder_id=body.folder_id, status="draft", name="")
    _apply(o, body)
    db.add(o)
    db.flush()
    audit(db, request, user, "ontology.created", o.name)
    db.commit()
    return {"id": o.id}


@router.post("/ontologies/import")
async def import_ontology(request: Request, file: UploadFile = File(...), folder_id: str = Form(""),
                          user: User = Depends(builder_up), db: Session = Depends(get_db)):
    fid = int(folder_id) if folder_id.isdigit() else None
    if fid:
        get_folder(db, user, fid, "edit")
    data = await file.read()
    if len(data) > sources.MAX_FILE:
        raise HTTPException(400, "The file is larger than 25 MB.")
    try:
        raw = exports.import_file(file.filename or "", data)
    except (ValueError, UnicodeDecodeError) as e:
        raise HTTPException(400, str(e) or "The file could not be read.")
    cfg = get_settings(db)
    content = onto.clean(raw, int(cfg["max_classes"]))
    if not content["classes"]:
        raise HTTPException(400, "No classes were found in this file.")
    name = content["meta"]["name"] or (file.filename or "Imported ontology").rsplit(".", 1)[0]
    o = Ontology(name=name[:255], domain=content["meta"]["domain"], scope=content["meta"]["scope"], owner_id=user.id,
                 owner_email=user.email, folder_id=fid, status="ready")
    db.add(o)
    db.flush()
    if not raw.get("meta", {}).get("namespace"):
        content["meta"]["namespace"] = onto.empty(name, "", "", cfg["base_namespace"])["meta"]["namespace"]
    builder.save_version(db, o, content, f"Imported from {file.filename}", user.email, int(cfg["max_classes"]))
    audit(db, request, user, "ontology.imported", o.name, file.filename or "")
    db.commit()
    total = len(raw.get("classes") or [])
    return {"id": o.id, "classes": len(o.content["classes"]), "properties": len(o.content["properties"]),
            "note": (f"{total - len(o.content['classes'])} classes beyond the limit of {cfg['max_classes']} were left out. " if total > len(o.content["classes"]) else "")
            + (f"{len(raw.get('properties') or []) - len(o.content['properties'])} properties without a usable domain or range were left out."
               if len(raw.get("properties") or []) > len(o.content["properties"]) else "")}


# ---- pre-built library and copies --------------------------------------------------------------
def _template(tid: str) -> dict:
    item = prebuilt.load().get(tid)
    if not item:
        raise HTTPException(404, "This ontology is not in the pre-built library.")
    return item


@router.get("/templates")
def templates(_: User = Depends(current_user)):
    items = [prebuilt.summary(i) for i in prebuilt.load().values()]
    return {"items": items, "industries": sorted({i["industry"] for i in items})}


@router.get("/templates/{tid}")
def template(tid: str, _: User = Depends(current_user)):
    item = _template(tid)
    c = item["content"]
    return {**prebuilt.summary(item), "content": c, "stats": onto.stats(c), "quality": onto.quality(c)["score"]}


@router.get("/templates/{tid}/diagram")
def template_diagram(tid: str, view: str = "hierarchy", module: str = "", _: User = Depends(current_user)):
    c = _template(tid)["content"]
    if view == "module" and any(m["id"] == module for m in c["modules"]):
        return layout.module_map(c, module)
    return layout.hierarchy(c, module or None)


def _new_copy(db, user: User, content: dict, name: str, folder_id: int | None, based_on: str, note: str, src: Ontology | None = None) -> Ontology:
    """A new ontology owned by `user`, starting from existing content. Private, in the folder asked for."""
    name = onto.s(name, 255)
    if not name:
        raise HTTPException(400, "Give the ontology a name.")
    if folder_id:
        get_folder(db, user, folder_id, "edit")
    cfg = get_settings(db)
    c = json.loads(json.dumps(content))
    fresh = onto.empty(name, c["meta"]["domain"], c["meta"]["scope"], cfg["base_namespace"])["meta"]
    c["meta"] = {**c["meta"], "name": name, "prefix": fresh["prefix"], "namespace": fresh["namespace"]}     # its own identifiers
    o = Ontology(name=name, domain=c["meta"]["domain"], scope=c["meta"]["scope"], owner_id=user.id, owner_email=user.email, folder_id=folder_id,
                 status="ready", based_on=based_on[:300], model_label=src.model_label if src else "pre-built library",
                 notes=src.notes if src else "", requirements=src.requirements if src else "", depth=src.depth if src else "standard")
    db.add(o)
    db.flush()
    builder.save_version(db, o, c, note, user.email, max(int(cfg["max_classes"]), len(c["classes"])))
    return o


class UseIn(BaseModel):
    name: str
    folder_id: int | None = None
    instruction: str = ""
    model_id: int | None = None


@router.post("/templates/{tid}/use")
def use_template(tid: str, body: UseIn, request: Request, user: User = Depends(builder_up), db: Session = Depends(get_db)):
    """Copy a pre-built ontology into the user's library. With an instruction, an AI refine job tailors it at once."""
    item = _template(tid)
    model = _model(db, body.model_id) if body.instruction.strip() else None       # fail before creating anything
    o = _new_copy(db, user, item["content"], body.name, body.folder_id, f"Pre-built library: {item['name']}",
                  f"Copied from the pre-built library: {item['name']}")
    audit(db, request, user, "ontology.from_library", o.name, item["id"])
    db.commit()
    job = None
    if model:
        job = _job(_launch(db, request, user, o, "refine", model, {"instruction": body.instruction.strip()[:6000]}))
    return {"id": o.id, "job": job}


class CopyIn(BaseModel):
    name: str
    folder_id: int | None = None


@router.post("/ontologies/{oid}/duplicate")
def duplicate(oid: int, body: CopyIn, request: Request, user: User = Depends(builder_up), db: Session = Depends(get_db)):
    """A private copy of an ontology the user can see, to modify without touching the original."""
    src = get_ontology(db, user, oid)
    if not src.content or not src.content["classes"]:
        raise HTTPException(400, "This ontology has nothing to copy yet.")
    o = _new_copy(db, user, src.content, body.name, body.folder_id, f"Copy of {src.name} (version {src.version})",
                  f"Copied from {src.name}, version {src.version}", src)
    for s in db.scalars(select(Source).where(Source.ontology_id == oid)):       # its source material comes along
        db.add(Source(ontology_id=o.id, kind=s.kind, name=s.name, size=s.size, chars=s.chars, text=s.text, note=s.note, added_by=s.added_by))
    o.material, o.seed_use_cases = src.material, list(src.seed_use_cases or [])
    audit(db, request, user, "ontology.duplicated", o.name, f"from {src.name} v{src.version}")
    db.commit()
    return {"id": o.id}


def _active_job(db: Session, oid: int) -> Job | None:
    return db.scalar(select(Job).where(Job.ontology_id == oid, Job.status.in_(("queued", "running")), Job.kind != "test").order_by(Job.id.desc()))


def _job(j: Job) -> dict:
    return {"id": j.id, "kind": j.kind, "status": j.status, "stage": j.stage, "progress": j.progress, "log": j.log, "error": j.error,
            "result": {k: v for k, v in (j.result or {}).items() if k != "proposed"} if j.result else None, "model": j.model_label,
            "calls": j.calls, "input_tokens": j.input_tokens, "output_tokens": j.output_tokens, "cost": round(j.cost, 4),
            "ontology_id": j.ontology_id, "at": j.created_at.isoformat()}


@router.get("/ontologies/{oid}")
def get(oid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid)
    job = _active_job(db, oid)
    last = db.scalar(select(Job).where(Job.ontology_id == oid, Job.kind == "build").order_by(Job.id.desc()))
    srcs = db.execute(select(Source.kind, func.count(Source.id)).where(Source.ontology_id == oid).group_by(Source.kind)).all()
    return {**_summary(o, o.my_level), "scope": o.scope, "notes": o.notes, "requirements": o.requirements, "seed_use_cases": o.seed_use_cases or [],
            "content": o.content, "stats": onto.stats(o.content) if o.content else None,
            "quality": onto.quality(o.content) if o.content else None, "job": _job(job) if job else None,
            "last_build": _job(last) if last and last.status in ("error", "done") else None,
            "sources": {k: n for k, n in srcs}, "reasoners": reasoner.engines(),
            "folder": db.get(Folder, o.folder_id).name if o.folder_id and db.get(Folder, o.folder_id) else None,
            "based_on": o.based_on or ""}


@router.put("/ontologies/{oid}")
def update(oid: int, body: OntologyIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid, "edit")
    if body.folder_id != o.folder_id:
        if o.my_level != "manage":
            raise HTTPException(403, "Only the owner or an administrator can move an ontology.")
        if body.folder_id:
            get_folder(db, user, body.folder_id, "edit")
        o.folder_id = body.folder_id
    if body.visibility is not None and body.visibility != o.visibility:
        if o.my_level != "manage" or body.visibility not in ("private", "shared"):
            raise HTTPException(403, "Only the owner or an administrator can change who sees an ontology.")
        o.visibility = body.visibility
    _apply(o, body)
    if o.content:
        c = json.loads(json.dumps(o.content))
        c["meta"].update(name=o.name, domain=o.domain, scope=o.scope)
        o.content = c
    audit(db, request, user, "ontology.updated", o.name, f"visibility={o.visibility} folder={o.folder_id}")
    db.commit()
    return {"ok": True}


@router.delete("/ontologies/{oid}")
def remove(oid: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid, "manage")
    if _active_job(db, oid):
        raise HTTPException(400, "An AI job is still running on this ontology. Wait for it to finish.")
    audit(db, request, user, "ontology.deleted", o.name)
    db.delete(o)
    db.commit()
    return {"ok": True}


# ---- source material -------------------------------------------------------------------------
def _source(s: Source) -> dict:
    return {"id": s.id, "kind": s.kind, "name": s.name, "size": s.size, "chars": s.chars, "note": s.note,
            "added_by": s.added_by, "at": s.created_at.isoformat()}


@router.get("/ontologies/{oid}/sources")
def list_sources(oid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    get_ontology(db, user, oid)
    return {"items": [_source(s) for s in db.scalars(select(Source).where(Source.ontology_id == oid).order_by(Source.id))],
            "db_types": {k: {"label": v["label"], "port": v["port"]} for k, v in sources.DB_TYPES.items()},
            "extensions": sorted(sources.DOC_EXT)}


@router.post("/ontologies/{oid}/sources")
async def add_sources(oid: int, request: Request, files: list[UploadFile] = File(...), paths: str = Form("[]"),
                      user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Upload documents (or a whole folder of them). Text is extracted and kept; the original file is not."""
    o = get_ontology(db, user, oid, "edit")
    try:
        rel = json.loads(paths)
    except ValueError:
        rel = []
    have = db.scalar(select(func.count(Source.id)).where(Source.ontology_id == oid))
    added, failed = [], []
    for i, f in enumerate(files):
        name = onto.s(rel[i] if i < len(rel) and rel[i] else f.filename, 500) or "file"
        if name.rsplit("/", 1)[-1].startswith((".", "~$")):
            continue                                  # hidden and lock files that come along with a folder
        if have + len(added) >= 300:
            failed.append({"name": name, "reason": "An ontology can hold at most 300 sources."})
            continue
        data = await f.read()
        try:
            kind, text, note = sources.extract(name, data)
        except sources.Unreadable as e:
            failed.append({"name": name, "reason": str(e)})
            continue
        s = Source(ontology_id=oid, kind=kind, name=name, size=len(data), chars=len(text), text=text, note=note, added_by=user.email)
        db.add(s)
        added.append(s)
    audit(db, request, user, "source.added", o.name, f"{len(added)} added, {len(failed)} not readable")
    db.commit()
    return {"added": [_source(s) for s in added], "failed": failed}


class DatabaseIn(BaseModel):
    db_type: str
    host: str
    port: int | None = None
    database: str
    user: str = ""
    password: str = ""
    schema_name: str = ""


@router.post("/ontologies/{oid}/sources/database")
def add_database(oid: int, body: DatabaseIn, request: Request, user: User = Depends(builder_up), db: Session = Depends(get_db)):
    """Read the structure of a live database (tables, columns, keys - never rows). The password is used for
    this one read and is not stored."""
    o = get_ontology(db, user, oid, "edit")
    if body.db_type not in sources.DB_TYPES:
        raise HTTPException(400, "Unknown database type.")
    if not body.host.strip() or not body.database.strip():
        raise HTTPException(400, "Host and database name are required.")
    if not security.limiter.allow(f"dbread:{user.id}", 20, 600):
        raise HTTPException(429, "Too many database reads. Try again in a few minutes.")
    label = f"{sources.DB_TYPES[body.db_type]['label']} {body.database.strip()} on {body.host.strip()}" + (f" (schema {body.schema_name})" if body.schema_name else "")
    try:
        text, note = sources.introspect(sources.db_url(body.db_type, body.host.strip(), body.port, body.database.strip(), body.user, body.password),
                                        body.schema_name.strip() or None)
    except sources.Unreadable as e:
        audit(db, request, user, "source.database_failed", o.name, label)
        db.commit()
        raise HTTPException(400, str(e))
    s = Source(ontology_id=oid, kind="schema", name=label, size=len(text), chars=len(text), text=text[:sources.MAX_CHARS], note=note, added_by=user.email)
    db.add(s)
    audit(db, request, user, "source.database_read", o.name, f"{label}: {note}")
    db.commit()
    return _source(s)


@router.get("/ontologies/{oid}/sources/{sid}")
def source_text(oid: int, sid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    get_ontology(db, user, oid)
    s = db.get(Source, sid)
    if not s or s.ontology_id != oid:
        raise HTTPException(404, "Not found")
    return {**_source(s), "text": s.text[:60000], "truncated": len(s.text) > 60000}


@router.delete("/ontologies/{oid}/sources/{sid}")
def delete_source(oid: int, sid: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid, "edit")
    s = db.get(Source, sid)
    if not s or s.ontology_id != oid:
        raise HTTPException(404, "Not found")
    audit(db, request, user, "source.deleted", o.name, s.name)
    db.delete(s)
    db.commit()
    return {"ok": True}


# ---- AI jobs ---------------------------------------------------------------------------------
class JobIn(BaseModel):
    model_id: int | None = None
    use_cases: int | None = None
    instruction: str = ""
    count: int = 5
    focus: str = ""


def _launch(db, request, user, o: Ontology, kind: str, model: LLMModel, params: dict, limit_key: str = "builds") -> Job:
    cfg = get_settings(db)
    if limit_key == "builds" and not security.limiter.allow(f"build:{user.id}", int(cfg["builds_per_hour"]), 3600):
        raise HTTPException(429, "You have reached the hourly limit for AI runs. Try again later, or ask an administrator to raise it.")
    if limit_key == "tests" and not security.limiter.allow(f"test:{user.id}", int(cfg["tests_per_min"]), 60):
        raise HTTPException(429, "Too many tests in a short time. Wait a minute and try again.")
    if kind != "test" and _active_job(db, o.id):
        raise HTTPException(409, "An AI job is already running on this ontology. Wait for it to finish.")
    j = Job(kind=kind, ontology_id=o.id, ontology_name=o.name, user_id=user.id, user_email=user.email, model_id=model.id,
            model_label=model.name, params=params, stage="Waiting to start")
    db.add(j)
    if kind in ("build", "refine", "explain", "usecases"):
        o.status = "building"
    audit(db, request, user, f"ontology.{kind}", o.name, f"model={model.name}")
    db.commit()
    builder.start(j.id)
    return j


@router.post("/ontologies/{oid}/build")
def build(oid: int, body: JobIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid, "edit")
    has_src = db.scalar(select(Source.id).where(Source.ontology_id == oid).limit(1))
    if not (o.domain.strip() or o.scope.strip() or o.requirements.strip() or o.seed_use_cases or has_src):
        raise HTTPException(400, "Say what the ontology is about first: a domain, use cases, requirements, or source material.")
    n = None if body.use_cases is None else max(0, min(body.use_cases, 15))
    return _job(_launch(db, request, user, o, "build", _model(db, body.model_id), {"use_cases": n}))


@router.post("/ontologies/{oid}/run/{kind}")
def run_job(oid: int, kind: str, body: JobIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if kind not in ("refine", "explain", "usecases", "gaps"):
        raise HTTPException(404, "Not found")
    o = get_ontology(db, user, oid, "edit")
    if not o.content or not o.content["classes"]:
        raise HTTPException(400, "Build the ontology first.")
    if kind == "refine" and len(body.instruction.strip()) < 5:
        raise HTTPException(400, "Describe the change you want.")
    params = {"instruction": body.instruction.strip()[:6000], "count": body.count, "focus": body.focus[:1000]}
    return _job(_launch(db, request, user, o, kind, _model(db, body.model_id), params))


@router.get("/jobs/{jid}")
def job(jid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    j = db.get(Job, jid)
    if not j or not j.ontology_id:
        raise HTTPException(404, "Not found")
    get_ontology(db, user, j.ontology_id)
    return _job(j)


@router.get("/ontologies/{oid}/gaps")
def last_gaps(oid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The most recent AI gap review, with what it proposes."""
    o = get_ontology(db, user, oid)
    j = db.scalar(select(Job).where(Job.ontology_id == oid, Job.kind == "gaps").order_by(Job.id.desc()))
    if not j:
        return {"job": None}
    out = {"job": _job(j)}
    if j.status == "done":
        out["stale"] = j.result.get("on_version") != o.version
    return out


@router.post("/ontologies/{oid}/gaps/{jid}/apply")
def apply_gaps(oid: int, jid: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid, "edit")
    j = db.get(Job, jid)
    if not j or j.ontology_id != oid or j.kind != "gaps" or j.status != "done":
        raise HTTPException(404, "Not found")
    if j.result.get("applied"):
        raise HTTPException(400, "These changes were already applied.")
    if j.result.get("on_version") != o.version:
        raise HTTPException(409, "The ontology has changed since this review. Run the review again.")
    proposed = {**j.result["proposed"], "explanation": o.content["explanation"], "use_cases": o.content["use_cases"], "standards": o.content["standards"]}
    v = builder.save_version(db, o, proposed, f"Applied the AI gap review ({j.model_label})", user.email, int(get_settings(db)["max_classes"]))
    j.result = {**j.result, "applied": True}
    audit(db, request, user, "ontology.gaps_applied", o.name, f"version {v}")
    db.commit()
    return {"version": v}


# ---- manual editing (forms and the diagram editor) -------------------------------------------
class PatchIn(BaseModel):
    patch: dict
    note: str = ""


@router.post("/ontologies/{oid}/edit")
def edit(oid: int, body: PatchIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Add, change or remove elements. Same rules as for anything a model returns: the patch is cleaned,
    dangling references are repaired, and the result is saved as a new version."""
    o = get_ontology(db, user, oid, "edit")
    if _active_job(db, oid):
        raise HTTPException(409, "An AI job is running on this ontology. Wait for it to finish before editing.")
    cfg = get_settings(db)
    base = json.loads(json.dumps(o.content)) if o.content else onto.empty(o.name, o.domain, o.scope, cfg["base_namespace"])
    p = body.patch
    for key, rm in (("individuals", "remove_individuals"), ("rules", "remove_rules"), ("use_cases", "remove_use_cases"), ("modules", "remove_modules")):
        gone = set(onto.strs(p.get(rm), 200, 80))
        if gone:
            base[key] = [x for x in base[key] if x["id"] not in gone]
    removed_c = set(onto.strs(p.get("remove_classes"), 200, 80))
    for k in base["classes"]:                         # children of a removed class move up to its parent
        if k["parent"] in removed_c:
            k["parent"] = next((x["parent"] for x in base["classes"] if x["id"] == k["parent"]), None)
    for u in p.get("use_cases") if isinstance(p.get("use_cases"), list) else []:
        y = onto.clean_use_case(u, len(base["use_cases"]))
        if y:
            if not onto.s(u.get("id")) or not any(x["id"] == y["id"] for x in base["use_cases"]):
                n = 1
                while any(x["id"] == f"UC{n}" for x in base["use_cases"]):
                    n += 1
                y["id"] = f"UC{n}"
                y["source"] = "manual"
                base["use_cases"].append(y)
            else:
                base["use_cases"] = [y if x["id"] == y["id"] else x for x in base["use_cases"]]
    if isinstance(p.get("explanation"), dict):
        base["explanation"] = {**base["explanation"], **p["explanation"]}
    if isinstance(p.get("standards"), list):
        base["standards"] = p["standards"]
    if isinstance(p.get("meta"), dict):
        base["meta"] = {**base["meta"], **{k: v for k, v in p["meta"].items() if k in ("prefix", "namespace")}}
    merged, counts = onto.merge(base, p, int(cfg["max_classes"]))
    have = {k["id"] for k in merged["classes"]}
    if any(isinstance(x, dict) and onto.ident(x.get("id") or x.get("label"), True) not in have for x in (p.get("classes") or [])) \
            and len(merged["classes"]) >= int(cfg["max_classes"]):
        raise HTTPException(400, f"An ontology can hold at most {cfg['max_classes']} classes (an administrator can raise the limit).")
    note = onto.s(body.note, 300) or "Edited"
    v = builder.save_version(db, o, merged, note, user.email, int(cfg["max_classes"]))
    if o.status in ("draft", "failed"):
        o.status = "ready"
    audit(db, request, user, "ontology.edited", o.name, f"v{v}: {note}")
    db.commit()
    return {"version": v, "content": o.content, "stats": onto.stats(o.content), "quality": onto.quality(o.content)}


# ---- diagrams --------------------------------------------------------------------------------
def _content(db, o: Ontology, version: int | None) -> dict:
    if version and version != o.version:
        v = db.scalar(select(OntologyVersion).where(OntologyVersion.ontology_id == o.id, OntologyVersion.number == version))
        if not v:
            raise HTTPException(404, "Version not found")
        return v.content
    if not o.content:
        raise HTTPException(400, "This ontology has not been built yet.")
    return o.content


@router.get("/ontologies/{oid}/diagram")
def diagram(oid: int, view: str = "hierarchy", module: str = "", uc: str = "", cls: str = "", depth: int = 0, version: int = 0,
            user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid)
    c = _content(db, o, version)
    ix = onto.index(c)
    if view == "hierarchy":
        return layout.hierarchy(c, module or None, depth or None)
    if view == "module":
        if not any(m["id"] == module for m in c["modules"]):
            raise HTTPException(404, "Module not found")
        return layout.module_map(c, module)
    if view == "usecase":
        u = next((x for x in c["use_cases"] if x["id"] == uc), None)
        if not u:
            raise HTTPException(404, "Use case not found")
        return layout.use_case(c, u)
    if view == "class":
        if cls not in ix["classes"]:
            raise HTTPException(404, "Class not found")
        line = [cls] + onto.ancestors(ix, cls)
        near = [cls] + [p["range"] for p in c["properties"] if p["kind"] == "object" and p["domain"] in line] + \
               [p["domain"] for p in c["properties"] if p["kind"] == "object" and p["range"] in line] + line[1:2] + ix["children"].get(cls, [])
        return layout.relations(c, list(dict.fromkeys(near))[:24], hit={cls}, focus=set(line))
    raise HTTPException(404, "Unknown view")


# ---- versions --------------------------------------------------------------------------------
@router.get("/ontologies/{oid}/versions")
def versions(oid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    get_ontology(db, user, oid)
    rows = list(db.scalars(select(OntologyVersion).where(OntologyVersion.ontology_id == oid).order_by(OntologyVersion.number.desc())))
    out = []
    for i, v in enumerate(rows):
        prev = rows[i + 1].content if i + 1 < len(rows) else None
        d = None
        if prev:
            a, b = onto.index(prev), onto.index(v.content)
            d = {"classes_added": sorted(set(b["classes"]) - set(a["classes"])), "classes_removed": sorted(set(a["classes"]) - set(b["classes"])),
                 "properties_added": sorted(set(b["props"]) - set(a["props"])), "properties_removed": sorted(set(a["props"]) - set(b["props"])),
                 "changed": sorted([k for k in b["classes"] if k in a["classes"] and b["classes"][k] != a["classes"][k]] +
                                   [k for k in b["props"] if k in a["props"] and b["props"][k] != a["props"][k]])}
        out.append({"number": v.number, "note": v.note, "author": v.author, "at": v.created_at.isoformat(), "stats": v.stats, "diff": d})
    return out


@router.post("/ontologies/{oid}/versions/{n}/restore")
def restore(oid: int, n: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid, "edit")
    if _active_job(db, oid):
        raise HTTPException(409, "An AI job is running on this ontology.")
    v = db.scalar(select(OntologyVersion).where(OntologyVersion.ontology_id == oid, OntologyVersion.number == n))
    if not v:
        raise HTTPException(404, "Version not found")
    new = builder.save_version(db, o, v.content, f"Restored version {n}", user.email, int(get_settings(db)["max_classes"]))
    o.status = "ready"
    audit(db, request, user, "ontology.restored", o.name, f"version {n} -> {new}")
    db.commit()
    return {"version": new}


# ---- exports ---------------------------------------------------------------------------------
def _tests(db, oid: int) -> list:
    """Latest finished test per distinct use case text."""
    seen, out = set(), []
    for t in db.scalars(select(TestRun).where(TestRun.ontology_id == oid, TestRun.status == "done").order_by(TestRun.id.desc())):
        if t.text.strip().lower() not in seen:
            seen.add(t.text.strip().lower())
            out.append(t)
    return out[:20]


@router.get("/ontologies/{oid}/export/{fmt}")
def export(oid: int, fmt: str, request: Request, version: int = 0, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid)
    c = _content(db, o, version)
    if fmt in exports.FORMATS:
        data, media, name = exports.export(c, fmt, version or o.version)
    elif fmt in ("pdf", "pptx", "xlsx"):
        if version and version != o.version:
            raise HTTPException(400, "The handbook, the deck and the workbook are produced for the current version only.")
        tests = _tests(db, oid)
        foot = get_settings(db)["footer_text"]
        data = {"pdf": render.build_pdf, "pptx": render.build_pptx, "xlsx": render.build_xlsx}[fmt](o, c, tests, foot)
        media = {"pdf": "application/pdf", "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                 "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}[fmt]
        name = exports.filename(o.name, fmt)
    else:
        raise HTTPException(404, "Unknown format")
    audit(db, request, user, "ontology.exported", o.name, fmt)
    db.commit()
    return Response(data, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---- test bed --------------------------------------------------------------------------------
class TestIn(BaseModel):
    text: str
    model_id: int | None = None


def _test(t: TestRun, c: dict | None = None, full: bool = False) -> dict:
    out = {"id": t.id, "text": t.text, "status": t.status, "score": t.score, "verdict": t.verdict, "version": t.version, "error": t.error,
           "model": t.model_label, "user": t.user_email, "at": t.created_at.isoformat(), "fixes_applied": t.fixes_applied,
           "title": (t.result or {}).get("title", ""), "counts": (t.result or {}).get("counts")}
    if full and t.result:
        out["result"] = t.result
        try:
            out["diagram"] = layout.test(c, t.result) if c else None
        except (KeyError, StopIteration):               # the ontology has moved on since this run
            out["diagram"] = None
    return out


@router.post("/ontologies/{oid}/tests")
def run_test(oid: int, body: TestIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid)                    # viewers may test: it changes nothing in the ontology
    if not o.content or not o.content["classes"]:
        raise HTTPException(400, "Build the ontology first.")
    text = body.text.strip()
    if len(text) < 10:
        raise HTTPException(400, "Describe the use case in a sentence or two.")
    model = _model(db, body.model_id)
    t = TestRun(ontology_id=oid, version=o.version, user_id=user.id, user_email=user.email, text=text[:8000], model_label=model.name)
    db.add(t)
    db.flush()
    j = _launch(db, request, user, o, "test", model, {"test_run_id": t.id}, "tests")
    return {"job": _job(j), "test": _test(t)}


@router.get("/ontologies/{oid}/tests")
def tests(oid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid)
    rows = list(db.scalars(select(TestRun).where(TestRun.ontology_id == oid).order_by(TestRun.id.desc()).limit(200)))
    latest = _tests(db, oid)
    return {"items": [_test(t) for t in rows], "version": o.version,
            "summary": {"tested": len(latest), "average": round(sum(t.score for t in latest) / len(latest), 3) if latest else None,
                        "addressed": sum(t.verdict == "addressed" for t in latest), "partly": sum(t.verdict == "partly" for t in latest),
                        "not_addressed": sum(t.verdict == "not_addressed" for t in latest)}}


def _get_test(db, oid: int, tid: int) -> TestRun:
    t = db.get(TestRun, tid)
    if not t or t.ontology_id != oid:
        raise HTTPException(404, "Not found")
    return t


@router.get("/ontologies/{oid}/tests/{tid}")
def test_detail(oid: int, tid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid)
    t = _get_test(db, oid, tid)
    c = None
    if t.result:
        try:
            c = _content(db, o, t.version)
        except HTTPException:
            c = None
    return {**_test(t, c, True), "current_version": o.version}


@router.post("/ontologies/{oid}/tests/{tid}/apply")
def apply_fixes(oid: int, tid: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Add the classes and properties a test proposed. They pass through the same cleaning as any edit."""
    o = get_ontology(db, user, oid, "edit")
    t = _get_test(db, oid, tid)
    sug = (t.result or {}).get("suggestions") or {}
    if t.status != "done" or not (sug.get("classes") or sug.get("properties")):
        raise HTTPException(400, "This test proposed no additions.")
    if _active_job(db, oid):
        raise HTTPException(409, "An AI job is running on this ontology.")
    merged, counts = onto.merge(json.loads(json.dumps(o.content)), {"classes": sug.get("classes"), "properties": sug.get("properties")},
                                int(get_settings(db)["max_classes"]))
    v = builder.save_version(db, o, merged, f"Closed gaps found by test: {(t.result.get('title') or t.text)[:120]}", user.email)
    t.fixes_applied = True
    audit(db, request, user, "ontology.test_fixes_applied", o.name, f"test {t.id}: {counts['added']} added")
    db.commit()
    return {"version": v, **counts}


@router.post("/ontologies/{oid}/tests/{tid}/save-use-case")
def save_as_use_case(oid: int, tid: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid, "edit")
    t = _get_test(db, oid, tid)
    if t.status != "done":
        raise HTTPException(400, "The test has not finished.")
    r = t.result
    c = json.loads(json.dumps(o.content))
    n = 1
    while any(u["id"] == f"UC{n}" for u in c["use_cases"]):
        n += 1
    c["use_cases"].append({"id": f"UC{n}", "title": r.get("title") or t.text[:80], "actor": "", "question": t.text, "description": r.get("summary", ""),
                           "classes": [m["id"] for x in r["requirements"] for m in x["mapped"] if m["type"] == "class"],
                           "properties": [m["id"] for x in r["requirements"] for m in x["mapped"] if m["type"].endswith("property")],
                           "answer_path": r.get("answer_path", []), "sparql": r.get("sparql", ""), "source": "testbed"})
    v = builder.save_version(db, o, c, f"Use case added from the test bed: {(r.get('title') or t.text)[:100]}", user.email)
    audit(db, request, user, "ontology.use_case_from_test", o.name, f"test {t.id}")
    db.commit()
    return {"version": v, "id": f"UC{n}"}


@router.delete("/ontologies/{oid}/tests/{tid}")
def delete_test(oid: int, tid: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid)
    t = _get_test(db, oid, tid)
    if t.user_id != user.id and RANK[o.my_level] < RANK["edit"]:
        raise HTTPException(403, "You can only delete your own tests.")
    audit(db, request, user, "test.deleted", o.name, t.text[:200])
    db.delete(t)
    db.commit()
    return {"ok": True}


# ---- reasoner --------------------------------------------------------------------------------
@router.post("/ontologies/{oid}/reason/{engine}")
def reason(oid: int, engine: str, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid)
    if engine not in ("owlrl", "hermit"):
        raise HTTPException(404, "Unknown reasoner")
    if not o.content:
        raise HTTPException(400, "Build the ontology first.")
    if not security.limiter.allow(f"reason:{user.id}", 30, 60):
        raise HTTPException(429, "Too many reasoner runs. Wait a minute.")
    res = reasoner.run(o.content, engine)
    audit(db, request, user, "ontology.reasoned", o.name, f"{engine}: {len(res['problems'])} problems")
    db.commit()
    return {**res, "version": o.version}
