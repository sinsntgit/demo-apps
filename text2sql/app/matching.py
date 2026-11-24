"""Matching fields across the data models of a combined data model (phase 2 of the metadata graph).

AskData *suggests* pairs of columns in two data models that mean the same thing (SAP KUNNR and CRM sap_no, say) and a
steward confirms, edits or rejects each one. Only confirmed matches are ever used. A match is a GraphEdge with
kind "match" whose two sides are different data models; it belongs to that pair of data models, so every combined
data model containing both uses it.

Signals, from metadata only (nothing is read from the data and nothing is sent to an AI model):
  names         column names compared by their words, abbreviations expanded (no -> number, cust -> customer)
  descriptions  database comments, the Extra DDL field dictionary and documentation notes mentioning the column, and
                the business entities a column is the key of
  types         text / number / date; incompatible types are ruled out
  keys          primary key, key-like name, leading column, or a join key in the data model's own confirmed joins
The optional value-overlap check (off by default, switched on per combined data model) reads up to 10,000 distinct
values of each candidate column on the server - read-only, through the guard, with the user's row filters - and keeps
only percentages and counts. Values are compared in memory and dropped; none are stored, shown or sent anywhere.

Key normalisation comes from a fixed list (NORMALISATIONS). `duck_expr` writes the DuckDB expression for a rule
itself, so nothing typed by a user or a model is ever pasted into SQL.
"""
import logging
import re
from decimal import Decimal, InvalidOperation

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import connectors, graph, rowfilter, security, sqlguard
from .db import now
from .models import CombinedMember, Connection, GraphEdge, TrainingItem

log = logging.getLogger("text2sql.matching")

NORMALISATIONS = {"": "As is", "trim": "Trim spaces", "upper": "Upper case", "lower": "Lower case",
                  "strip_zeros": "Strip leading zeros", "digits": "Digits only", "to_number": "Text to number",
                  "to_text": "Number to text"}
OVERLAP_LIMIT = 10_000          # distinct values read from each side
MAX_PER_PAIR = 40               # suggestions kept per pair of data models
MAX_OVERLAP_CHECKS = 25         # candidate pairs checked against the data per pair of data models
MIN_SCORE = 0.35                # below this a pair rests on one shared description word - too weak to suggest
ABBR = {"no": "number", "nr": "number", "num": "number", "nbr": "number", "cust": "customer", "acct": "account",
        "acc": "account", "mat": "material", "matl": "material", "qty": "quantity", "amt": "amount", "desc": "description",
        "cd": "code", "org": "organisation", "organization": "organisation", "dept": "department", "prod": "product",
        "vend": "vendor", "supp": "supplier", "inv": "invoice", "ord": "order", "doc": "document", "co": "company"}
STOP = {"the", "a", "an", "of", "in", "for", "and", "or", "to", "is", "on", "by", "with", "per", "this", "that", "as", "at",
        "be", "are", "each", "one", "its", "it", "from", "digits", "digit", "e", "g", "eg", "ie", "used", "which", "table",
        "column", "field", "value", "values", "key", "keys", "number", "code", "identifier", "id"}


# ------------------------------------------------------------------------------------------- normalisation
def normalise(rule: str, v):
    """The value as the rule compares it (a string or a Decimal), or None."""
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v)
    if rule == "":
        return s
    s = s.strip()
    if rule in ("trim", "to_text"):
        return s
    if rule == "upper":
        return s.upper()
    if rule == "lower":
        return s.lower()
    if rule == "strip_zeros":
        return (s.lstrip("0") or "0") if s else s
    if rule == "digits":
        d = re.sub(r"\D", "", s)
        return d or None
    if rule == "to_number":
        try:
            return Decimal(s).normalize()
        except (InvalidOperation, ValueError):
            return None
    raise ValueError(f"unknown normalisation {rule!r}")


def duck_expr(rule: str, col_sql: str) -> str:
    """The DuckDB expression for a rule applied to an already-quoted column reference (used to combine results)."""
    t = f"trim(CAST({col_sql} AS VARCHAR))"
    return {"": col_sql, "trim": t, "to_text": t, "upper": f"upper({t})", "lower": f"lower({t})",
            "strip_zeros": f"CASE WHEN {col_sql} IS NULL THEN NULL WHEN {t} = '' THEN '' ELSE coalesce(nullif(ltrim({t}, '0'), ''), '0') END",
            "digits": f"nullif(regexp_replace(CAST({col_sql} AS VARCHAR), '[^0-9]', '', 'g'), '')",
            "to_number": f"TRY_CAST({t} AS DECIMAL(38, 10))"}[rule]


