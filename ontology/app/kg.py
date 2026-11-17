"""Knowledge graphs: an ontology filled with the rows of its data sources.

A *mapping* says, for each class, which table holds its records (with the column that identifies a record and the
column that names it, optionally only the rows where a column has a given value); which column holds each
attribute; which join each relationship follows; and which code column holds a controlled value. It is proposed by
the AI or matched by names, and always checked here (`clean_mapping`) against the current ontology and the profiled
tables before it is stored - anything that does not exist is dropped and reported. People review it.

`build` reads the mapped rows - read-only, with SELECTs built by SQLAlchemy Core, at most `graph_rows_per_table`
rows per table - and loads them, together with the ontology itself, into an embedded store (pyoxigraph) in
data/graphs/<folder>. A record is typed with its class and every ancestor class, and inverse relationships are
added, so queries need no reasoner. A new build goes into a new folder; the old one is removed afterwards.

Queries run in a separate process with a time limit (kg_worker.py) on the store opened read-only: SELECT, ASK,
CONSTRUCT and DESCRIBE only; SERVICE (calling other servers) is refused.

Who sees data: the rows of a graph are shown only to people who may use every data source it was built from
(`data_access`). Query results are never sent to an AI model.
"""
import datetime as dt
import decimal
import gc
import hashlib
import json
import logging
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import quote

from sqlalchemy import select

from . import config, onto, profiling
from . import datasources as dsrc
from .db import now
from .models import DataSource, DataSourceItem, KnowledgeGraph, OntologyDataSource

log = logging.getLogger("ontostudio")

RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
XSD = "http://www.w3.org/2001/XMLSchema#"
WORKER = Path(__file__).with_name("kg_worker.py")
MAX_MAPS = 400
MAX_TRIPLES = 3_000_000
CONSOLE_ROWS = 500            # rows shown for a query typed in the console
TEST_ROWS = 200               # rows kept with a test-bed result
PICTURE_RECORDS = 20          # records of the answer drawn in its picture (plus up to 15 records they link to)
_queries = threading.BoundedSemaphore(4)


class GraphError(Exception):
    """A problem with a message for the user."""


# ---- where the data is ---------------------------------------------------------------------------
def record(db, oid: int, create: bool = False) -> KnowledgeGraph | None:
    rec = db.scalar(select(KnowledgeGraph).where(KnowledgeGraph.ontology_id == oid))
    if not rec and create:
        rec = KnowledgeGraph(ontology_id=oid, mapping={"maps": []}, stats={}, sources=[])
        db.add(rec)
        db.flush()
    return rec


def linked(db, oid: int) -> list[DataSource]:
    ids = db.scalars(select(OntologyDataSource.data_source_id).where(OntologyDataSource.ontology_id == oid).order_by(OntologyDataSource.id))
    return [d for d in (db.get(DataSource, i) for i in ids) if d]


def data_access(db, user, ds_ids) -> list[str]:
    """Names of the data sources (of `ds_ids`) this person may NOT use. Empty list = they may see the data."""
    blocked = []
    for i in dict.fromkeys(ds_ids or []):
        ds = db.get(DataSource, i)
        if ds and not dsrc.level(db, user, ds):
            blocked.append(ds.name)
    return blocked


def catalogue(db, oid: int) -> list[dict]:
    """The tables of the ontology's data sources, as the mapping sees them: structure only (no values)."""
    out = []
    for ds in linked(db, oid):
        for i in db.scalars(select(DataSourceItem).where(DataSourceItem.data_source_id == ds.id, DataSourceItem.kind == "table")
                            .order_by(DataSourceItem.name)):
            p = i.profile or {}
            out.append({"source": ds.id, "source_name": ds.name, "item": i.id, "table": i.name, "file": i.file_name,
                        "rows": p.get("row_count"), "readable": ds.kind == "database" or dsrc.stored_path(i) is not None,
                        "columns": [{"name": c["name"], "type": c.get("type", ""), "role": c.get("role", ""), "personal": bool(c.get("personal")),
                                     "ref": c.get("ref", ""), "pk": bool(c.get("pk"))} for c in p.get("columns", [])]})
    return out


# ---- the mapping ---------------------------------------------------------------------------------
def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _fits(ix, cls: str, prop: dict) -> bool:
    """A property applies to a class if its domain is that class or one of its ancestors."""
    return prop["domain"] == cls or prop["domain"] in onto.ancestors(ix, cls)


def _is_a(ix, cls: str, other: str) -> bool:
    return cls == other or other in onto.ancestors(ix, cls)


def _pairs(v, value_key: str) -> list:
    """{"prop": "col"} or [{"property": .., value_key: ..}] -> [(prop, value)]"""
    if isinstance(v, dict):
        return [(k, x) for k, x in v.items()]
    return [(x.get("property"), x.get(value_key)) for x in v if isinstance(x, dict)] if isinstance(v, list) else []


