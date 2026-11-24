"""The metadata graph of a data model: business entities, where they are stored, and how tables join.

It holds names, keys and relationships only - never row data. Edges come from:
  1. foreign keys found by the schema sync           -> confirmed automatically   (origin "schema")
  2. JOIN ... ON / USING in approved verified SQL      -> confirmed automatically   (origin "verified_sql")
  3. the same key-like column name in several tables   -> suggested, until a steward confirms (origin "names")
  4. joins a steward adds by hand                      -> confirmed                 (origin "steward")
Only confirmed edges reach the AI model, as a "Join paths" section in the prompt. A steward's decision (confirm, reject,
edit) is never overwritten when the automatic part is rebuilt; rejected pairs are remembered and not suggested again.

The automatic part is rebuilt whenever the schema or the approved examples change (`ensure`, keyed by a fingerprint), so
every path that changes training - approving, importing, a corrected answer, a bundled sample - is covered.
"""
import hashlib
import json
import logging
import re
import threading
from collections import deque

import sqlglot
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session
from sqlglot import exp

from . import connectors, retrieval
from .db import now
from .models import Connection, GraphBinding, GraphEdge, GraphEntity, TrainingItem

log = logging.getLogger("text2sql.graph")
CARDINALITIES = ("", "1:1", "1:N", "N:1")
STATUSES = ("suggested", "confirmed", "rejected")
MAX_SUGGESTIONS = 60            # name-based suggestions kept per data model (best first)
MAX_PROMPT_EDGES = 20
MAX_HOPS = 4
_lock = threading.Lock()

# sqlglot dialect per data-model type (the same names sqlguard uses)
DIALECT = {"postgres": "postgres", "mysql": "mysql", "singlestore": "mysql", "mssql": "tsql", "oracle": "oracle",
           "snowflake": "snowflake", "files": "duckdb", "sqlite": "sqlite"}
GENERIC = {"id", "name", "description", "desc", "status", "type", "comment", "comments", "created_at", "updated_at", "created",
           "updated", "date", "amount", "value", "quantity", "qty", "price", "title", "text", "note", "notes", "email", "phone",
           "city", "country", "currency", "discount", "unit_price", "total", "remarks", "label", "code"}
GENERIC_NORM = set()            # filled below, once norm() exists
KEY_WORDS = {"id", "no", "nr", "num", "number", "code", "key", "cd", "sku", "ref", "uuid", "guid", "pk"}
SAP_LIKE = re.compile(r"^[A-Z]{4,6}$")          # SAP-style field names: KUNNR, MATNR, BUKRS
NOT_KEY_TYPES = re.compile(r"float|double|real|decimal|numeric|money|date|time|bool|json|blob|bytea|binary", re.I)


# ------------------------------------------------------------------------------------------- schema helpers
def words(name: str) -> list[str]:
    """'Customer Code', 'customer_code', 'CustomerCode', 'customerCODE' -> ['customer', 'code']."""
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name.strip())
    return [w for w in re.split(r"[^A-Za-z0-9]+", spaced.lower()) if w]


def norm(name: str) -> str:
    return "".join(words(name))


GENERIC_NORM.update(norm(g) for g in GENERIC)


def keylike(name: str, table: str = "") -> bool:
    """A name that looks like an identifier: ends in id / no / code / key…, is an SAP-style field (KUNNR), or is named
    after its own table (Plant in plants, customer in customer)."""
    w = words(name)
    if not w:
        return False
    t = norm(table.split(".")[-1]) if table else ""
    return w[-1] in KEY_WORDS or bool(SAP_LIKE.match(name.strip())) or (bool(t) and norm(name) in (t, t.rstrip("s"), t[:-2] if t.endswith("es") else t))

def tables_of(conn: Connection) -> dict:
    """{lower-case table name: table dict}; fully qualified and bare names both resolve when unambiguous."""
    out, bare = {}, {}
    for t in (conn.schema_json or {}).get("tables", []):
        out[connectors.table_fqn(t).lower()] = t
        bare.setdefault(t["name"].lower(), []).append(t)
    for name, ts in bare.items():
        if len(ts) == 1:
            out.setdefault(name, ts[0])
    return out