# ------------------------------------------------------------------------------------------- members and metadata
def members(db: Session, combined: Connection) -> list[tuple[CombinedMember, Connection]]:
    rows = db.execute(select(CombinedMember, Connection).join(Connection, Connection.id == CombinedMember.member_id)
                      .where(CombinedMember.combined_id == combined.id).order_by(CombinedMember.position, CombinedMember.id)).all()
    return [(m, c) for m, c in rows if c.company_id == combined.company_id]


def _kind(typ: str) -> str:
    t = (typ or "").lower()
    if re.search(r"date|time", t):
        return "date"
    if re.search(r"bool", t):
        return "bool"
    if re.search(r"float|double|real|decimal|numeric|money", t):
        return "measure"
    if re.search(r"int|number|serial", t):
        return "number"
    return "text"


def _words(text: str) -> set[str]:
    out = set()
    for w in graph.words(text or ""):
        w = ABBR.get(w, w)
        if w not in STOP and len(w) > 1 and not w.isdigit():
            out.add(w)
    return out


def descriptions(db: Session, conn: Connection) -> dict:
    """{(table lower, column lower): text} from column comments, the Extra DDL dictionary and documentation notes,
    and the business entities the column is the key of. Metadata only."""
    tables = graph.tables_of(conn)
    out = {}
    texts = [t.content or "" for t in db.scalars(select(TrainingItem).where(
        TrainingItem.connection_id == conn.id, TrainingItem.status == "approved", TrainingItem.kind.in_(("ddl", "documentation"))))]
    blob = "\n".join(texts)
    for t in {id(x): x for x in tables.values()}.values():
        tname = connectors.table_fqn(t).lower()
        for c in t["columns"]:
            parts = [c.get("comment") or "", t.get("comment") or ""]
            for m in re.finditer(rf"(?<![A-Za-z0-9_]){re.escape(c['name'])}(?![A-Za-z0-9_])", blob):
                tail = blob[m.end():m.end() + 120]
                parts.append(re.split(r"[;\n]", tail.lstrip(" :=-("), maxsplit=1)[0][:100])
                if len(parts) > 6:
                    break
            out[(tname, c["name"].lower())] = " ".join(p for p in parts if p).strip()
    for ent, binds in graph.entities_for(db, conn):
        for b in binds:
            for kc in b.key_columns or []:
                k = (b.table_name.lower(), kc.lower())
                out[k] = (out.get(k, "") + f" {ent.name} " + " ".join(ent.synonyms or [])).strip()
    return out


def _columns(db: Session, conn: Connection) -> list[dict]:
    """Candidate columns of one data model: everything that could be a key."""
    desc = descriptions(db, conn)
    joined = set()
    for e in graph.confirmed_edges(db, conn):
        joined |= {(e.left_table.lower(), c.lower()) for c in e.left_columns}
        joined |= {(e.right_table.lower(), c.lower()) for c in e.right_columns}
    tables = list({id(x): x for x in graph.tables_of(conn).values()}.values())
    has_pk = any(c.get("pk") for t in tables for c in t["columns"])
    out = []
    for t in tables:
        tname = connectors.table_fqn(t)
        for pos, c in enumerate(t["columns"]):
            kind = _kind(c.get("type"))
            if kind in ("bool", "measure") or graph.norm(c["name"]) in graph.GENERIC_NORM:
                continue
            k = (tname.lower(), c["name"].lower())
            keyish = bool(c.get("pk")) or graph.keylike(c["name"], tname) or (not has_pk and pos == 0) or k in joined
            d = desc.get(k, "")
            out.append({"table": tname, "column": c["name"], "kind": kind, "keyish": keyish, "pk": bool(c.get("pk")),
                        "joined": k in joined, "desc": d, "words": _words(c["name"]), "dwords": _words(d) | _words(c["name"]),
                        "name_norm": graph.norm(c["name"]), "t": t})
    return out


def _propose_rule(a: dict, b: dict) -> str:
    text_sap = lambda x: x["kind"] == "text" and (graph.SAP_LIKE.match(x["column"]) or "leading zero" in x["desc"].lower())
    if {a["kind"], b["kind"]} == {"text", "number"}:
        return "strip_zeros" if (text_sap(a) or text_sap(b)) else "to_text"
    if a["kind"] == b["kind"] == "text":
        return "strip_zeros" if (text_sap(a) or text_sap(b)) else "trim"
    return ""