def clean_mapping(c: dict, raw: dict, tables: list) -> tuple[dict, list]:
    """Rebuild a mapping field by field against the ontology and the tables. -> (mapping, problems)"""
    ix = onto.index(c)
    raw = raw if isinstance(raw, dict) else {}
    by_item = {t["item"]: t for t in tables}
    by_name, names = {}, {t["source_name"].lower(): t["source"] for t in tables}
    for t in tables:
        by_name.setdefault((t["source"], t["table"].lower()), t)
        by_name.setdefault((None, t["table"].lower()), t)
    problems: list[str] = []

    def table(item, source, name):
        t = by_item.get(_int(item))
        src = _int(source) if _int(source) is not None else names.get(onto.s(source, 255).lower())
        if t and (src is None or src == t["source"]):
            return t
        name = onto.s(name, 500).lower()
        return by_name.get((src, name)) or by_name.get((None, name)) if name else None

    def col(t, name):
        """'' = not given, None = no such column"""
        name = onto.s(name, 300)
        if not name:
            return ""
        exact = [x["name"] for x in t["columns"] if x["name"] == name] or [x["name"] for x in t["columns"] if x["name"].lower() == name.lower()]
        return exact[0] if exact else None

    maps, seen = [], set()
    raw_maps = raw.get("maps") if isinstance(raw.get("maps"), list) else []
    for n, m in enumerate(raw_maps[:MAX_MAPS]):
        if not isinstance(m, dict):
            continue
        cls = onto.s(m.get("class"), 120)
        if cls not in ix["classes"]:
            problems.append(f"Left out a mapping for “{cls or '?'}”: there is no such class in the ontology.")
            continue
        t = table(m.get("item"), m.get("source"), m.get("table"))
        if not t:
            problems.append(f"Left out the mapping of {cls}: table “{onto.s(m.get('table'), 200) or '?'}” is not in this ontology's data sources.")
            continue
        key, lab = col(t, m.get("key")), col(t, m.get("label"))
        if key is None:
            problems.append(f"{cls}: column “{m.get('key')}” is not in {t['table']}; records are numbered by row instead.")
            key = ""
        if lab is None:
            problems.append(f"{cls}: name column “{m.get('label')}” is not in {t['table']}; left out.")
            lab = ""
        w = m.get("where") if isinstance(m.get("where"), dict) else {"column": m.get("where_column"), "value": m.get("where_value")}
        wc = col(t, w.get("column"))
        wv = onto.s(w.get("value"), 200)
        if wc is None or (wc and not wv):
            problems.append(f"{cls}: the row filter on {t['table']} was left out (unknown column or no value).")
            wc, wv = "", ""
        sig = (cls, t["item"], wc, wv.lower())
        if sig in seen:
            problems.append(f"{cls}: {t['table']} was mapped twice; the second mapping was left out.")
            continue
        seen.add(sig)
        mid = onto.s(m.get("id"), 20)
        if not re.fullmatch(r"m\d{1,5}", mid) or any(x["id"] == mid for x in maps):
            mid = ""
        maps.append({"id": mid, "class": cls, "source": t["source"], "item": t["item"], "table": t["table"], "file": t["file"],
                     "key": key, "label": lab, "where": {"column": wc, "value": wv}, "ai": bool(m.get("ai")), "_raw": m, "_t": t})
    used = {int(x["id"][1:]) for x in maps if x["id"]}
    nxt = 1
    for x in maps:
        if not x["id"]:
            while nxt in used:
                nxt += 1
            x["id"] = f"m{nxt}"
            used.add(nxt)
    by_id = {x["id"]: x for x in maps}
    # what raw ids the caller used may differ from the ids given here: links name their target by raw id or by class
    raw_ids = {onto.s(x["_raw"].get("id"), 20): x["id"] for x in maps if x["_raw"].get("id")}

    for x in maps:
        t, m, cls = x["_t"], x["_raw"], x["class"]
        attrs, done = [], set()
        for pid, cname in _pairs(m.get("attributes"), "column"):
            p = ix["props"].get(onto.s(pid, 120))
            if not p or p["kind"] != "data" or not _fits(ix, cls, p) or p["id"] in done:
                if p is None or (p and p["id"] not in done):
                    problems.append(f"{cls}: attribute “{pid}” left out (not a data property of {cls}).")
                continue
            cc = col(t, cname)
            if not cc:
                problems.append(f"{cls}.{p['id']}: column “{cname}” is not in {t['table']}; left out.")
                continue
            attrs.append({"property": p["id"], "column": cc})
            done.add(p["id"])
        values = []
        for pid, cname in _pairs(m.get("values"), "column"):
            p = ix["props"].get(onto.s(pid, 120))
            if not p or p["kind"] != "object" or not _fits(ix, cls, p) or p["id"] in done:
                problems.append(f"{cls}: controlled value “{pid}” left out (not a relationship of {cls}).")
                continue
            if not any(i["type"] == p["range"] or _is_a(ix, i["type"], p["range"]) for i in c["individuals"]):
                problems.append(f"{cls}.{p['id']}: {p['range']} has no controlled values in the ontology to match the column against; left out.")
                continue
            cc = col(t, cname)
            if not cc:
                problems.append(f"{cls}.{p['id']}: column “{cname}” is not in {t['table']}; left out.")
                continue
            values.append({"property": p["id"], "column": cc})
            done.add(p["id"])
        links = []
        for ln in m.get("links") if isinstance(m.get("links"), list) else []:
            if not isinstance(ln, dict):
                continue
            p = ix["props"].get(onto.s(ln.get("property"), 120))
            if not p or p["kind"] != "object" or not _fits(ix, cls, p):
                problems.append(f"{cls}: relationship “{ln.get('property')}” left out (not a relationship of {cls}).")
                continue
            to = by_id.get(raw_ids.get(onto.s(ln.get("to"), 20), ""))
            if not to:                                        # named by class (and table) instead of by mapping id
                want_cls = onto.s(ln.get("to_class"), 120) or p["range"]
                want_t = onto.s(ln.get("to_table"), 500).lower()
                cands = [y for y in maps if y["class"] == want_cls and (not want_t or y["table"].lower() == want_t)] or \
                        [y for y in maps if _is_a(ix, y["class"], p["range"]) and (not want_t or y["table"].lower() == want_t)]
                to = cands[0] if cands else None
            if not to or not _is_a(ix, to["class"], p["range"]):
                problems.append(f"{cls}.{p['id']}: the records it points to ({p['range']}) are not mapped to a table; left out.")
                continue
            side = ln.get("side") if ln.get("side") in ("from", "to", "link") else "from"
            out = {"property": p["id"], "to": to["id"], "side": side, "column": "", "link_item": None, "link_table": "", "to_column": ""}
            if side == "from":
                cc = col(t, ln.get("column"))
                if not cc:
                    problems.append(f"{cls}.{p['id']}: column “{ln.get('column')}” is not in {t['table']}; left out.")
                    continue
                if not to["key"]:
                    problems.append(f"{cls}.{p['id']}: {to['class']} has no identifying column, so nothing can point to its records; left out.")
                    continue
                out["column"] = cc
            elif side == "to":
                cc = col(to["_t"], ln.get("column"))
                if not cc:
                    problems.append(f"{cls}.{p['id']}: column “{ln.get('column')}” is not in {to['table']}; left out.")
                    continue
                if not x["key"]:
                    problems.append(f"{cls}.{p['id']}: {cls} has no identifying column for {to['table']} to point to; left out.")
                    continue
                out["column"] = cc
            else:
                lt = table(ln.get("link_item"), ln.get("link_source"), ln.get("link_table"))
                a, b = (col(lt, ln.get("column")), col(lt, ln.get("to_column"))) if lt else (None, None)
                if not lt or not a or not b or not x["key"] or not to["key"]:
                    problems.append(f"{cls}.{p['id']}: the link table or its two columns were not found (or a side has no identifying column); left out.")
                    continue
                out.update(column=a, link_item=lt["item"], link_table=lt["table"], to_column=b)
            if any(y["property"] == out["property"] and y["to"] == out["to"] for y in links):
                continue
            links.append(out)
        x.update(attributes=attrs, values=values, links=links)
    for x in maps:
        x.pop("_raw", None)
        x.pop("_t", None)
    return {"maps": maps}, problems


