"""Relationships of a data model (the metadata graph): joins and business entities. Stewards and administrators."""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .. import connectors, graph
from ..db import get_db, now
from ..deps import audit, get_connection, steward_up
from ..models import GraphBinding, GraphEdge, GraphEntity, User

router = APIRouter(prefix="/api/graph", tags=["graph"])
ORIGIN = {"schema": "Foreign key", "verified_sql": "Verified SQL", "names": "Matching names", "steward": "Added by a steward"}


class EdgeIn(BaseModel):
    left_table: str
    left_columns: list[str]
    right_table: str
    right_columns: list[str]
    cardinality: str = ""


class EdgeUpdate(BaseModel):
    action: str = ""                  # confirm | reject | restore | "" (edit only)
    cardinality: str | None = None
    left_columns: list[str] | None = None
    right_columns: list[str] | None = None


class BindingIn(BaseModel):
    table: str
    key_columns: list[str] = []
    source_of_truth: bool = False


class EntityIn(BaseModel):
    name: str
    synonyms: list[str] = []
    description: str = ""
    bindings: list[BindingIn] = []


def _edge_dto(e: GraphEdge) -> dict:
    return {"id": e.id, "left_table": e.left_table, "left_columns": e.left_columns, "right_table": e.right_table,
            "right_columns": e.right_columns, "kind": e.kind, "cardinality": e.cardinality, "origin": e.origin,
            "origin_label": ORIGIN.get(e.origin, e.origin), "status": e.status, "evidence": e.evidence or [],
            "confidence": e.confidence, "decided": e.decided_by is not None, "join": graph.join_text(e)}


def _view(db: Session, conn) -> dict:
    edges = list(db.scalars(select(GraphEdge).where(GraphEdge.left_connection_id == conn.id, GraphEdge.right_connection_id == conn.id)
                            .order_by(GraphEdge.status, GraphEdge.confidence.desc(), GraphEdge.left_table, GraphEdge.right_table)))
    ents = graph.entities_for(db, conn)
    tables = [{"name": connectors.table_fqn(t), "columns": [{"name": c["name"], "type": c.get("type") or "", "pk": bool(c.get("pk"))}
                                                           for c in t["columns"]]}
              for t in (conn.schema_json or {}).get("tables", [])]
    return {"connection": {"id": conn.id, "name": conn.name}, "tables": tables,
            "edges": [_edge_dto(e) for e in edges],
            "entities": [{"id": ent.id, "name": ent.name, "synonyms": ent.synonyms or [], "description": ent.description,
                          "bindings": [{"table": b.table_name, "key_columns": b.key_columns or [], "source_of_truth": b.source_of_truth}
                                       for b in binds]} for ent, binds in ents],
            "counts": {s: sum(1 for e in edges if e.status == s) for s in graph.STATUSES}}


def _check_side(conn, table: str, columns: list[str]) -> tuple[str, list[str]]:
    """The table and columns as the schema spells them; 400 when they do not exist."""
    t = graph.tables_of(conn).get(table.strip().lower())
    if not t:
        raise HTTPException(400, f"Table '{table}' is not in this data model's schema.")
    cols = []
    for c in columns:
        name = graph._col(t, c.strip())
        if not name:
            raise HTTPException(400, f"Column '{c}' is not in table {connectors.table_fqn(t)}.")
        cols.append(name)
    if not cols:
        raise HTTPException(400, f"Choose at least one column of {connectors.table_fqn(t)}.")
    return connectors.table_fqn(t), cols


def _edge(db: Session, user: User, edge_id: int):
    e = db.get(GraphEdge, edge_id)
    if not e or e.company_id != user.company_id:
        raise HTTPException(404, "Not found")
    conn = get_connection(db, user, e.left_connection_id)          # also checks access and company
    if e.right_connection_id != conn.id:
        get_connection(db, user, e.right_connection_id)
    return e, conn