def score(a: dict, b: dict) -> tuple[float, list[str]]:
    """How likely two columns from different data models hold the same thing, from metadata, with the evidence."""
    if a["kind"] == "date" or b["kind"] == "date":
        if a["kind"] != b["kind"]:
            return 0, []
    if not (a["keyish"] or b["keyish"]):
        return 0, []
    why, s = [], 0.0
    if a["name_norm"] == b["name_norm"]:
        s += 0.45
        why.append(f"Same name: '{a['column']}' and '{b['column']}'")
    elif a["words"] and b["words"]:
        j = len(a["words"] & b["words"]) / len(a["words"] | b["words"])
        if j:
            s += 0.4 * j
            why.append(f"Similar names: '{a['column']}' and '{b['column']}'")
    if a["dwords"] and b["dwords"]:
        common = a["dwords"] & b["dwords"]
        j = len(common) / max(1, min(len(a["dwords"]), len(b["dwords"])))
        if common and j >= 0.3:
            s += 0.3 * min(1.0, j)
            why.append("Descriptions share: " + ", ".join(sorted(common)[:5]))
    # a description naming the other column counts only for distinctive names (KUNNR, sap_no) - not plain words like "industry"
    distinctive = lambda x: bool(graph.SAP_LIKE.match(x["column"]) or re.search(r"[_0-9]", x["column"]) or
                                 (graph.keylike(x["column"]) and len(graph.words(x["column"])) > 1))
    ref_a = distinctive(a) and re.search(rf"(?<![A-Za-z0-9_]){re.escape(a['column'])}(?![A-Za-z0-9_])", b["desc"], re.I)
    ref_b = distinctive(b) and re.search(rf"(?<![A-Za-z0-9_]){re.escape(b['column'])}(?![A-Za-z0-9_])", a["desc"], re.I)
    if ref_a or ref_b:
        s += 0.35
        why.append(f"The description of {b['column'] if ref_a else a['column']} names {a['column'] if ref_a else b['column']}")
    if a["keyish"] and b["keyish"]:
        s += 0.12
        why.append("Both look like keys")
    if a["pk"] or b["pk"]:
        s += 0.05
    if a["joined"] or b["joined"]:
        s += 0.05
        why.append("Already used as a join key inside its own data model")
    if a["kind"] != b["kind"]:
        s -= 0.05
        why.append(f"Different types ({a['kind']} and {b['kind']}): compared after a key rule")
    return round(min(max(s, 0), 0.95), 2), why


def candidates(db: Session, conn_a: Connection, conn_b: Connection) -> list[dict]:
    """Best metadata candidates between two data models, at most 3 per column, MAX_PER_PAIR in all."""
    ca, cb = _columns(db, conn_a), _columns(db, conn_b)
    found = []
    for a in ca:
        for b in cb:
            s, why = score(a, b)
            if s >= MIN_SCORE:
                found.append({"a": a, "b": b, "score": s, "why": why, "rule": _propose_rule(a, b)})
    found.sort(key=lambda x: -x["score"])
    per, out = {}, []
    for f in found:
        ka, kb = (f["a"]["table"], f["a"]["column"]), (f["b"]["table"], f["b"]["column"])
        if per.get(ka, 0) >= 3 or per.get(kb, 0) >= 3:
            continue
        per[ka], per[kb] = per.get(ka, 0) + 1, per.get(kb, 0) + 1
        out.append(f)
        if len(out) >= MAX_PER_PAIR:
            break
    return out


# ------------------------------------------------------------------------------------------- the value-overlap check
def _read(db: Session, conn: Connection, user, table: dict, column: str, cfg: dict, cache: dict):
    """Distinct values of one column (cached for this run): guarded, read-only, with the user's row filters, timed out."""
    k = (conn.id, connectors.table_fqn(table).lower(), column.lower())
    if k not in cache:
        sql = connectors.distinct_values_sql(conn, table, column, OVERLAP_LIMIT)
        checked = sqlguard.check(sql, conn.db_type)
        to_run, _ = rowfilter.apply(checked, rowfilter.applicable(db, user, conn), conn.db_type, user)
        res = connectors.run_query(conn, security.decrypt_json(conn.config_enc), to_run, OVERLAP_LIMIT, cfg["query_timeout_s"])
        cache[k] = ([r[0] for r in res["rows"]], bool(res.get("truncated")))
    return cache[k]