def merge(old: dict, new: dict, replace_drafts: bool = False) -> dict:
    """A proposal (AI or matched by names) added to an existing mapping. What people confirmed is kept;
    proposed additions to it make it a draft again (to be checked)."""
    keep = [json.loads(json.dumps(m)) for m in (old or {}).get("maps", []) if not (replace_drafts and m.get("ai"))]
    nums = [int(m["id"][1:]) for m in keep if re.fullmatch(r"m\d+", m.get("id", ""))]
    nxt = max(nums, default=0) + 1
    idmap = {}
    for m in (new or {}).get("maps", []):
        same = next((k for k in keep if k["class"] == m["class"] and k["item"] == m["item"] and k["where"] == m["where"]), None)
        if same:
            idmap[m["id"]] = same["id"]
        else:
            idmap[m["id"]] = f"m{nxt}"
            nxt += 1
    for m in (new or {}).get("maps", []):
        same = next((k for k in keep if k["id"] == idmap[m["id"]]), None)
        links = [{**ln, "to": idmap.get(ln["to"], ln["to"])} for ln in m.get("links", [])]
        if same:
            have = {a["property"] for a in same["attributes"]} | {v["property"] for v in same["values"]} | {ln["property"] for ln in same["links"]}
            add = [a for a in m["attributes"] if a["property"] not in have], [v for v in m["values"] if v["property"] not in have], \
                  [ln for ln in links if ln["property"] not in have]
            if any(add):
                same["attributes"] += add[0]; same["values"] += add[1]; same["links"] += add[2]
                same["ai"] = True
                if not same.get("label") and m.get("label"):
                    same["label"] = m["label"]
        else:
            keep.append({**m, "id": idmap[m["id"]], "links": links, "ai": True})
    return {"maps": keep}


def coverage(c: dict, mapping: dict, stats: dict | None = None) -> dict:
    """How much of the ontology the mapping (and, once built, the data) covers."""
    ix = onto.index(c)
    maps = mapping.get("maps", [])
    mapped = {m["class"] for m in maps}
    reach = set()
    for k in mapped:                                     # a mapped subclass gives its ancestors records too
        reach.add(k)
        reach.update(onto.ancestors(ix, k))
    coded = {i["type"] for i in c["individuals"]}
    props = {a["property"] for m in maps for a in m["attributes"]} | {v["property"] for m in maps for v in m["values"]} | \
            {ln["property"] for m in maps for ln in m["links"]}
    inv = {ix["props"][p]["inverse"] for p in props if p in ix["props"] and ix["props"][p].get("inverse") in ix["props"]}
    props |= inv
    out = {"classes": len(c["classes"]), "classes_mapped": sum(k["id"] in reach or k["id"] in coded for k in c["classes"]),
           "properties": len(c["properties"]), "properties_mapped": sum(p["id"] in props for p in c["properties"]),
           "unmapped_classes": [k["id"] for k in c["classes"] if k["id"] not in reach and k["id"] not in coded],
           "unmapped_properties": [p["id"] for p in c["properties"] if p["id"] not in props]}
    if stats and stats.get("classes") is not None:
        out["classes_with_data"] = sum(bool(stats["classes"].get(k["id"])) or k["id"] in coded for k in c["classes"])
        out["properties_with_data"] = sum(bool(stats["properties"].get(p["id"])) for p in c["properties"])
    return out


# ---- matching by names (no AI) ----------------------------------------------------------------------
def _norm(x: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (x or "").lower())


def _words(x: str) -> str:
    return _norm(profiling._singular(re.sub(r"[^A-Za-z0-9]+", "_", x or "").strip("_")))


def _ref_table(col: dict) -> str:
    return (col.get("ref") or "").rsplit(".", 1)[0].lower()