def _col(t: dict, name: str) -> str | None:
    """The column's name as the schema spells it, or None."""
    for c in t["columns"]:
        if c["name"].lower() == name.lower():
            return c["name"]
    return None


def _pk(t: dict) -> set:
    return {c["name"].lower() for c in t["columns"] if c.get("pk")}


def _cardinality(lt: dict, lcols: list, rt: dict, rcols: list) -> str:
    lk = _pk(lt) and set(c.lower() for c in lcols) == _pk(lt)
    rk = _pk(rt) and set(c.lower() for c in rcols) == _pk(rt)
    return "1:1" if lk and rk else "N:1" if rk else "1:N" if lk else ""


def _key(conn_l: int, tl: str, cl: list, conn_r: int, tr: str, cr: list):
    """Order-independent identity of an edge, and whether the sides had to be swapped to get it."""
    a = (conn_l, tl.lower(), tuple(c.lower() for c in cl))
    b = (conn_r, tr.lower(), tuple(c.lower() for c in cr))
    return (a, b, False) if a <= b else (b, a, True)


FLIP = {"1:N": "N:1", "N:1": "1:N"}


# ------------------------------------------------------------------------------------------- automatic edges
def fk_edges(tables: dict) -> list[dict]:
    out = []
    for t in {id(x): x for x in tables.values()}.values():
        for fk in t.get("fks", []):
            ref = tables.get(str(fk.get("ref_table", "")).lower())
            if not ref:
                continue
            out.append({"left_table": connectors.table_fqn(t), "left_columns": list(fk["columns"]),
                        "right_table": connectors.table_fqn(ref), "right_columns": list(fk["ref_columns"]),
                        "kind": "fk", "origin": "schema", "cardinality": "N:1",
                        "evidence": ["Foreign key defined in the database"], "confidence": 1.0})
    return out


def _side(node, alias: dict, sources: list, other=None):
    """(table dict, column name) for one side of an equality: a column, or a column wrapped in a function or CAST
    (TRIM(s.code), CAST(p.plant AS TEXT)). A column without a table prefix is resolved when exactly one of the query's
    tables (other than the opposite side's) has it."""
    if not isinstance(node, exp.Column):
        cols = list(node.find_all(exp.Column)) if isinstance(node, (exp.Func, exp.Cast, exp.Paren)) else []
        if len(cols) != 1:
            return None
        node = cols[0]
    if node.table:
        t = alias.get(node.table.lower())
        return (t, _col(t, node.name)) if t and _col(t, node.name) else None
    cands = [t for t in sources if t is not other and _col(t, node.name)]
    return (cands[0], _col(cands[0], node.name)) if len(cands) == 1 else None