def _unique(db: Session, conn: Connection, user, table: dict, column: str, cfg: dict, cache: dict) -> bool:
    """One row per value? (COUNT vs COUNT DISTINCT, guarded and filtered like every query.)"""
    k = ("u", conn.id, connectors.table_fqn(table).lower(), column.lower())
    if k not in cache:
        checked = sqlguard.check(connectors.count_sql(conn, table, column), conn.db_type)
        to_run, _ = rowfilter.apply(checked, rowfilter.applicable(db, user, conn), conn.db_type, user)
        r = connectors.run_query(conn, security.decrypt_json(conn.config_enc), to_run, 1, cfg["query_timeout_s"])["rows"]
        cache[k] = bool(r) and r[0][0] == r[0][1] and r[0][0] > 0
    return cache[k]


def card_of(left_unique: bool, right_unique: bool) -> str:
    return "1:1" if left_unique and right_unique else "1:N" if left_unique else "N:1" if right_unique else ""


def overlap(va: list, vb: list) -> dict:
    """The best key rule and the share of values that match under it. Percentages and counts only."""
    best = None
    for rule in NORMALISATIONS:
        sa = {x for x in (normalise(rule, v) for v in va) if x is not None and x != ""}
        sb = {x for x in (normalise(rule, v) for v in vb) if x is not None and x != ""}
        if not sa or not sb:
            continue
        both = len(sa & sb)
        cand = {"rule": rule, "matched": both, "left_distinct": len(sa), "right_distinct": len(sb),
                "left_pct": round(100 * both / len(sa), 1), "right_pct": round(100 * both / len(sb), 1)}
        key = (max(cand["left_pct"], cand["right_pct"]), rule == "")          # prefer "as is" on a tie
        if best is None or key > best[0]:
            best = (key, cand)
    return best[1] if best else {"rule": "", "matched": 0, "left_distinct": len(set(va)), "right_distinct": len(set(vb)),
                                 "left_pct": 0.0, "right_pct": 0.0}


def _masked(conn: Connection, column: str) -> bool:
    return sqlguard._matches(column, conn.masked_columns or [])


# ------------------------------------------------------------------------------------------- suggest and merge
def find(db: Session, combined: Connection, user, cfg: dict, check_values: bool = False) -> dict:
    """Suggest matches between every pair of the combined model's data models and merge them with what is stored:
    a steward's decision is never overwritten, rejected pairs are not suggested again, undecided suggestions that are no
    longer produced are removed. Returns counts (and how many pairs were checked against the data)."""
    ms = members(db, combined)
    added = updated = removed = checked = 0
    errors = []
    cache = {}
    for i in range(len(ms)):
        for j in range(i + 1, len(ms)):
            a, b = ms[i][1], ms[j][1]
            if a.db_type == "combined" or b.db_type == "combined":
                continue
            graph.ensure(db, a)
            graph.ensure(db, b)
            stored = {}
            for e in db.scalars(select(GraphEdge).where(GraphEdge.kind == "match", (
                    (GraphEdge.left_connection_id == a.id) & (GraphEdge.right_connection_id == b.id)) |
                    ((GraphEdge.left_connection_id == b.id) & (GraphEdge.right_connection_id == a.id)))):
                k = graph.edge_key(e)
                if k in stored:
                    db.delete(e)
                else:
                    stored[k] = e
            known = {k for k, e in stored.items() if e.decided_by is not None or e.origin == "steward"}
            want = {}
            n_checks = 0
            for f in candidates(db, a, b):
                left = {"left_connection_id": a.id, "left_table": f["a"]["table"], "left_columns": [f["a"]["column"]],
                        "right_connection_id": b.id, "right_table": f["b"]["table"], "right_columns": [f["b"]["column"]]}
                k = graph.edge_key(left)
                if k in known or k in want:
                    continue
                stats, conf, why, card = None, f["score"], list(f["why"]), ""
                if check_values and n_checks < MAX_OVERLAP_CHECKS:
                    n_checks += 1
                    side = a
                    try:
                        va, ta = _read(db, a, user, f["a"]["t"], f["a"]["column"], cfg, cache)
                        ua = _unique(db, a, user, f["a"]["t"], f["a"]["column"], cfg, cache)
                        side = b
                        vb, tb = _read(db, b, user, f["b"]["t"], f["b"]["column"], cfg, cache)
                        ub = _unique(db, b, user, f["b"]["t"], f["b"]["column"], cfg, cache)
                        stats = overlap(va, vb)
                        stats.update(left_truncated=ta, right_truncated=tb, checked_at=now().isoformat(), left_unique=ua, right_unique=ub,
                                     masked=_masked(a, f["a"]["column"]) or _masked(b, f["b"]["column"]))
                        best = max(stats["left_pct"], stats["right_pct"])
                        f["rule"] = stats["rule"]
                        card = card_of(ua, ub)
                        if best < 5:              # the data says these are not the same thing: do not suggest it
                            continue
                        if best >= 50:
                            conf = max(conf, round(0.5 + 0.45 * best / 100, 2))
                        why.insert(0, f"{best:g}% of values match ({NORMALISATIONS[stats['rule']].lower()})")
                    except Exception as ex:       # a source that does not answer must not stop the other suggestions
                        errors.append(f"{side.name}: {str(ex)[:160]}")
                        stats = None
                left.update(kind="match", origin="matching", cardinality=card, normalisation=f["rule"], evidence=why[:6],
                            confidence=conf, stats=stats)
                want[k] = left
            checked += n_checks
            for k, e in stored.items():
                w = want.get(k)
                if e.origin == "steward" or e.decided_by is not None:
                    if w and w.get("stats") is not None:
                        e.stats = w["stats"]                # fresh percentages on a decided match are still useful
                    continue
                if w is None:
                    db.delete(e)
                    removed += 1
                    continue
                swapped = e.left_connection_id != w["left_connection_id"]
                e.evidence, e.confidence, e.normalisation = w["evidence"], w["confidence"], w["normalisation"]
                if w["cardinality"]:
                    e.cardinality = graph.FLIP.get(w["cardinality"], w["cardinality"]) if swapped else w["cardinality"]
                if w.get("stats") is not None:
                    e.stats = w["stats"]
                if swapped and e.stats:
                    e.stats = {**e.stats, "left_pct": e.stats["right_pct"], "right_pct": e.stats["left_pct"],
                               "left_distinct": e.stats["right_distinct"], "right_distinct": e.stats["left_distinct"]}
                e.status = "suggested"
                updated += 1
            for k, w in want.items():
                if k in stored:
                    continue
                db.add(GraphEdge(company_id=combined.company_id, status="suggested", **w))
                added += 1
    db.flush()
    return {"added": added, "updated": updated, "removed": removed, "checked": checked, "errors": errors[:5]}