def suggest(c: dict, tables: list) -> dict:
    """A first mapping from names alone: tables named like classes, columns named like properties, declared or
    inferred references for relationships. Checked by clean_mapping like any other proposal."""
    ix = onto.index(c)
    maps = []
    for k in c["classes"]:
        names = {_norm(k["id"]), _norm(k["label"])}
        derived = {_norm(x) for x in re.split(r"[,;/ ]+", k.get("derived_from") or "") if x}
        best = None
        for t in tables:
            tn = _norm(t["table"])
            score = 3 if tn in derived or _norm(profiling._singular(t["table"])) in derived else \
                2 if _words(t["table"]) in names or tn in names else 0
            if score and (not best or score > best[0]):
                best = (score, t)
        if not best:
            continue
        t = best[1]
        cols = t["columns"]
        key = next((x["name"] for x in cols if x["pk"]), "") or next((x["name"] for x in cols if x["role"] == "identifier"), "")
        lab = next((x["name"] for x in cols if re.search(r"(^|_)(name|title|label)$", x["name"].lower()) and x["role"] != "identifier"), "") or \
              next((x["name"] for x in cols if re.search(r"(name|title|number|no|code)$", x["name"].lower()) and x["role"] == "identifier"), "")
        attrs, values, used = {}, {}, {key}
        cn = {_norm(x["name"]): x for x in cols}
        for p in c["properties"]:
            if not _fits(ix, k["id"], p):
                continue
            pn = _norm(p["id"])
            trims = [pn, _norm(p["label"]), pn[len(_norm(k["id"])):] if pn.startswith(_norm(k["id"])) else "",
                     re.sub(r"^(has|is)", "", pn)]
            if p["kind"] == "object":
                rng = _norm(p["range"])
                trims += [rng, rng[len(_norm(k["id"])):] if rng.startswith(_norm(k["id"])) else ""]
            hit = next((cn[x] for x in trims if x and x in cn and cn[x]["name"] not in used), None)
            if not hit:
                continue
            if p["kind"] == "data":
                attrs[p["id"]] = hit["name"]
                used.add(hit["name"])
            elif any(_is_a(ix, i["type"], p["range"]) for i in c["individuals"]) and hit["role"] in ("code", "attribute", "flag"):
                values[p["id"]] = hit["name"]
                used.add(hit["name"])
        maps.append({"id": f"m{len(maps) + 1}", "class": k["id"], "source": t["source"], "item": t["item"], "table": t["table"],
                     "key": key, "label": lab, "attributes": attrs, "values": values, "links": [], "_t": t})
    for m in maps:
        t = m["_t"]
        for p in c["properties"]:
            if p["kind"] != "object" or not _fits(ix, m["class"], p):
                continue
            for to in maps:
                if to is m or not _is_a(ix, to["class"], p["range"]) or not to["key"]:
                    continue
                tt = to["_t"]
                here = next((x["name"] for x in t["columns"] if _ref_table(x) == tt["table"].lower()), None) or \
                       next((x["name"] for x in t["columns"] if x["name"] != m["key"] and _norm(x["name"]) in
                             {_norm(p["range"]) + "id", _words(tt["table"]) + "id", re.sub(r"(by|of|to|for)$", "", _norm(p["id"])) + "id"}), None)
                if here:
                    m["links"].append({"property": p["id"], "to": to["id"], "side": "from", "column": here})
                    break
                there = next((x["name"] for x in tt["columns"] if _ref_table(x) == t["table"].lower()), None) or \
                        next((x["name"] for x in tt["columns"] if x["name"] != to["key"] and _norm(x["name"]) in
                              {_norm(m["class"]) + "id", _words(t["table"]) + "id"}), None)
                if there and m["key"]:
                    m["links"].append({"property": p["id"], "to": to["id"], "side": "to", "column": there})
                    break
    for m in maps:
        m.pop("_t")
    return {"maps": maps}


# ---- text for the AI model (structure only, never rows) ---------------------------------------------
def describe(c: dict, mapping: dict, stats: dict | None) -> str:
    """How the graph is shaped, for the model that writes a query: which classes have records, how they are named,
    which properties hold values. Counts and values are not given."""
    ix = onto.index(c)
    lines = []
    for m in mapping.get("maps", []):
        k = ix["classes"].get(m["class"])
        if not k:
            continue
        bits = [f"- :{m['class']} records" + (f" (only rows where {m['where']['column']} = '{m['where']['value']}')" if m["where"]["column"] else "")]
        attrs = [a["property"] for a in m["attributes"]] + [v["property"] + " (a controlled value)" for v in m["values"]] + \
                [f"{ln['property']} (to :{next((y['class'] for y in mapping['maps'] if y['id'] == ln['to']), '?')})" for ln in m["links"]]
        if attrs:
            bits.append("with " + ", ".join(":" + a for a in attrs))
        lines.append(" ".join(bits))
    empty = []
    if stats and stats.get("classes") is not None:
        empty = [k["id"] for k in c["classes"] if not stats["classes"].get(k["id"]) and not any(i["type"] == k["id"] for i in c["individuals"])]
    return "\n".join(lines) + (f"\nClasses WITHOUT any records in the graph: {', '.join(empty[:120])}" if empty else "")


def prefixes(c: dict) -> dict:
    ns = c["meta"]["namespace"]
    out = {"": ns, "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#", "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
           "owl": "http://www.w3.org/2002/07/owl#", "xsd": XSD, "skos": "http://www.w3.org/2004/02/skos/core#", "data": data_base(c)}
    if c["meta"].get("prefix"):
        out.setdefault(c["meta"]["prefix"], ns)
    return out


def data_base(c: dict) -> str:
    return re.sub(r"[#/]+$", "", c["meta"]["namespace"]) + "/data/"


