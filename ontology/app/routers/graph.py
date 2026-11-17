"""Knowledge graph of an ontology: the mapping onto its data sources, building the graph from their rows, and
running queries on it - typed in the console or written by the AI for a test-bed use case.

Access: anyone who can view the ontology sees the mapping and the counts. The records themselves (query results,
the picture of an answer, example values) only reach people who may use every data source the graph was built
from. Changing the mapping and building need edit access to the ontology and use of its data sources."""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import builder, kg, security
from ..db import get_db, now
from ..deps import audit, current_user, get_ontology, get_settings
from ..models import Job, TestRun, User
from .ontologies import _active_job, _get_test, _job, _launch, _model

router = APIRouter(prefix="/api", tags=["knowledge graph"])


def _built(o) -> None:
    if not o.content or not o.content["classes"]:
        raise HTTPException(400, "Build the ontology first.")


def _may_see(db, user, rec) -> list[str]:
    """Names of data sources of the graph this person may not use (empty = may see its records)."""
    if user.role == "viewer":
        return ["(viewers see the design only)"]
    ids = list(rec.sources or []) if rec and rec.store else [d.id for d in kg.linked(db, rec.ontology_id if rec else 0)]
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
    job = db.scalar(select(Job).where(Job.ontology_id == o.id, Job.kind.in_(("graph", "map")), Job.status.in_(("queued", "running"))).order_by(Job.id.desc()))
    last = db.scalar(select(Job).where(Job.ontology_id == o.id, Job.kind.in_(("graph", "map"))).order_by(Job.id.desc()))
    stale = []
    if rec and rec.store:
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
            "job": _job(job) if job else None, "last_job": _job(last) if last and last.status in ("done", "error") else None,
            "prefixes": kg.prefixes(o.content) if o.content else {},
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
    if not (rec.mapping or {}).get("maps"):
        raise HTTPException(400, "Nothing is mapped yet: map at least one class to a table first.")
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
    if not rec or rec.status != "ready" or not rec.store:
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