@router.get("/{conn_id}")
def view(conn_id: int, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    conn = get_connection(db, user, conn_id)
    graph.refresh(db, conn)
    return _view(db, conn)


@router.post("/{conn_id}/rebuild")
def rebuild(conn_id: int, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    conn = get_connection(db, user, conn_id)
    out = graph.rebuild(db, conn)
    audit(db, request, user, "graph.rebuilt", conn.name, f"{out['added']} added, {out['updated']} kept, {out['removed']} removed")
    db.commit()
    return {**_view(db, conn), "result": out}


@router.post("/{conn_id}/edges")
def add_edge(conn_id: int, body: EdgeIn, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    conn = get_connection(db, user, conn_id)
    lt, lc = _check_side(conn, body.left_table, body.left_columns)
    rt, rc = _check_side(conn, body.right_table, body.right_columns)
    if len(lc) != len(rc):
        raise HTTPException(400, "Pick the same number of columns on both sides (they are matched in order).")
    if lt.lower() == rt.lower():
        raise HTTPException(400, "A join links two different tables.")
    if body.cardinality not in graph.CARDINALITIES:
        raise HTTPException(400, "Unknown cardinality.")
    key = graph._key(conn.id, lt, lc, conn.id, rt, rc)[:2]
    for e in db.scalars(select(GraphEdge).where(GraphEdge.left_connection_id == conn.id, GraphEdge.right_connection_id == conn.id)):
        if graph.edge_key(e) == key:              # the same pair exists: confirm it instead of adding a second row
            same = e.left_table.lower() == lt.lower()
            e.status, e.decided_by, e.decided_at = "confirmed", user.id, now()
            if body.cardinality:
                e.cardinality = body.cardinality if same else graph.FLIP.get(body.cardinality, body.cardinality)
            audit(db, request, user, "graph.edge_confirmed", conn.name, graph.join_text(e))
            db.commit()
            return _edge_dto(e)
    e = GraphEdge(company_id=conn.company_id, left_connection_id=conn.id, left_table=lt, left_columns=lc, right_connection_id=conn.id,
                  right_table=rt, right_columns=rc, kind="join", cardinality=body.cardinality, origin="steward", status="confirmed",
                  evidence=[f"Added by {user.name or user.email}"], confidence=1.0, decided_by=user.id, decided_at=now())
    db.add(e)
    audit(db, request, user, "graph.edge_added", conn.name, graph.join_text(e))
    db.commit()
    return _edge_dto(e)


@router.put("/edges/{edge_id}")
def update_edge(edge_id: int, body: EdgeUpdate, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    e, conn = _edge(db, user, edge_id)
    if body.cardinality is not None:
        if body.cardinality not in graph.CARDINALITIES:
            raise HTTPException(400, "Unknown cardinality.")
        e.cardinality = body.cardinality
    if body.left_columns is not None or body.right_columns is not None:
        if e.origin in ("schema", "verified_sql"):
            raise HTTPException(400, "This join comes from the database or a verified example; its columns cannot be edited. "
                                     "Reject it and add the right one instead.")
        _, lc = _check_side(conn, e.left_table, body.left_columns if body.left_columns is not None else e.left_columns)
        _, rc = _check_side(conn, e.right_table, body.right_columns if body.right_columns is not None else e.right_columns)
        if len(lc) != len(rc):
            raise HTTPException(400, "Pick the same number of columns on both sides (they are matched in order).")
        e.left_columns, e.right_columns, e.origin = lc, rc, "steward"
        e.status = "confirmed"
    action = {"confirm": "confirmed", "reject": "rejected"}.get(body.action)
    if body.action and body.action not in ("confirm", "reject", "restore"):
        raise HTTPException(400, "Unknown action.")
    if action:
        e.status = action
    if body.action == "restore":            # back to how it was found: a suggestion again, or confirmed for automatic joins
        e.decided_by, e.decided_at = None, None
        e.status = "suggested" if e.origin == "names" else "confirmed"
    else:
        e.decided_by, e.decided_at = user.id, now()
    audit(db, request, user, f"graph.edge_{action or ('restored' if body.action == 'restore' else 'updated')}", conn.name,
          graph.join_text(e))
    db.commit()
    return _edge_dto(e)


@router.delete("/edges/{edge_id}")
def delete_edge(edge_id: int, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    e, conn = _edge(db, user, edge_id)
    if e.origin != "steward":
        raise HTTPException(400, "Only joins added by a steward can be deleted. Reject this one instead - it will not be suggested again.")
    audit(db, request, user, "graph.edge_deleted", conn.name, graph.join_text(e))
    db.delete(e)
    db.commit()
    return {"ok": True}


def _save_entity(db: Session, user: User, conn, body: EntityIn, ent: GraphEntity | None):
    name = " ".join(body.name.split())[:200]
    if not name:
        raise HTTPException(400, "Give the entity a name, for example Customer.")
    clash = db.scalar(select(GraphEntity).where(GraphEntity.company_id == user.company_id, func.lower(GraphEntity.name) == name.lower()))
    if ent is None:
        ent = clash                                # the same business thing in another data model: add this one's tables to it
    elif clash and clash.id != ent.id:
        raise HTTPException(400, f"An entity called '{clash.name}' already exists.")
    binds = []
    for b in body.bindings:
        t = graph.tables_of(conn).get(b.table.strip().lower())
        if not t:
            raise HTTPException(400, f"Table '{b.table}' is not in this data model's schema.")
        tname = connectors.table_fqn(t)
        cols = _check_side(conn, tname, b.key_columns)[1] if b.key_columns else []
        binds.append((tname, cols, b.source_of_truth))
    if not binds:
        raise HTTPException(400, "Choose at least one table where this entity is stored.")
    synonyms = list(dict.fromkeys(s.strip()[:100] for s in body.synonyms if s.strip()))[:30]
    if ent is None:
        ent = GraphEntity(company_id=user.company_id, name=name)
        db.add(ent)
    ent.name, ent.synonyms, ent.description = name, synonyms, body.description.strip()[:2000]
    db.flush()
    db.execute(delete(GraphBinding).where(GraphBinding.entity_id == ent.id, GraphBinding.connection_id == conn.id))
    for t, cols, sot in binds:
        db.add(GraphBinding(company_id=user.company_id, entity_id=ent.id, connection_id=conn.id, table_name=t, key_columns=cols,
                            source_of_truth=sot))
    return ent


def _entity(db: Session, user: User, entity_id: int) -> GraphEntity:
    ent = db.get(GraphEntity, entity_id)
    if not ent or ent.company_id != user.company_id:
        raise HTTPException(404, "Not found")
    return ent


@router.post("/{conn_id}/entities")
def add_entity(conn_id: int, body: EntityIn, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    conn = get_connection(db, user, conn_id)
    ent = _save_entity(db, user, conn, body, None)
    audit(db, request, user, "graph.entity_saved", conn.name, ent.name)
    db.commit()
    return {"id": ent.id}


@router.put("/{conn_id}/entities/{entity_id}")
def update_entity(conn_id: int, entity_id: int, body: EntityIn, request: Request, user: User = Depends(steward_up),
                  db: Session = Depends(get_db)):
    conn = get_connection(db, user, conn_id)
    ent = _save_entity(db, user, conn, body, _entity(db, user, entity_id))
    audit(db, request, user, "graph.entity_saved", conn.name, ent.name)
    db.commit()
    return {"id": ent.id}


@router.delete("/{conn_id}/entities/{entity_id}")
def remove_entity(conn_id: int, entity_id: int, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    """Removes the entity from this data model; the entity itself goes when no data model uses it any more."""
    conn = get_connection(db, user, conn_id)
    ent = _entity(db, user, entity_id)
    db.execute(delete(GraphBinding).where(GraphBinding.entity_id == ent.id, GraphBinding.connection_id == conn.id))
    if not db.scalar(select(func.count()).where(GraphBinding.entity_id == ent.id)):
        db.delete(ent)
    audit(db, request, user, "graph.entity_removed", conn.name, ent.name)
    db.commit()
    return {"ok": True}