# ---- reading rows -----------------------------------------------------------------------------------
class _Reader:
    """Reads mapped tables: SELECTs built by SQLAlchemy Core with a row limit; kept dataset files."""

    def __init__(self, db, cap: int):
        self.db, self.cap, self.engines, self.cache = db, cap, {}, {}

    def _sql(self, url: str, name: str, schema):
        from sqlalchemy import MetaData, Table, func
        from sqlalchemy import select as sel
        from . import sources
        eng = self.engines.get(url)
        if eng is None:
            try:
                eng = self.engines[url] = sources.make_engine(url)
            except sources.Unreadable as e:
                raise GraphError(str(e))
        with eng.connect() as con:
            tbl = Table(name, MetaData(), autoload_with=con, schema=schema)
            total = con.execute(sel(func.count()).select_from(tbl)).scalar()
            rows = [tuple(r) for r in con.execute(sel(tbl).limit(self.cap))]
        return [c.name for c in tbl.columns], rows, total

    def table(self, item_id: int) -> dict:
        if item_id in self.cache:
            return self.cache[item_id]
        item = self.db.get(DataSourceItem, item_id)
        ds = self.db.get(DataSource, item.data_source_id) if item else None
        if not item or not ds:
            raise GraphError("A mapped table no longer exists in its data source.")
        try:
            if ds.kind == "database":
                cfg = dsrc.config(ds)
                schema = None if cfg.get("db_type") == "snowflake" else (cfg.get("schema") or None)
                cols, rows, total = self._sql(dsrc._url(cfg), item.name, schema)
            else:
                path = dsrc.stored_path(item)
                if not path:
                    raise GraphError(f"“{item.file_name or item.name}” was uploaded before version 1.7, when uploaded files were not kept. "
                                     f"Upload it again on the data source “{ds.name}” (same name: it replaces the old one), then build again.")
                if path.suffix.lower() in (".db", ".sqlite", ".sqlite3"):
                    cols, rows, total = self._sql(f"sqlite:///{path}", item.name, None)
                else:
                    found = [x for x in profiling.read_tables(item.file_name or item.name, path.read_bytes(), self.cap) if x[0] == item.name]
                    if not found:
                        raise GraphError(f"Table “{item.name}” is no longer in the file “{item.file_name}”.")
                    _, cols, rows, total = found[0]
        except GraphError:
            raise
        except ModuleNotFoundError as e:
            from . import sources
            raise GraphError(sources._no_driver(e))
        except Exception as e:                       # one unreadable table is reported; the rest are built
            msg = re.sub(r"\s+", " ", str(getattr(e, "orig", e)))[:200]
            raise GraphError(f"{ds.name} / {item.name} could not be read: " + re.sub(r"(password|pwd)\s*[=:]\s*\S+", r"\1=***", msg, flags=re.I))
        out = {"columns": cols, "rows": rows, "total": total if total is not None else len(rows), "ds": ds, "item": item,
               "personal": {c["name"] for c in (item.profile or {}).get("columns", []) if c.get("personal")} if not ds.graph_personal else set()}
        self.cache[item_id] = out
        return out

    def close(self):
        for e in self.engines.values():
            e.dispose()


# ---- values -> RDF terms -----------------------------------------------------------------------------
def _keyval(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return str(v).lower()
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, decimal.Decimal) and v == v.to_integral_value():
        v = int(v)
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    return str(v).strip()


_TRUE, _FALSE = {"true", "t", "yes", "y", "1"}, {"false", "f", "no", "n", "0"}


def _date(v) -> dt.date | None:
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    s = str(v).strip()[:10]
    for rx, fmt in profiling.DATE_RX:
        if rx.match(s):
            try:
                return dt.datetime.strptime(s, fmt).date()
            except ValueError:
                return None
    return None


def _literal(px, v, rng: str):
    """-> (Literal or None, fitted the type)"""
    if v is None or (isinstance(v, str) and not v.strip()):
        return None, True
    s = _keyval(v) if not isinstance(v, str) else v.strip()
    try:
        if rng == "integer":
            d = decimal.Decimal(s.replace(",", ""))
            if d == d.to_integral_value():
                return px.Literal(str(int(d)), datatype=px.NamedNode(XSD + "integer")), True
        elif rng == "decimal":
            d = decimal.Decimal(s.replace(",", ""))
            if d.is_finite():
                return px.Literal(format(d.normalize(), "f") if d != 0 else "0", datatype=px.NamedNode(XSD + "decimal")), True
        elif rng == "boolean":
            if s.lower() in _TRUE | _FALSE:
                return px.Literal("true" if s.lower() in _TRUE else "false", datatype=px.NamedNode(XSD + "boolean")), True
        elif rng == "date":
            d = _date(v)
            if d:
                return px.Literal(d.isoformat(), datatype=px.NamedNode(XSD + "date")), True
        elif rng == "dateTime":
            if isinstance(v, dt.datetime):
                return px.Literal(v.replace(tzinfo=None).isoformat(timespec="seconds"), datatype=px.NamedNode(XSD + "dateTime")), True
            if profiling.DATETIME_RX.match(s):
                return px.Literal(s[:19].replace(" ", "T") + (":00" if len(s) == 16 else ""), datatype=px.NamedNode(XSD + "dateTime")), True
            d = _date(v)
            if d:
                return px.Literal(d.isoformat() + "T00:00:00", datatype=px.NamedNode(XSD + "dateTime")), True
        elif rng == "gYear":
            if re.fullmatch(r"\d{4}", s[:4]):
                return px.Literal(s[:4], datatype=px.NamedNode(XSD + "gYear")), True
        else:
            return px.Literal(s), True
    except (decimal.InvalidOperation, ValueError):
        pass
    return px.Literal(s), False


def _at(row, i):
    return row[i] if i is not None and i < len(row) else None


def _fold(x: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(x).lower())