def check_values_of(db: Session, edge: GraphEdge, user, cfg: dict) -> dict:
    """The overlap check for one match (a single column on each side), on request."""
    ca, cb = db.get(Connection, edge.left_connection_id), db.get(Connection, edge.right_connection_id)
    ta, tb = graph.tables_of(ca).get(edge.left_table.lower()), graph.tables_of(cb).get(edge.right_table.lower())
    if not ta or not tb or len(edge.left_columns) != 1:
        raise ValueError("The value check works on single-column matches between tables that exist.")
    cache = {}
    va, xa = _read(db, ca, user, ta, edge.left_columns[0], cfg, cache)
    vb, xb = _read(db, cb, user, tb, edge.right_columns[0], cfg, cache)
    ua = _unique(db, ca, user, ta, edge.left_columns[0], cfg, cache)
    ub = _unique(db, cb, user, tb, edge.right_columns[0], cfg, cache)
    stats = overlap(va, vb)
    stats.update(left_truncated=xa, right_truncated=xb, checked_at=now().isoformat(), left_unique=ua, right_unique=ub,
                 masked=_masked(ca, edge.left_columns[0]) or _masked(cb, edge.right_columns[0]))
    edge.stats = stats
    if edge.decided_by is None and not edge.cardinality:
        edge.cardinality = card_of(ua, ub)
    return stats


def connected(db: Session, combined: Connection) -> bool:
    """True when every data model of the combined model is linked to the others by confirmed matches."""
    ms = [c.id for _, c in members(db, combined)]
    if len(ms) < 2:
        return False
    links = {}
    for e in db.scalars(select(GraphEdge).where(GraphEdge.kind == "match", GraphEdge.status == "confirmed",
                                                GraphEdge.left_connection_id.in_(ms), GraphEdge.right_connection_id.in_(ms))):
        links.setdefault(e.left_connection_id, set()).add(e.right_connection_id)
        links.setdefault(e.right_connection_id, set()).add(e.left_connection_id)
    seen, todo = {ms[0]}, [ms[0]]
    while todo:
        for n in links.get(todo.pop(), ()):
            if n not in seen:
                seen.add(n)
                todo.append(n)
    return seen == set(ms)
