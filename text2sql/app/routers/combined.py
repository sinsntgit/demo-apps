"""Combined data models: two or more data models answered together (phase 2: set-up and matching fields;
asking questions of them arrives in phase 3). Administrators and stewards; every lookup is company-checked."""
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .. import connectors, graph, matching, security
from ..db import get_db, now
from ..deps import audit, can_use, get_connection, get_settings, steward_up
from ..models import CombinedMember, Connection, GraphEdge, User
from .graph import _edge_dto

router = APIRouter(prefix="/api/combined", tags=["combined"])
ALIAS = re.compile(r"^[a-z][a-z0-9_]{0,19}$")


class MemberIn(BaseModel):
    id: int
    alias: str


class CombinedIn(BaseModel):
    name: str
    description: str = ""
    members: list[MemberIn]
    overlap_check: bool = False
    is_active: bool = True


class MatchIn(BaseModel):
    left_member: int
    left_table: str
    left_columns: list[str]
    right_member: int
    right_table: str
    right_columns: list[str]
    normalisation: str = ""
    cardinality: str = ""


def _combined(db: Session, user: User, cid: int) -> Connection:
    c = get_connection(db, user, cid)                 # company + access to the combined model and every member
    if c.db_type != "combined":
        raise HTTPException(404, "Not found")
    return c


def _cfg(c: Connection) -> dict:
    return security.decrypt_json(c.config_enc) if c.config_enc else {}


def _validate(db: Session, user: User, body: CombinedIn, own_id: int | None = None) -> list[tuple[Connection, str]]:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Give the combined data model a name, for example “SAP + CRM”.")
    if db.scalar(select(Connection.id).where(Connection.company_id == user.company_id, func.lower(Connection.name) == name.lower(),
                                             Connection.id != (own_id or 0))):
        raise HTTPException(400, "A data model with this name already exists.")
    limit = get_settings(db, user.company_id)["combined_max_sources"]
    if not 2 <= len(body.members) <= limit:
        raise HTTPException(400, f"Pick between 2 and {limit} data models to combine.")
    out, aliases, ids = [], set(), set()
    for m in body.members:
        conn = db.get(Connection, m.id)
        if not conn or not can_use(db, user, conn):          # another company's data model does not exist for this user
            raise HTTPException(400, "One of the chosen data models was not found.")
        if conn.db_type == "combined" or conn.id == own_id:
            raise HTTPException(400, f"“{conn.name}” is itself a combined data model; combined models cannot be nested.")
        if conn.id in ids:
            raise HTTPException(400, f"“{conn.name}” is chosen twice.")
        alias = m.alias.strip().lower()
        if not ALIAS.match(alias):
            raise HTTPException(400, f"The short name for “{conn.name}” must start with a letter and use only lower-case letters, digits "
                                     "and _ (up to 20), for example sap or crm.")
        if alias in aliases:
            raise HTTPException(400, f"The short name “{alias}” is used twice.")
        ids.add(conn.id)
        aliases.add(alias)
        out.append((conn, alias))
    return out


def _match_edges(db: Session, ids: list[int]):
    return list(db.scalars(select(GraphEdge).where(GraphEdge.kind == "match", GraphEdge.left_connection_id.in_(ids),
                                                   GraphEdge.right_connection_id.in_(ids))
                           .order_by(GraphEdge.status, GraphEdge.confidence.desc(), GraphEdge.id)))