# ---- building ---------------------------------------------------------------------------------------
def build(db, o, rec: KnowledgeGraph, cap: int, stage) -> dict:
    """Read the mapped rows into a new store; swap it in. -> stats"""
    import pyoxigraph as px
    from . import exports
    t0 = time.time()
    c = o.content
    ix = onto.index(c)
    mapping, problems = clean_mapping(c, rec.mapping or {}, catalogue(db, o.id))
    maps = mapping["maps"]
    if not maps:
        raise GraphError("Nothing is mapped yet: map at least one class to a table first.")
    ns, base = c["meta"]["namespace"], data_base(c)
    by_id = {m["id"]: m for m in maps}
    folder = f"{o.id}-{uuid.uuid4().hex[:10]}"
    path = config.GRAPHS_DIR / folder
    path.mkdir(parents=True, exist_ok=True)
    reader = _Reader(db, cap)
    notes, tables, read = [], [], {}
    store = None
    try:
        store = px.Store(str(path))
        store.load(exports.graph(c, o.version).serialize(format="nt").encode("utf-8"), px.RdfFormat.N_TRIPLES)
        needed = list(dict.fromkeys([m["item"] for m in maps] + [ln["link_item"] for m in maps for ln in m["links"] if ln["link_item"]]))
        for n, item_id in enumerate(needed):
            stage(f"Reading table {n + 1} of {len(needed)}", 5 + int(45 * n / max(1, len(needed))))
            try:
                t = reader.table(item_id)
            except GraphError as e:
                notes.append(str(e))
                continue
            read[item_id] = t
            tables.append({"source": t["ds"].name, "table": t["item"].name, "read": len(t["rows"]), "total": t["total"],
                           "capped": t["total"] > len(t["rows"])})
            if t["total"] > len(t["rows"]):
                notes.append(f"{t['ds'].name} / {t['item'].name}: the first {len(t['rows']):,} of {t['total']:,} rows were loaded "
                             f"(the limit per table is set by an administrator). Links to rows that were not loaded show as missing.")
        if not read:
            raise GraphError("None of the mapped tables could be read: " + " ".join(notes[:3]))

        T = px.NamedNode
        rdf_type, label = T(RDF_TYPE), T(LABEL)
        cls_node = {k: T(ns + k) for k in ix["classes"]}
        prop_node = {p: T(ns + p) for p in ix["props"]}
        batch, total = [], [0]
        counts_c: dict = {}
        counts_p: dict = {}
        keys: dict = {}                 # map id -> {key value: IRI}
        per_map = []
        g = px.DefaultGraph()

        def add(s, p, o_):
            if total[0] >= MAX_TRIPLES:
                return
            batch.append(px.Quad(s, p, o_, g))
            total[0] += 1
            if len(batch) >= 50_000:
                store.bulk_extend(batch)
                batch.clear()

        def token(m, v: str) -> str:
            t = read.get(m["item"])
            if t and m["key"] in t["personal"]:
                return "h" + hashlib.sha1(v.encode()).hexdigest()[:16]
            return quote(v, safe="")

        def iri(m, v: str):
            return T(f"{base}s{m['source']}/{quote(re.sub(r'[^A-Za-z0-9_-]+', '-', m['table']).strip('-').lower() or 't', safe='')}/{token(m, v)}")

        def col_ix(t, name):
            try:
                return t["columns"].index(name)
            except ValueError:
                return None

        def wanted(m, t, row):
            if not m["where"]["column"]:
                return True
            i = col_ix(t, m["where"]["column"])
            return i is not None and _fold(_keyval(_at(row, i))) == _fold(m["where"]["value"])

        # pass 1: records, names, attributes, controlled values
        for n, m in enumerate(maps):
            stage(f"Loading {m['class']} records ({n + 1} of {len(maps)})", 50 + int(30 * n / len(maps)))
            st = {"id": m["id"], "class": m["class"], "table": m["table"], "records": 0, "no_key": 0, "duplicates": 0,
                  "masked": [], "bad_values": {}, "values": {}, "links": {}}
            per_map.append(st)
            t = read.get(m["item"])
            keys[m["id"]] = {}
            if not t:
                st["error"] = "table not read"
                continue
            ki, li = col_ix(t, m["key"]) if m["key"] else None, col_ix(t, m["label"]) if m["label"] else None
            if li is not None and m["label"] in t["personal"]:
                st["masked"].append(m["label"])
                li = None
            types = [cls_node[m["class"]]] + [cls_node[a] for a in onto.ancestors(ix, m["class"])]
            attrs = []
            for a in m["attributes"]:
                if a["column"] in t["personal"]:
                    st["masked"].append(a["column"])
                    continue
                if (i := col_ix(t, a["column"])) is not None:
                    attrs.append((i, prop_node[a["property"]], ix["props"][a["property"]]["range"], a["property"]))
            vals = []
            for v in m["values"]:
                p = ix["props"][v["property"]]
                lookup = {}
                for ind in c["individuals"]:
                    if _is_a(ix, ind["type"], p["range"]):
                        lookup.setdefault(_fold(ind["id"]), ind["id"])
                        lookup.setdefault(_fold(ind["label"]), ind["id"])
                if (i := col_ix(t, v["column"])) is not None:
                    vals.append((i, prop_node[v["property"]], lookup, v["property"]))
                    st["values"][v["property"]] = {"matched": 0, "unmatched": 0, "examples": []}
            for rn, row in enumerate(t["rows"]):
                if not wanted(m, t, row):
                    continue
                kv = _keyval(_at(row, ki)) if ki is not None else str(rn + 1)
                if not kv:
                    st["no_key"] += 1
                    continue
                if kv in keys[m["id"]]:
                    st["duplicates"] += 1
                    continue
                s = iri(m, kv)
                keys[m["id"]][kv] = s
                st["records"] += 1
                for tp in types:
                    add(s, rdf_type, tp)
                    counts_c.setdefault(tp.value, set()).add(s.value)
                name = _keyval(_at(row, li)) if li is not None else ""
                if not name:                             # no name column (or it holds personal data): "Customer 17"
                    name = f"{ix['classes'][m['class']]['label']} {rn + 1 if m['key'] in t['personal'] else kv}"
                add(s, label, px.Literal(name))
                for i, pn, rng, pid in attrs:
                    lit, ok = _literal(px, _at(row, i), rng)
                    if lit is not None:
                        add(s, pn, lit)
                        counts_p[pid] = counts_p.get(pid, 0) + 1
                        if not ok:
                            st["bad_values"][pid] = st["bad_values"].get(pid, 0) + 1
                for i, pn, lookup, pid in vals:
                    raw = _keyval(_at(row, i))
                    if not raw:
                        continue
                    ind = lookup.get(_fold(raw))
                    vs = st["values"][pid]
                    if ind:
                        add(s, pn, T(ns + ind))
                        counts_p[pid] = counts_p.get(pid, 0) + 1
                        vs["matched"] += 1
                    else:
                        vs["unmatched"] += 1
                        if raw not in vs["examples"] and len(vs["examples"]) < 5:
                            vs["examples"].append(raw[:60])
        # pass 2: relationships (and their inverses)
        stage("Linking the records", 82)
        for m, st in zip(maps, per_map):
            t = read.get(m["item"])
            for ln in m["links"]:
                to = by_id[ln["to"]]
                p = ix["props"][ln["property"]]
                inv = prop_node.get(p.get("inverse")) if p.get("inverse") in ix["props"] else None
                pn, made, dangling = prop_node[p["id"]], 0, 0
                pairs = []
                if ln["side"] == "from" and t:
                    i, ki = col_ix(t, ln["column"]), col_ix(t, m["key"]) if m["key"] else None
                    for rn, row in enumerate(t["rows"]):
                        if i is None or not wanted(m, t, row):
                            continue
                        kv = _keyval(_at(row, ki)) if ki is not None else str(rn + 1)
                        pairs.append((keys[m["id"]].get(kv), to, _keyval(_at(row, i))))
                elif ln["side"] == "to" and (tt := read.get(to["item"])):
                    i, ki = col_ix(tt, ln["column"]), col_ix(tt, to["key"])
                    for row in tt["rows"]:
                        if i is None or ki is None or not wanted(to, tt, row):
                            continue
                        s_kv, o_kv = _keyval(_at(row, i)), _keyval(_at(row, ki))
                        if s_kv and o_kv:
                            s = keys[m["id"]].get(s_kv)
                            if s is None:
                                dangling += 1
                                continue
                            pairs.append((s, to, o_kv))
                elif ln["side"] == "link" and (lt := read.get(ln["link_item"])):
                    a, b = col_ix(lt, ln["column"]), col_ix(lt, ln["to_column"])
                    for row in lt["rows"]:
                        if a is None or b is None:
                            continue
                        s_kv, o_kv = _keyval(_at(row, a)), _keyval(_at(row, b))
                        if s_kv and o_kv:
                            s = keys[m["id"]].get(s_kv)
                            if s is None:
                                dangling += 1
                                continue
                            pairs.append((s, to, o_kv))
                for s, target, o_kv in pairs:
                    if s is None or not o_kv:
                        continue
                    o_ = keys[target["id"]].get(o_kv)
                    if o_ is None:                       # a reference to a row that is not there (or was not loaded)
                        dangling += 1
                        continue
                    add(s, pn, o_)
                    made += 1
                    if inv is not None:
                        add(o_, inv, s)
                        counts_p[p["inverse"]] = counts_p.get(p["inverse"], 0) + 1
                counts_p[p["id"]] = counts_p.get(p["id"], 0) + made
                st["links"][p["id"]] = {"made": made, "dangling": dangling, "to": to["class"]}
        if batch:
            store.bulk_extend(batch)
        if total[0] >= MAX_TRIPLES:
            notes.append(f"The graph reached its size limit of {MAX_TRIPLES:,} facts; the rest was not loaded.")
        stage("Saving the graph", 95)
        store.flush()
    except Exception:
        reader.close()
        store = None
        gc.collect()
        shutil.rmtree(path, ignore_errors=True)
        raise
    reader.close()
    store = None
    gc.collect()
    old = rec.store
    rec.store, rec.status, rec.error = folder, "ready", ""
    rec.built_at, rec.built_version = now(), o.version
    rec.sources = sorted({m["source"] for m in maps if m["item"] in read})
    classes = {k: len(counts_c.get(ns + k, ())) for k in ix["classes"]}
    stats = {"classes": classes, "properties": {p: counts_p.get(p, 0) for p in ix["props"]}, "facts": total[0],
             "records": sum(st["records"] for st in per_map), "tables": tables, "maps": per_map, "notes": notes, "problems": problems,
             "seconds": round(time.time() - t0, 1), "rows_per_table": cap}
    rec.stats = stats
    if old and old != folder:
        shutil.rmtree(config.GRAPHS_DIR / old, ignore_errors=True)   # a query still reading it (Windows) keeps it: cleaned at start-up
    return stats