def sql_joins(sql: str, db_type: str, tables: dict) -> list[tuple]:
    """(left table, [cols], right table, [cols]) for every equality between columns of two real tables of this schema:
    JOIN ... ON a.x = b.y [AND ...], JOIN ... USING (...), and joins written in WHERE (FROM a, b WHERE a.x = b.y).
    Aliases are resolved per SELECT; CTEs, sub-queries and literal conditions are ignored."""
    try:
        tree = sqlglot.parse_one(sql, read=DIALECT.get(db_type, "duckdb"))
    except Exception:
        return []
    ctes = {c.alias_or_name.lower() for c in tree.find_all(exp.CTE)}
    found = []
    for sel in tree.find_all(exp.Select):
        frm = sel.args.get("from_") or sel.args.get("from")       # the argument's name differs between sqlglot versions
        joins = sel.args.get("joins") or []
        nodes = ([frm.this] if frm is not None and isinstance(frm.this, exp.Table) else []) + \
                [j.this for j in joins if isinstance(j.this, exp.Table)]
        alias = {}
        for tb in nodes:
            name = (f"{tb.db}.{tb.name}" if tb.db else tb.name).lower()
            if name not in ctes and name in tables:
                alias[tb.alias_or_name.lower()] = tables[name]
        sources = list({id(t): t for t in alias.values()}.values())
        if len(sources) < 2:
            continue
        pairs = {}

        def add(lt, lc, rt, rc):
            if lt is rt:
                return
            k = (id(lt), id(rt))
            if (id(rt), id(lt)) in pairs:              # keep one orientation per table pair
                k, lt, rt, lc, rc = (id(rt), id(lt)), rt, lt, rc, lc
            p = pairs.setdefault(k, [lt, [], rt, []])
            if lc not in p[1] or rc not in p[3]:
                p[1].append(lc)
                p[3].append(rc)

        conds = [j.args.get("on") for j in joins if j.args.get("on") is not None]
        if sel.args.get("where") is not None:
            conds.append(sel.args["where"].this)
        for cond in conds:
            for eq in cond.find_all(exp.EQ):
                if eq.find_ancestor(exp.Select) is not sel:          # inside a sub-query: that SELECT handles it
                    continue
                l = _side(eq.left, alias, sources)
                r = _side(eq.right, alias, sources, other=l[0] if l else None)
                if l and not r:
                    continue
                if r and not l:
                    l = _side(eq.left, alias, sources, other=r[0])
                if l and r:
                    add(l[0], l[1], r[0], r[1])
        seen = [alias.get(nodes[0].alias_or_name.lower())] if nodes else []
        for j in joins:                                    # USING (col): the joined table and an earlier one that has col
            rt = alias.get(j.this.alias_or_name.lower()) if isinstance(j.this, exp.Table) else None
            for col in j.args.get("using") or []:
                lt = next((t for t in seen if t is not None and t is not rt and _col(t, col.name)), None)
                if lt and rt and _col(rt, col.name):
                    add(lt, _col(lt, col.name), rt, _col(rt, col.name))
            seen.append(rt)
        found += [tuple(p) for p in pairs.values()]
    return found


def verified_edges(pairs: list[TrainingItem], db_type: str, tables: dict) -> list[dict]:
    agg = {}
    for p in pairs:
        for lt, lcols, rt, rcols in sql_joins(p.sql or "", db_type, tables):
            (a, b, swapped) = _key(0, connectors.table_fqn(lt), lcols, 0, connectors.table_fqn(rt), rcols)
            if swapped:
                lt, lcols, rt, rcols = rt, rcols, lt, lcols
            e = agg.setdefault((a, b), {"left_table": connectors.table_fqn(lt), "left_columns": list(lcols),
                                        "right_table": connectors.table_fqn(rt), "right_columns": list(rcols),
                                        "kind": "join", "origin": "verified_sql", "cardinality": _cardinality(lt, lcols, rt, rcols),
                                        "evidence": [], "confidence": 1.0, "_n": 0})
            e["_n"] += 1
            q = f"Verified example: {p.question.strip()[:160]}"
            if q not in e["evidence"] and len(e["evidence"]) < 5:
                e["evidence"].append(q)
    for e in agg.values():
        n = e.pop("_n")
        if n > len(e["evidence"]):
            e["evidence"].append(f"Used in {n} verified examples")
    return list(agg.values())


