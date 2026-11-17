"""Knowledge graph of an ontology: the mapping onto its data sources, building the graph from their rows, and
running queries on it - typed in the console or written by the AI for a test-bed use case.

Access: anyone who can view the ontology sees the mapping and the counts. The records themselves (query results,
the picture of an answer, example values) only reach people who may use every data source the graph was built
from. Changing the mapping and building need edit access to the ontology and use of its data sources."""
import json
from datetime import timedelta
import logging
import threading
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import builder, exports, kg, kgdocs, security
from ..db import SessionLocal, get_db, now
from ..deps import RANK, audit, current_user, get_ontology, get_settings, level
from ..models import Job, KnowledgeGraph, Ontology, TestRun, User
from .ontologies import _active_job, _get_test, _job, _launch, _model

router = APIRouter(prefix="/api", tags=["knowledge graph"])


def _built(o) -> None:
    if not o.content or not o.content["classes"]:
        raise HTTPException(400, "Build the ontology first.")


def _may_see(db, user, rec) -> list[str]:
    """Names of data sources of the graph this person may not use (empty = may see its records)."""
    if user.role == "viewer":
        return ["(viewers see the design only)"]
    if rec and rec.store and not kg.is_live(rec):
        ids = list(rec.sources or [])
    else:                                                      # not built, or live: whatever it reads next time
        ids = [d.id for d in kg.linked(db, rec.ontology_id if rec else 0)] + list((rec.sources if rec else None) or [])
    return kg.data_access(db, user, ids)


def _need_data(db, user, o, rec=None):
    """Editing the mapping or building reads the data sources: the person must be able to use all of them."""
    blocked = kg.data_access(db, user, [d.id for d in kg.linked(db, o.id)] + list((rec.sources if rec else None) or []))
    if user.role == "viewer" or blocked:
        raise HTTPException(403, "You need access to every data source of this ontology for this: " + ", ".join(blocked or ["viewers cannot use data sources"]) +
                            ". Ask their owner for access.")


def _hide(stats: dict) -> dict:
    """Counts stay; example values from the data go."""
    out = {**stats, "maps": [{**m, "values": {k: {**v, "examples": []} for k, v in m.get("values", {}).items()}} for m in stats.get("maps", [])]}
    return out


def _state(db, user, o) -> dict:
    rec = kg.record(db, o.id)
    mapping = (rec.mapping if rec else None) or {"maps": []}
    tables = kg.catalogue(db, o.id)
    problems = []
    if o.content and o.content["classes"]:
        mapping, problems = kg.clean_mapping(o.content, mapping, tables)
    blocked = _may_see(db, user, rec) if rec else (["(viewers see the design only)"] if user.role == "viewer" else
                                                   kg.data_access(db, user, [d.id for d in kg.linked(db, o.id)]))
    see = not blocked
    stats = (rec.stats if rec else None) or {}
    kinds = ("graph", "map", "extract")
    job = db.scalar(select(Job).where(Job.ontology_id == o.id, Job.kind.in_(kinds), Job.status.in_(("queued", "running", "paused"))).order_by(Job.id.desc()))
    last = db.scalar(select(Job).where(Job.ontology_id == o.id, Job.kind.in_(kinds)).order_by(Job.id.desc()))
    stale = []
    if rec and rec.store:                                      # a stored copy can fall behind; a live graph cannot
        if rec.built_version != o.version:
            stale.append(f"The ontology has changed since the graph was built (version {rec.built_version} → {o.version}).")
        if rec.mapping_changed_at and rec.built_at and rec.mapping_changed_at > rec.built_at:
            stale.append("The mapping has changed since the graph was built.")
    return {"status": rec.status if rec else "none", "error": rec.error if rec else "", "built_at": rec.built_at.isoformat() if rec and rec.built_at else None,
            "built_version": rec.built_version if rec else 0, "built_by": rec.built_by if rec else "", "version": o.version,
            "mapping": mapping, "problems": problems, "coverage": kg.coverage(o.content, mapping, stats) if o.content else None,
            "stats": (stats if see else _hide(stats)) if stats else None, "stale": stale,
            "tables": tables if see else [], "sources": [{"id": d.id, "name": d.name, "kind": d.kind} for d in kg.linked(db, o.id)],
            "can_see_data": see, "blocked": blocked, "can_edit": o.my_level in ("edit", "manage") and user.role != "viewer" and see,
            "job": _job(job) if job else None, "last_job": _job(last) if last and last.status in ("done", "error", "cancelled") else None,
            "prefixes": kg.prefixes(o.content) if o.content else {},
            "documents": kgdocs.documents(db, o.id) if see else [],
            "extracted": kgdocs.summary(rec.extracted) if rec and rec.extracted else None,
            "storage": (rec.storage or "stored") if rec else "stored", "live_minutes": (rec.live_minutes if rec and rec.live_minutes is not None else 10),
            "overview": kg.overview(o.content, rec) if rec and rec.status == "ready" and o.content else None,
            "refresh": (rec.refresh or "") if rec else "", "next_refresh_at": rec.next_refresh_at.isoformat() if rec and rec.next_refresh_at else None,
            "rows_per_table": int(get_settings(db)["graph_rows_per_table"])}