def view(db: Session, c: Connection) -> dict:
    ms = matching.members(db, c)
    alias = {conn.id: m.alias for m, conn in ms}
    ids = list(alias)
    cfg = _cfg(c)
    label = lambda cid, t: f"{alias.get(cid, '?')}.{t}"
    tables, edges = [], []
    for m, conn in ms:
        tables += [{"name": label(conn.id, connectors.table_fqn(t)), "member": conn.id,
                    "columns": [{"name": col["name"], "type": col.get("type") or "", "pk": bool(col.get("pk"))} for col in t["columns"]]}
                   for t in (conn.schema_json or {}).get("tables", [])]
        for e in graph.confirmed_edges(db, conn):            # each data model's own confirmed joins, for the diagram
            d = _edge_dto(e)
            edges.append({**d, "left_table": label(conn.id, e.left_table), "right_table": label(conn.id, e.right_table), "inside": True})
    matches = []
    for e in _match_edges(db, ids):
        d = _edge_dto(e)
        d.update(left_table=label(e.left_connection_id, e.left_table), right_table=label(e.right_connection_id, e.right_table),
                 left_member=e.left_connection_id, right_member=e.right_connection_id, raw_left_table=e.left_table,
                 raw_right_table=e.right_table, normalisation=e.normalisation, normalisation_label=matching.NORMALISATIONS.get(e.normalisation, ""),
                 stats=e.stats, kind="match")
        matches.append(d)
    return {"id": c.id, "name": c.name, "description": c.description, "is_active": c.is_active, "overlap_check": bool(cfg.get("overlap_check")),
            "notice": cfg.get("notice", ""), "members": [{"id": conn.id, "name": conn.name, "alias": m.alias, "db_label": connectors.DB_TYPES[conn.db_type]["label"],
                                                         "table_count": len((conn.schema_json or {}).get("tables", [])), "is_active": conn.is_active}
                                                        for m, conn in ms],
            "normalisations": matching.NORMALISATIONS, "tables": tables, "edges": edges + matches, "matches": matches,
            "counts": {s: sum(1 for e in matches if e["status"] == s) for s in graph.STATUSES},
            "ready": matching.connected(db, c)}


def _save_members(db: Session, c: Connection, chosen: list[tuple[Connection, str]]):
    db.execute(delete(CombinedMember).where(CombinedMember.combined_id == c.id))
    db.flush()
    for i, (conn, alias) in enumerate(chosen):
        db.add(CombinedMember(company_id=c.company_id, combined_id=c.id, member_id=conn.id, alias=alias, position=i))
    db.flush()