def name_suggestions(tables: dict, known: set, conn_id: int = 0) -> list[dict]:
    """The same key-like column in two tables, where at least one of them holds it as its key: its primary key, or -
    when the database reports no keys at all (files, many warehouses) - one of the table's first two columns. Generic
    names, measures, dates, columns found in more than a quarter of the tables (a language field, say) and columns that
    lead more than three tables (a document number) are left out. Table pairs that already have a join, whatever its
    status, are not suggested again."""
    ts = list({id(x): x for x in tables.values()}.values())
    has_pk = any(c.get("pk") for t in ts for c in t["columns"])
    by_col = {}
    for t in ts:
        for pos, c in enumerate(t["columns"]):
            n = norm(c["name"])
            if not n or n in GENERIC_NORM or NOT_KEY_TYPES.search(c.get("type") or ""):
                continue
            home = bool(c.get("pk")) if has_pk else pos < 2
            by_col.setdefault(n, []).append((t, c, home))
    by_col = {n: hs for n, hs in by_col.items() if any(keylike(c["name"], connectors.table_fqn(t)) for t, c, _ in hs)}
    limit = max(6, int(len(ts) * 0.25))
    linked = {(k[0][1], k[1][1]) for k in known}          # table pairs that already have a join of any status
    out = []
    for n, holders in by_col.items():
        if len(holders) < 2 or len(holders) > limit:
            continue
        homes = [h for h in holders if h[2]]
        if len(homes) > 3:                                  # the leading column of many tables (a document number): too ambiguous
            continue
        for rt, rc, _ in homes:
            for lt, lc, lhome in holders:
                if lt is rt:
                    continue
                k = _key(conn_id, connectors.table_fqn(lt), [lc["name"]], conn_id, connectors.table_fqn(rt), [rc["name"]])[:2]
                if k in known or (k[0][1], k[1][1]) in linked:
                    continue
                known.add(k)
                score = (0.6 if rc.get("pk") else 0.45) + (0.1 if len(holders) <= 3 else 0) + (0.05 if lhome else 0)
                why = [f"Same column name '{lc['name']}' in both tables" if lc["name"] == rc["name"]
                       else f"Same name once spacing and case are ignored: '{lc['name']}' and '{rc['name']}'",
                       f"{rc['name']} is the {'primary key' if rc.get('pk') else 'leading (likely key) column'} of {connectors.table_fqn(rt)}"]
                out.append({"left_table": connectors.table_fqn(lt), "left_columns": [lc["name"]],
                            "right_table": connectors.table_fqn(rt), "right_columns": [rc["name"]],
                            "kind": "join", "origin": "names", "cardinality": _cardinality(lt, [lc["name"]], rt, [rc["name"]]),
                            "evidence": why, "confidence": round(min(score, 0.9), 2)})
    out.sort(key=lambda e: -e["confidence"])
    return out[:MAX_SUGGESTIONS]


# ------------------------------------------------------------------------------------------- build and keep up to date
def _pairs(db: Session, conn_id: int) -> list[TrainingItem]:
    return list(db.scalars(select(TrainingItem).where(TrainingItem.connection_id == conn_id, TrainingItem.kind == "sql_pair",
                                                      TrainingItem.status == "approved").order_by(TrainingItem.id)))


def signature(db: Session, conn: Connection) -> str:
    h = hashlib.sha1(json.dumps(conn.schema_json or {}, sort_keys=True, default=str).encode())
    for p in _pairs(db, conn.id):
        h.update(f"{p.id}:{p.sql}".encode())
    return h.hexdigest()


def diagnose(db: Session, conn: Connection) -> dict:
    """What the automatic part was built from, in words a steward can act on (shown on the Relationships tab)."""
    tables = tables_of(conn)
    approved = _pairs(db, conn.id)
    waiting = db.scalar(select(func.count()).where(TrainingItem.connection_id == conn.id, TrainingItem.kind == "sql_pair",
                                                   TrainingItem.status == "pending"))
    with_joins, unread, unparsed = 0, [], []
    names = {k for k in tables}
    for p in approved:
        try:
            tree = sqlglot.parse_one(p.sql or "", read=DIALECT.get(conn.db_type, "duckdb"))
        except Exception:
            unparsed.append(p.question)
            continue
        if sql_joins(p.sql or "", conn.db_type, tables):
            with_joins += 1
            continue
        used = {(f"{t.db}.{t.name}" if t.db else t.name).lower() for t in tree.find_all(exp.Table)} & names
        if len({id(tables[u]) for u in used}) > 1:              # several tables, but no join we could read
            unread.append(p.question)
    return {"tables": len({id(t) for t in tables.values()}), "foreign_keys": len(fk_edges(tables)), "examples": len(approved),
            "examples_with_joins": with_joins, "examples_waiting": waiting or 0,
            "joins_not_read": [q[:160] for q in unread[:8]], "joins_not_read_count": len(unread),
            "unparsed": [q[:160] for q in unparsed[:5]], "file_based": conn.db_type == "files"}


def edge_key(e) -> tuple:
    g = (lambda k: getattr(e, k)) if isinstance(e, GraphEdge) else e.get
    return _key(g("left_connection_id"), g("left_table"), g("left_columns"), g("right_connection_id"), g("right_table"), g("right_columns"))[:2]