def drop(db, oid: int):
    rec = record(db, oid)
    if rec and rec.store:
        shutil.rmtree(config.GRAPHS_DIR / rec.store, ignore_errors=True)


def cleanup(db):
    """At start-up: remove store folders no knowledge graph refers to (old builds, interrupted builds)."""
    if not config.GRAPHS_DIR.exists():
        return
    live = set(db.scalars(select(KnowledgeGraph.store)))
    for p in config.GRAPHS_DIR.iterdir():
        if p.is_dir() and p.name not in live:
            shutil.rmtree(p, ignore_errors=True)
    for rec in db.scalars(select(KnowledgeGraph).where(KnowledgeGraph.status == "building")):
        rec.status = "ready" if rec.store else "none"
    db.commit()


# ---- querying ---------------------------------------------------------------------------------------
def check_query(sparql: str) -> str:
    q = (sparql or "").strip()
    if not q:
        raise GraphError("Write a query first.")
    if len(q) > 20000:
        raise GraphError("The query is too long (more than 20,000 characters).")
    if re.search(r"\bSERVICE\b", q, re.I):
        raise GraphError("SERVICE is not allowed: queries run on this knowledge graph only, never on other servers.")
    if re.match(r"^\s*(?:(?:PREFIX|BASE)\s[^\n]*\n\s*)*(INSERT|DELETE|LOAD|CLEAR|DROP|CREATE|ADD|MOVE|COPY|WITH)\b", q, re.I):
        raise GraphError("Only questions (SELECT, ASK, CONSTRUCT, DESCRIBE) can be run: the knowledge graph cannot be changed by a query.")
    return q