@router.post("")
def create(body: CombinedIn, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    chosen = _validate(db, user, body)
    c = Connection(company_id=user.company_id, name=body.name.strip(), description=body.description.strip(), db_type="combined",
                   config_enc=security.encrypt_json({"overlap_check": bool(body.overlap_check)}), is_active=True, created_by=user.id)
    db.add(c)
    db.flush()
    _save_members(db, c, chosen)
    out = matching.find(db, c, user, get_settings(db, user.company_id), check_values=False)      # names and descriptions only, quickly
    audit(db, request, user, "combined.created", c.name, ", ".join(f"{a}={m.name}" for m, a in chosen) + f"; {out['added']} suggested matches")
    db.commit()
    return view(db, c)


@router.get("/{cid}")
def get(cid: int, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    c = _combined(db, user, cid)
    return view(db, c)


@router.put("/{cid}")
def update(cid: int, body: CombinedIn, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    c = _combined(db, user, cid)
    chosen = _validate(db, user, body, own_id=c.id)
    cfg = _cfg(c)
    if bool(body.overlap_check) != bool(cfg.get("overlap_check")):
        audit(db, request, user, "combined.overlap_" + ("enabled" if body.overlap_check else "disabled"), c.name)
    before = {conn.id for _, conn in matching.members(db, c)}
    c.name, c.description, c.is_active = body.name.strip(), body.description.strip(), body.is_active
    cfg["overlap_check"] = bool(body.overlap_check)
    if {conn.id for conn, _ in chosen} != before:
        cfg.pop("notice", None)                    # the members were fixed
    c.config_enc = security.encrypt_json(cfg)
    _save_members(db, c, chosen)
    if {conn.id for conn, _ in chosen} - before:
        matching.find(db, c, user, get_settings(db, user.company_id), check_values=False)
    audit(db, request, user, "combined.updated", c.name, ", ".join(f"{a}={m.name}" for m, a in chosen))
    db.commit()
    return view(db, c)


@router.delete("/{cid}")
def remove(cid: int, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    """Deletes the combined model only: its data models, their training and the matches between them stay."""
    c = _combined(db, user, cid)
    audit(db, request, user, "combined.deleted", c.name)
    db.delete(c)
    db.commit()
    return {"ok": True}


@router.post("/{cid}/find-matches")
def find_matches(cid: int, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    c = _combined(db, user, cid)
    overlap = bool(_cfg(c).get("overlap_check"))
    out = matching.find(db, c, user, get_settings(db, user.company_id), check_values=overlap)
    audit(db, request, user, "combined.matches_found", c.name,
          f"{out['added']} new, {out['removed']} removed" + (f"; values checked locally for {out['checked']} pairs" if overlap else ""))
    db.commit()
    return {**view(db, c), "result": out}


@router.post("/{cid}/matches")
def add_match(cid: int, body: MatchIn, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    from .graph import _check_side
    c = _combined(db, user, cid)
    ms = {conn.id: conn for _, conn in matching.members(db, c)}
    if body.left_member not in ms or body.right_member not in ms or body.left_member == body.right_member:
        raise HTTPException(400, "A match links two different data models of this combined model.")
    if body.normalisation not in matching.NORMALISATIONS:
        raise HTTPException(400, "Unknown key rule.")
    if body.cardinality not in graph.CARDINALITIES:
        raise HTTPException(400, "Unknown cardinality.")
    a, b = ms[body.left_member], ms[body.right_member]
    lt, lc = _check_side(a, body.left_table, body.left_columns)
    rt, rc = _check_side(b, body.right_table, body.right_columns)
    if len(lc) != len(rc):
        raise HTTPException(400, "Pick the same number of columns on both sides (they are matched in order).")
    k = graph._key(a.id, lt, lc, b.id, rt, rc)[:2]
    for e in _match_edges(db, [a.id, b.id]):
        if graph.edge_key(e) == k:
            same = e.left_connection_id == a.id
            e.status, e.decided_by, e.decided_at, e.normalisation = "confirmed", user.id, now(), body.normalisation
            if body.cardinality:
                e.cardinality = body.cardinality if same else graph.FLIP.get(body.cardinality, body.cardinality)
            audit(db, request, user, "graph.match_confirmed", c.name, graph.join_text(e))
            db.commit()
            return view(db, c)
    e = GraphEdge(company_id=c.company_id, left_connection_id=a.id, left_table=lt, left_columns=lc, right_connection_id=b.id,
                  right_table=rt, right_columns=rc, kind="match", cardinality=body.cardinality, normalisation=body.normalisation,
                  origin="steward", status="confirmed", evidence=[f"Added by {user.name or user.email}"], confidence=1.0,
                  decided_by=user.id, decided_at=now())
    db.add(e)
    audit(db, request, user, "graph.match_added", c.name, f"{a.name}: {graph.join_text(e)} / {b.name} ({matching.NORMALISATIONS[e.normalisation]})")
    db.commit()
    return view(db, c)


@router.post("/{cid}/matches/{edge_id}/check")
def check_match(cid: int, edge_id: int, request: Request, user: User = Depends(steward_up), db: Session = Depends(get_db)):
    """Run the value-overlap check on one match (needs the check switched on for this combined model)."""
    c = _combined(db, user, cid)
    if not _cfg(c).get("overlap_check"):
        raise HTTPException(400, "Switch on “Check values” for this combined data model first (Edit).")
    ids = [conn.id for _, conn in matching.members(db, c)]
    e = db.get(GraphEdge, edge_id)
    if not e or e.kind != "match" or e.company_id != user.company_id or e.left_connection_id not in ids or e.right_connection_id not in ids:
        raise HTTPException(404, "Not found")
    try:
        stats = matching.check_values_of(db, e, user, get_settings(db, user.company_id))
    except (ValueError, connectors.ConnectorError) as ex:
        raise HTTPException(400, str(ex))
    audit(db, request, user, "combined.overlap_checked", c.name, f"{graph.join_text(e)}: {max(stats['left_pct'], stats['right_pct'])}%")
    db.commit()
    return view(db, c)