def rebuild(db: Session, conn: Connection) -> dict:
    """Recompute the automatic edges of one data model and merge them with what is stored. Returns counts."""
    with _lock:
        tables = tables_of(conn)
        existing = list(db.scalars(select(GraphEdge).where(GraphEdge.left_connection_id == conn.id,
                                                           GraphEdge.right_connection_id == conn.id)))
        stored = {}
        for e in existing:                                  # one row per pair; drop accidental duplicates
            k = edge_key(e)
            if k in stored:
                db.delete(e)
            else:
                stored[k] = e
        auto = fk_edges(tables) + verified_edges(_pairs(db, conn.id), conn.db_type, tables)
        want = {}
        for e in auto:
            e.update(left_connection_id=conn.id, right_connection_id=conn.id)
            want.setdefault(edge_key(e), e)                 # a foreign key wins over the same join in verified SQL
        # pairs a steward decided on (or added) are never suggested again; undecided automatic rows are simply re-derived
        known = {k for k, e in stored.items() if e.decided_by is not None or e.origin == "steward"} | set(want)
        for e in name_suggestions(tables, set(known), conn.id):
            e.update(left_connection_id=conn.id, right_connection_id=conn.id)
            want.setdefault(edge_key(e), e)
        added = updated = removed = 0
        for k, e in stored.items():
            w = want.get(k)
            if e.origin == "steward":
                continue
            if w is None:
                if e.decided_by is None or e.status == "suggested":
                    db.delete(e)                            # no longer produced and nobody decided on it
                    removed += 1
                continue
            swapped = (w["left_table"].lower(), [c.lower() for c in w["left_columns"]]) != (e.left_table.lower(), [c.lower() for c in e.left_columns])
            e.evidence, e.confidence, e.kind = w["evidence"], w["confidence"], w["kind"]
            if e.decided_by is None:
                e.origin = w["origin"]
                e.status = "suggested" if w["origin"] == "names" else "confirmed"
                e.cardinality = FLIP.get(w["cardinality"], w["cardinality"]) if swapped else w["cardinality"]
            updated += 1
        for k, w in want.items():
            if k in stored:
                continue
            db.add(GraphEdge(company_id=conn.company_id, left_connection_id=conn.id, left_table=w["left_table"],
                             left_columns=w["left_columns"], right_connection_id=conn.id, right_table=w["right_table"],
                             right_columns=w["right_columns"], kind=w["kind"], cardinality=w["cardinality"], origin=w["origin"],
                             status="suggested" if w["origin"] == "names" else "confirmed", evidence=w["evidence"],
                             confidence=w["confidence"]))
            added += 1
        conn.graph_signature = signature(db, conn)
        db.flush()
        return {"added": added, "updated": updated, "removed": removed}


def ensure(db: Session, conn: Connection) -> bool:
    """Rebuild when the schema or the approved examples changed since the last build. True when it rebuilt."""
    if conn.graph_signature == signature(db, conn):
        return False
    rebuild(db, conn)
    return True


def refresh(db: Session, conn: Connection) -> None:
    """`ensure` as a step of its own: commits when it rebuilt, and never lets a graph problem stop a question.
    Call it before anything else is written in the request (the ask route does)."""
    try:
        if ensure(db, conn):
            db.commit()
    except Exception:
        log.exception("metadata graph rebuild failed for data model #%s", conn.id)
        db.rollback()


def forget(db: Session, conn_id: int):
    """Remove a data model's graph rows (when the data model is deleted; SQLite cascades do the same)."""
    db.execute(delete(GraphEdge).where((GraphEdge.left_connection_id == conn_id) | (GraphEdge.right_connection_id == conn_id)))
    db.execute(delete(GraphBinding).where(GraphBinding.connection_id == conn_id))


# ------------------------------------------------------------------------------------------- paths and the prompt
def confirmed_edges(db: Session, conn: Connection) -> list[GraphEdge]:
    return list(db.scalars(select(GraphEdge).where(GraphEdge.left_connection_id == conn.id, GraphEdge.right_connection_id == conn.id,
                                                   GraphEdge.status == "confirmed").order_by(GraphEdge.id)))