def run_query(rec: KnowledgeGraph, c: dict, sparql: str, seconds: int, limit: int = CONSOLE_ROWS, picture: bool = True) -> dict:
    if not rec or rec.status != "ready" or not rec.store:
        raise GraphError("The knowledge graph has not been built yet.")
    q = check_query(sparql)
    store = config.GRAPHS_DIR / rec.store
    if not store.is_dir():
        raise GraphError("The knowledge graph's files are missing. Build it again.")
    req = {"store": str(store), "query": q, "prefixes": prefixes(c), "limit": limit,
           "picture": {"data": data_base(c), "max": PICTURE_RECORDS} if picture else None}
    if not _queries.acquire(timeout=30):
        raise GraphError("Too many queries are running at once. Try again in a moment.")
    t0 = time.time()
    try:
        proc = subprocess.run([sys.executable, str(WORKER)], input=json.dumps(req), capture_output=True, text=True, timeout=seconds,
                              encoding="utf-8")
    except subprocess.TimeoutExpired:
        raise GraphError(f"The query took longer than {seconds} seconds and was stopped. Narrow it down (fewer records, a LIMIT, "
                         "fewer optional parts), or ask an administrator to raise the time limit.")
    finally:
        _queries.release()
    try:
        out = json.loads(proc.stdout)
    except ValueError:
        log.error("Knowledge-graph query worker failed: %s", (proc.stderr or "")[-2000:])
        raise GraphError("The query could not be run (the details are in the server log).")
    if out.get("error"):
        lead = {"syntax": "The query is not valid SPARQL: ", "run": "The query failed: "}.get(out["error"], "")
        raise GraphError(lead + out["message"])
    out["seconds"] = round(time.time() - t0, 2)
    return shape(c, out)


def shape(c: dict, out: dict) -> dict:
    """Worker answer -> result table with readable names, and the picture of the records."""
    from . import layout
    ix = onto.index(c)
    ns = c["meta"]["namespace"]
    names = {}
    pic = out.pop("picture", None)
    for s, p, o in (pic or {}).get("triples", []):
        if p == LABEL and o["t"] == "lit":
            names.setdefault(s, o["v"])

    def cell(x):
        if x is None:
            return None
        if x["t"] == "iri":
            v = x["v"]
            if v.startswith(ns):
                local = v[len(ns):]
                el = ix["classes"].get(local) or ix["props"].get(local) or ix["individuals"].get(local)
                return {"v": el["label"] if el else local, "t": "iri", "iri": v}
            return {"v": names.get(v) or re.split(r"[/#]", v.rstrip("/#"))[-1], "t": "iri", "iri": v}
        return {k: x[k] for k in ("v", "t", "dt", "lang") if k in x}
    if out.get("kind") == "ask":
        return {"kind": "ask", "value": out["value"], "columns": ["answer"], "rows": [[{"v": "yes" if out["value"] else "no", "t": "lit"}]],
                "count": 1, "more": False, "seconds": out.get("seconds"), "picture": None}
    rows = [[cell(x) for x in r] for r in out["rows"]]
    spec = layout.instances(c, pic, data_base(c)) if pic and pic.get("focus") else None
    return {"kind": "select", "columns": out["columns"], "rows": rows, "count": out["count"], "more": out.get("more", False),
            "shown": len(rows), "seconds": out.get("seconds"), "picture": spec}


def elements(c: dict, sparql: str) -> list[str]:
    """Ontology classes and properties a query refers to (":Customer", "retail:places", or a full IRI)."""
    ns, pre = c["meta"]["namespace"], c["meta"].get("prefix") or ""
    ix = onto.index(c)
    body = re.sub(r'"(?:[^"\\]|\\.)*"', '""', sparql or "")
    found = re.findall(r"(?:(?<=[\s(/^|!{;,.])|^)(?:" + (re.escape(pre) + "|" if pre else "") + r"):([A-Za-z_][\w-]*)", body)
    found += re.findall(r"<" + re.escape(ns) + r"([A-Za-z_][\w-]*)>", body)
    return [x for x in dict.fromkeys(found) if x in ix["classes"] or x in ix["props"]]


def without_data(c: dict, stats: dict, ids) -> list[dict]:
    """Of these classes / properties, those the graph holds nothing for."""
    ix = onto.index(c)
    coded = {i["type"] for i in c["individuals"]}
    out = []
    for x in dict.fromkeys(ids):
        if x in ix["classes"] and not stats.get("classes", {}).get(x) and x not in coded:
            out.append({"id": x, "label": ix["classes"][x]["label"], "type": "class"})
        elif x in ix["props"] and not stats.get("properties", {}).get(x):
            out.append({"id": x, "label": ix["props"][x]["label"], "type": ix["props"][x]["kind"] + "_property"})
    return out