@router.get("/ontologies/{oid}/graph")
def state(oid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid)
    return _state(db, user, o)


class MappingIn(BaseModel):
    mapping: dict


@router.put("/ontologies/{oid}/graph/mapping")
def save_mapping(oid: int, body: MappingIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid, "edit")
    _built(o)
    rec = kg.record(db, oid, create=True)
    _need_data(db, user, o, rec)
    mapping, problems = kg.clean_mapping(o.content, body.mapping, kg.catalogue(db, oid))
    rec.mapping, rec.mapping_changed_at = mapping, now()
    audit(db, request, user, "graph.mapping_saved", o.name, f"{len(mapping['maps'])} class mappings; {len(problems)} entries left out")
    db.commit()
    return {**_state(db, user, o), "saved_problems": problems}


class MatchIn(BaseModel):
    replace_drafts: bool = False


@router.post("/ontologies/{oid}/graph/match")
def match(oid: int, body: MatchIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Propose a mapping from names alone (no AI)."""
    o = get_ontology(db, user, oid, "edit")
    _built(o)
    rec = kg.record(db, oid, create=True)
    _need_data(db, user, o, rec)
    tables = kg.catalogue(db, oid)
    if not tables:
        raise HTTPException(400, "This ontology uses no data source with tables. Add one on the Sources tab first.")
    new, _ = kg.clean_mapping(o.content, kg.suggest(o.content, tables), tables)
    before = len((rec.mapping or {}).get("maps", []))
    merged, _ = kg.clean_mapping(o.content, kg.merge(rec.mapping or {}, new, body.replace_drafts), tables)
    rec.mapping, rec.mapping_changed_at = merged, now()
    audit(db, request, user, "graph.matched", o.name, f"{len(new['maps'])} matched by names")
    db.commit()
    return {**_state(db, user, o), "matched": len(new["maps"]), "added": len(merged["maps"]) - before}


class ProposeIn(BaseModel):
    model_id: int | None = None
    replace_drafts: bool = False


@router.post("/ontologies/{oid}/graph/propose")
def propose(oid: int, body: ProposeIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid, "edit")
    _built(o)
    _need_data(db, user, o, kg.record(db, oid))
    if not kg.catalogue(db, oid):
        raise HTTPException(400, "This ontology uses no data source with tables. Add one on the Sources tab first.")
    return _job(_launch(db, request, user, o, "map", _model(db, body.model_id), {"replace": body.replace_drafts}))


@router.post("/ontologies/{oid}/graph/build")
def build(oid: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid, "edit")
    _built(o)
    rec = kg.record(db, oid, create=True)
    _need_data(db, user, o, rec)
    if not (rec.mapping or {}).get("maps") and not any(e["status"] == "accepted" for e in (rec.extracted or {}).get("entities", [])):
        raise HTTPException(400, "Nothing to build from yet: map at least one class to a table, or accept facts extracted from documents.")
    if _active_job(db, oid):
        raise HTTPException(409, "A job is already running on this ontology. Wait for it to finish.")
    if not security.limiter.allow(f"graph:{user.id}", 20, 3600):
        raise HTTPException(429, "Too many graph builds in an hour. Try again later.")
    j = Job(kind="graph", ontology_id=o.id, ontology_name=o.name, user_id=user.id, user_email=user.email, model_id=None, model_label="",
            params={}, stage="Waiting to start")
    db.add(j)
    audit(db, request, user, "graph.build", o.name)
    db.commit()
    builder.start(j.id)
    return _job(j)


@router.delete("/ontologies/{oid}/graph")
def remove(oid: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Delete the built graph (its copy of the data). The mapping is kept."""
    o = get_ontology(db, user, oid, "edit")
    rec = kg.record(db, oid)
    if rec:
        kg.drop(db, oid)
        kg.forget_live(oid)
        rec.store, rec.status, rec.stats, rec.sources, rec.built_at = "", "none", {}, [], None
    audit(db, request, user, "graph.deleted", o.name)
    db.commit()
    return _state(db, user, o)


class QueryIn(BaseModel):
    sparql: str


@router.post("/ontologies/{oid}/graph/query")
def query(oid: int, body: QueryIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid)
    rec = kg.record(db, oid)
    if not rec or rec.status != "ready" or not (rec.store or kg.is_live(rec)):
        raise HTTPException(400, "The knowledge graph has not been built yet.")
    blocked = _may_see(db, user, rec)
    if blocked:
        raise HTTPException(403, "The knowledge graph holds data from data sources you have no access to: " + ", ".join(blocked) + ".")
    if not security.limiter.allow(f"query:{user.id}", 60, 60):
        raise HTTPException(429, "Too many queries in a minute. Wait a moment.")
    try:
        res = kg.run_query(rec, o.content, body.sparql, int(get_settings(db)["graph_query_seconds"]))
    except kg.GraphError as e:
        audit(db, request, user, "graph.query_failed", o.name, body.sparql[:300])
        db.commit()
        raise HTTPException(400, str(e))
    audit(db, request, user, "graph.query", o.name, f"{res['count']} rows · " + body.sparql[:300])
    db.commit()
    return {**res, "no_data": kg.without_data(o.content, rec.stats or {}, kg.elements(o.content, body.sparql))}


# ---- the test bed: answering a tested use case from the graph -----------------------------------------
class AnswerIn(BaseModel):
    model_id: int | None = None


@router.post("/ontologies/{oid}/tests/{tid}/answer")
def answer(oid: int, tid: int, body: AnswerIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The AI writes a query for this use case; it runs on the graph (the AI never sees the result)."""
    o = get_ontology(db, user, oid)
    t = _get_test(db, oid, tid)
    if t.status != "done":
        raise HTTPException(400, "The test has not finished.")
    rec = kg.record(db, oid)
    if not rec or rec.status != "ready":
        raise HTTPException(400, "Build the knowledge graph first (Knowledge graph tab).")
    blocked = _may_see(db, user, rec)
    if blocked:
        raise HTTPException(403, "The knowledge graph holds data from data sources you have no access to: " + ", ".join(blocked) + ".")
    return {"job": _job(_launch(db, request, user, o, "answer", _model(db, body.model_id), {"test_run_id": t.id}, "tests"))}


@router.post("/ontologies/{oid}/tests/{tid}/rerun")
def rerun(oid: int, tid: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Run the stored query of a test again on the current graph (no AI)."""
    o = get_ontology(db, user, oid)
    t = _get_test(db, oid, tid)
    data = (t.result or {}).get("data")
    if not data or not data.get("sparql"):
        raise HTTPException(400, "This test has no query to run again.")
    rec = kg.record(db, oid)
    if not rec or rec.status != "ready":
        raise HTTPException(400, "Build the knowledge graph first (Knowledge graph tab).")
    blocked = _may_see(db, user, rec)
    if blocked:
        raise HTTPException(403, "The knowledge graph holds data from data sources you have no access to: " + ", ".join(blocked) + ".")
    new = {**data, "graph_built_at": rec.built_at.isoformat() if rec.built_at else None, "graph_version": rec.built_version, "sources": rec.sources,
           "rerun_at": now().isoformat()}
    try:
        res = kg.run_query(rec, o.content, data["sparql"], int(get_settings(db)["graph_query_seconds"]), kg.TEST_ROWS)
        got = res["value"] if res["kind"] == "ask" else res["count"] > 0
        new.update(status="answered" if got else "empty", result=res, error="")
    except kg.GraphError as e:
        new.update(status="error", error=str(e), result=None)
    req = [m["id"] for r in t.result.get("requirements", []) if r["status"] != "missing" for m in r["mapped"]]
    new["no_data"] = kg.without_data(o.content, rec.stats or {}, kg.elements(o.content, data["sparql"]) + req)
    t.result = {**t.result, "data": new}
    audit(db, request, user, "graph.test_rerun", o.name, f"test {t.id}: {new['status']}")
    db.commit()
    return {"ok": True, "status": new["status"]}


def visible_data(db, user, t: TestRun, data: dict | None) -> dict | None:
    """What of a test's data answer this person may see: everything, or only that there is one."""
    if not data:
        return None
    if user.role != "viewer" and not kg.data_access(db, user, data.get("sources") or []):
        return data
    return {"status": data.get("status"), "hidden": True, "explanation": data.get("explanation", ""), "sparql": data.get("sparql", ""),
            "no_data": data.get("no_data", []), "graph_built_at": data.get("graph_built_at")}


# ---- facts from documents ----------------------------------------------------------------------------------
class ExtractIn(BaseModel):
    documents: list[str]
    model_id: int | None = None


@router.post("/ontologies/{oid}/graph/extract")
def extract(oid: int, body: ExtractIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The AI reads the chosen documents and proposes entities and relationships; every item is checked (kgdocs)."""
    o = get_ontology(db, user, oid, "edit")
    _built(o)
    _need_data(db, user, o, kg.record(db, oid))
    keys = list(dict.fromkeys(body.documents))
    if not keys:
        raise HTTPException(400, "Choose at least one document.")
    if len(keys) > kgdocs.MAX_DOCS:
        raise HTTPException(400, f"At most {kgdocs.MAX_DOCS} documents at a time.")
    bad = [k for k in keys if not kgdocs.text_of(db, oid, k)]
    if bad:
        raise HTTPException(400, "Some of the chosen documents are not sources of this ontology.")
    return _job(_launch(db, request, user, o, "extract", _model(db, body.model_id), {"documents": keys}))


def _store_for(db, user, o, edit: bool = False):
    rec = kg.record(db, o.id)
    if edit:
        _need_data(db, user, o, rec)
    elif _may_see(db, user, rec) if rec else user.role == "viewer":
        raise HTTPException(403, "The extracted facts come from documents of data sources you have no access to.")
    if not rec or not rec.extracted:
        raise HTTPException(404, "Nothing has been extracted from documents yet.")
    return rec


@router.get("/ontologies/{oid}/graph/extracted")
def extracted(oid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid)
    rec = _store_for(db, user, o)
    kgdocs.clean_against(o.content, rec.extracted)
    return {**rec.extracted, "summary": kgdocs.summary(rec.extracted)}


class StatusIn(BaseModel):
    ids: list[str]
    status: str


@router.post("/ontologies/{oid}/graph/extracted/status")
def set_status(oid: int, body: StatusIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Accept or reject extracted entities and relationships (only accepted ones go into the graph)."""
    o = get_ontology(db, user, oid, "edit")
    rec = _store_for(db, user, o, edit=True)
    if body.status not in ("accepted", "rejected", "proposed"):
        raise HTTPException(400, "Unknown status.")
    store = json.loads(json.dumps(rec.extracted))
    n = kgdocs.set_status(store, body.ids[:5000], body.status)
    rec.extracted, rec.mapping_changed_at = store, now()
    audit(db, request, user, f"graph.extracted_{body.status}", o.name, f"{n} item(s)")
    db.commit()
    return {"changed": n, "summary": kgdocs.summary(store)}


class MergeIn(BaseModel):
    keep: str
    drop: str


@router.post("/ontologies/{oid}/graph/extracted/merge")
def merge_entities(oid: int, body: MergeIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o = get_ontology(db, user, oid, "edit")
    rec = _store_for(db, user, o, edit=True)
    store = json.loads(json.dumps(rec.extracted))
    names = {e["id"]: e["label"] for e in store["entities"]}
    if not kgdocs.merge(o.content, store, body.keep, body.drop):
        raise HTTPException(400, "These two cannot be merged (not found, or different kinds of thing).")
    rec.extracted, rec.mapping_changed_at = store, now()
    audit(db, request, user, "graph.extracted_merged", o.name, f"{names.get(body.drop)} into {names.get(body.keep)}")
    db.commit()
    return {"ok": True}


class SuggestionIn(BaseModel):
    a: str
    b: str


@router.post("/ontologies/{oid}/graph/extracted/dismiss")
def dismiss(oid: int, body: SuggestionIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """A merge suggestion that is not the same thing."""
    o = get_ontology(db, user, oid, "edit")
    rec = _store_for(db, user, o, edit=True)
    store = json.loads(json.dumps(rec.extracted))
    store["suggestions"] = [x for x in store["suggestions"] if (x["a"], x["b"]) != (body.a, body.b)]
    store.setdefault("dismissed", []).append([body.a, body.b])
    rec.extracted = store
    db.commit()
    return {"ok": True}


# ---- exploring records ---------------------------------------------------------------------------------------
def _readable(db, user, oid):
    o = get_ontology(db, user, oid)
    rec = kg.record(db, oid)
    if not rec or rec.status != "ready" or not (rec.store or kg.is_live(rec)):
        raise HTTPException(400, "The knowledge graph has not been built yet.")
    blocked = _may_see(db, user, rec)
    if blocked:
        raise HTTPException(403, "The knowledge graph holds data from data sources you have no access to: " + ", ".join(blocked) + ".")
    if not security.limiter.allow(f"query:{user.id}", 120, 60):
        raise HTTPException(429, "Too many requests in a minute. Wait a moment.")
    return o, rec


@router.get("/ontologies/{oid}/graph/records")
def records(oid: int, q: str = "", cls: str = "", user: User = Depends(current_user), db: Session = Depends(get_db)):
    o, rec = _readable(db, user, oid)
    try:
        return {"items": kg.search(rec, o.content, q, cls, int(get_settings(db)["graph_query_seconds"]))}
    except kg.GraphError as e:
        raise HTTPException(400, str(e))


@router.get("/ontologies/{oid}/graph/record")
def record(oid: int, iri: str, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    o, rec = _readable(db, user, oid)
    try:
        out = kg.record_view(rec, o.content, iri, int(get_settings(db)["graph_query_seconds"]))
    except kg.GraphError as e:
        raise HTTPException(400, str(e))
    audit(db, request, user, "graph.record_viewed", o.name, out["name"][:200])
    db.commit()
    return out


# ---- downloads ------------------------------------------------------------------------------------------------
@router.get("/ontologies/{oid}/graph/export/{fmt}")
def export(oid: int, fmt: str, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """ttl: the whole graph with its records (needs access to the data); r2rml: the mapping (structure only)."""
    if fmt not in ("ttl", "r2rml"):
        raise HTTPException(404, "Unknown format")
    if fmt == "ttl":
        o, rec = _readable(db, user, oid)
        try:
            data = kg.dump_turtle(rec)
        except kg.GraphError as e:
            raise HTTPException(400, str(e))
        name = exports.filename(o.name + " knowledge graph", "ttl")
    else:
        o = get_ontology(db, user, oid)
        _built(o)
        rec = kg.record(db, oid)
        tables = kg.catalogue(db, oid)
        mapping, _ = kg.clean_mapping(o.content, (rec.mapping if rec else None) or {}, tables)
        if not mapping["maps"]:
            raise HTTPException(400, "Nothing is mapped yet.")
        data = kg.r2rml(o.content, mapping, tables).encode("utf-8")
        name = exports.filename(o.name + " mapping r2rml", "ttl")
    audit(db, request, user, f"graph.export_{fmt}", o.name)
    db.commit()
    return Response(data, media_type="text/turtle", headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---- where the data lives --------------------------------------------------------------------------------------
class StorageIn(BaseModel):
    storage: str = "stored"
    live_minutes: int = 10


@router.put("/ontologies/{oid}/graph/storage")
def set_storage(oid: int, body: StorageIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """stored: a copy of the records is kept on this server (fast; refreshed by building again or on a schedule).
    live: nothing is kept - the records are read from the data sources when someone asks, held in memory for a few
    minutes at most, and discarded."""
    o = get_ontology(db, user, oid, "edit")
    if body.storage not in ("stored", "live"):
        raise HTTPException(400, "Choose stored or live.")
    if not 0 <= body.live_minutes <= 120:
        raise HTTPException(400, "Keep a live graph in memory for 0 to 120 minutes.")
    rec = kg.record(db, oid, create=True)
    _need_data(db, user, o, rec)
    before = rec.storage or "stored"
    rec.storage, rec.live_minutes = body.storage, body.live_minutes
    kg.forget_live(oid)
    if body.storage == "live" and before != "live":
        kg.drop(db, oid)                                       # the stored copy of the data is deleted
        rec.store = ""
        rec.refresh, rec.refresh_user_id, rec.next_refresh_at = "", None, None
        rec.status = "ready" if rec.status == "ready" else rec.status
    elif body.storage == "stored" and before == "live":
        rec.status = "none"                                    # build to make the stored copy
    audit(db, request, user, "graph.storage", o.name, f"{body.storage}; memory {body.live_minutes} min")
    db.commit()
    return _state(db, user, o)


# ---- scheduled rebuilds -----------------------------------------------------------------------------------------
class RefreshIn(BaseModel):
    refresh: str = ""


@router.put("/ontologies/{oid}/graph/refresh")
def set_refresh(oid: int, body: RefreshIn, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Rebuild the graph from the data every night or every week, with the access of the person who set it up."""
    o = get_ontology(db, user, oid, "edit")
    if body.refresh not in ("", "daily", "weekly"):
        raise HTTPException(400, "Choose never, daily or weekly.")
    rec = kg.record(db, oid, create=True)
    if body.refresh and kg.is_live(rec):
        raise HTTPException(400, "A live knowledge graph is read from the data sources whenever it is used; it needs no scheduled rebuild.")
    _need_data(db, user, o, rec)
    rec.refresh = body.refresh
    rec.refresh_user_id = user.id if body.refresh else None
    rec.next_refresh_at = kg.next_time(body.refresh)
    audit(db, request, user, "graph.refresh_schedule", o.name, body.refresh or "never")
    db.commit()
    return _state(db, user, o)


log = logging.getLogger("ontostudio")


def run_due() -> int:
    """Start the scheduled rebuilds that are due. A schedule whose owner lost access is switched off and says why."""
    started = 0
    with SessionLocal() as db:
        for rec in kg.due(db):
            o = db.get(Ontology, rec.ontology_id)
            u = db.get(User, rec.refresh_user_id) if rec.refresh_user_id else None
            reason = None
            if not o or not o.content:
                reason = "the ontology is gone"
            elif not u or not u.is_active:
                reason = "the person who set it up no longer has an active account"
            elif RANK.get(level(db, u, o) or "", 0) < RANK["edit"] or u.role == "viewer":
                reason = f"{u.email} can no longer edit the ontology"
            elif kg.data_access(db, u, [d.id for d in kg.linked(db, o.id)] + list(rec.sources or [])):
                reason = f"{u.email} no longer has access to all its data sources"
            if reason:
                rec.refresh, rec.next_refresh_at = "", None
                rec.error = f"The scheduled rebuild was switched off: {reason}."
                audit(db, None, u, "graph.refresh_stopped", o.name if o else str(rec.ontology_id), reason)
                continue
            rec.next_refresh_at = kg.next_time(rec.refresh)
            if _active_job(db, o.id):
                rec.next_refresh_at = now() + timedelta(hours=1)
                continue
            j = Job(kind="graph", ontology_id=o.id, ontology_name=o.name, user_id=u.id, user_email=u.email, model_id=None, model_label="",
                    params={"scheduled": True}, stage="Waiting to start")
            db.add(j)
            audit(db, None, u, "graph.scheduled_build", o.name, rec.refresh)
            db.commit()
            builder.start(j.id)
            started += 1
        db.commit()
    return started


def start_scheduler():
    def loop():
        while True:
            time.sleep(60)
            try:
                run_due()
            except Exception:                                  # noqa: BLE001 - keep the scheduler alive; the error is logged
                log.exception("Scheduled knowledge-graph rebuilds failed")
    threading.Thread(target=loop, daemon=True, name="graph-scheduler").start()