def shortest_path(edges: list[GraphEdge], a: str, b: str, max_hops: int = MAX_HOPS) -> list[GraphEdge] | None:
    """Fewest confirmed joins from table a to table b (breadth-first; the graph is small)."""
    a, b = a.lower(), b.lower()
    if a == b:
        return []
    adj = {}
    for e in edges:
        adj.setdefault(e.left_table.lower(), []).append((e.right_table.lower(), e))
        adj.setdefault(e.right_table.lower(), []).append((e.left_table.lower(), e))
    prev, todo = {a: None}, deque([(a, 0)])
    while todo:
        node, d = todo.popleft()
        if node == b:
            break
        if d >= max_hops:
            continue
        for nxt, e in adj.get(node, []):
            if nxt not in prev:
                prev[nxt] = (node, e)
                todo.append((nxt, d + 1))
    if b not in prev:
        return None
    path, node = [], b
    while prev[node]:
        node, e = prev[node][0], prev[node][1]
        path.append(e)
    return list(reversed(path))


def entities_for(db: Session, conn: Connection) -> list[tuple[GraphEntity, list[GraphBinding]]]:
    rows = list(db.execute(select(GraphEntity, GraphBinding).join(GraphBinding, GraphBinding.entity_id == GraphEntity.id)
                           .where(GraphBinding.connection_id == conn.id, GraphEntity.company_id == conn.company_id)
                           .order_by(GraphEntity.name, GraphBinding.id)).all())
    out = {}
    for ent, b in rows:
        out.setdefault(ent.id, (ent, []))[1].append(b)
    return list(out.values())


def join_text(e: GraphEdge) -> str:
    on = " AND ".join(f"{e.left_table}.{l} = {e.right_table}.{r}" for l, r in zip(e.left_columns, e.right_columns))
    return on + (f"  ({e.cardinality})" if e.cardinality else "")


def prompt_section(db: Session, conn: Connection, question: str, seed_tables: list[str]) -> dict:
    """What the graph adds to the prompt for this question: the entities it mentions and the confirmed join paths between
    the tables involved. Returns {"text", "tables", "edges", "entities"}; empty text when the graph has nothing to add."""
    edges = confirmed_edges(db, conn)
    ents = entities_for(db, conn)
    hit = retrieval.top(question, ents, lambda x: " ".join([x[0].name, *x[0].synonyms, x[0].description]), 5) if ents else []
    seeds = []
    for ent, binds in hit:
        seeds += [b.table_name for b in binds]
    seeds += seed_tables
    seen, order = set(), []
    for t in seeds:
        if t.lower() not in seen:
            seen.add(t.lower())
            order.append(t)
    chosen, tables = [], list(order[:1])
    for t in order[1:]:                                     # connect every seed to the first one through confirmed joins
        best = None
        for anchor in tables:
            p = shortest_path(edges, anchor, t)
            if p is not None and (best is None or len(p) < len(best)):
                best = p
        if best is None:
            continue
        for e in best:
            if e not in chosen:
                chosen.append(e)
            for side in (e.left_table, e.right_table):
                if side.lower() not in {x.lower() for x in tables}:
                    tables.append(side)
    chosen = chosen[:MAX_PROMPT_EDGES]
    lines = []
    if hit:
        lines.append("Business entities in the question:")
        for ent, binds in hit:
            also = f" (also called: {', '.join(ent.synonyms)})" if ent.synonyms else ""
            where = "; ".join(f"{b.table_name}" + (f" (key {', '.join(b.key_columns)})" if b.key_columns else "") for b in binds)
            lines.append(f"- {ent.name}{also}: {where}" + (f" - {ent.description}" if ent.description else ""))
    if chosen:
        if lines:
            lines.append("")
        lines.append("Confirmed ways to join the tables involved - use these join keys" + (
            " (N:1 means many rows on the left for one on the right; total before joining to avoid double counting):"
            if any(e.cardinality for e in chosen) else ":"))
        lines += [f"- {join_text(e)}" for e in chosen]
    return {"text": "\n".join(lines), "tables": tables if chosen else [b.table_name for _, bs in hit for b in bs],
            "edges": [e.id for e in chosen], "entities": [ent.name for ent, _ in hit]}
