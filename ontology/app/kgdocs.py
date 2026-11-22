"""Knowledge graphs from documents: entities and relationships an AI model extracts from unstructured text
(judgments, opinions, contracts, policies...) using the ontology as the only vocabulary.

Nothing the model returns is trusted (`accept_chunk`):
- the class, every property and every controlled value must exist in the ontology, and the property's domain and
  range must fit the classes (subclasses inherit);
- every entity, attribute and relationship must come with a QUOTE, and the quote must actually occur in the
  document (compared without regard to case, punctuation or spacing) - this is what stops invented facts;
- values are converted to the property's type (a value that does not fit is kept as text and flagged).
What fails is listed with the reason, never silently dropped.

The same thing mentioned in several places or documents becomes one entity: names are normalised (case,
punctuation, "Private Limited" = "Pvt Ltd", "M/s.") and matched within compatible classes; near matches are offered
to a person as merge suggestions. Extracted items start as "proposed"; only those a person accepts go into the graph
at the next build, each with the documents, pages and quotes it came from.

Storage: KnowledgeGraph.extracted = {"documents": {key: {...}}, "entities": [...], "relations": [...],
"rejected": [...], "suggestions": [...], "seq": n}.
"""
import datetime as dt
import decimal
import re

from sqlalchemy import select

from . import onto
from .models import DataSource, DataSourceItem, OntologyDataSource, Source

CHUNK = 40_000          # characters of a document read per model call
OVERLAP = 1_500
MAX_DOCS = 100
MAX_REJECTED = 400
_SUFFIX = [(r"\bprivate limited\b|\bpvt\.? ?ltd\.?\b|\bpvt\b\.?", " pvt "), (r"\blimited\b|\bltd\b\.?", " ltd "), (r"\bincorporated\b|\binc\b\.?", " inc "),
           (r"\bcompany\b|\bco\b\.?", " co "), (r"^\s*(m/s\.?|messrs\.?|the)\s+", " ")]


def empty() -> dict:
    return {"documents": {}, "entities": [], "relations": [], "rejected": [], "suggestions": [], "seq": 0}


# ---- documents available to an ontology ----------------------------------------------------------------
def documents(db, oid: int) -> list[dict]:
    """Documents of the ontology's data sources and its own source documents. Text is not included."""
    out = []
    for link in db.scalars(select(OntologyDataSource).where(OntologyDataSource.ontology_id == oid)):
        ds = db.get(DataSource, link.data_source_id)
        if not ds:
            continue
        for i in db.scalars(select(DataSourceItem).where(DataSourceItem.data_source_id == ds.id, DataSourceItem.kind == "document").order_by(DataSourceItem.name)):
            out.append({"key": f"ds{i.id}", "name": i.name, "origin": ds.name, "source": ds.id, "chars": i.chars, "pages": (i.text or "").count("\f") + 1})
    for s in db.scalars(select(Source).where(Source.ontology_id == oid, Source.kind == "document").order_by(Source.name)):
        out.append({"key": f"src{s.id}", "name": s.name, "origin": "this ontology's sources", "source": None, "chars": s.chars, "pages": (s.text or "").count("\f") + 1})
    return out


def text_of(db, oid: int, key: str) -> tuple[str, str, int | None] | None:
    """-> (name, text, data source id) of a document of this ontology, or None."""
    m = re.fullmatch(r"(ds|src)(\d+)", key or "")
    if not m:
        return None
    if m.group(1) == "ds":
        i = db.get(DataSourceItem, int(m.group(2)))
        if not i or i.kind != "document" or not db.scalar(select(OntologyDataSource.id).where(OntologyDataSource.ontology_id == oid,
                                                                                             OntologyDataSource.data_source_id == i.data_source_id)):
            return None
        return i.name, i.text or "", i.data_source_id
    s = db.get(Source, int(m.group(2)))
    if not s or s.ontology_id != oid or s.kind != "document":
        return None
    return s.name, s.text or "", None


def chunks(text: str) -> list[str]:
    """Parts of at most CHUNK characters, cut at paragraph ends, overlapping a little so nothing is cut in half."""
    if len(text) <= CHUNK:
        return [text]
    out, start = [], 0
    while start < len(text):
        end = min(len(text), start + CHUNK)
        if end < len(text):
            cut = next((x for x in (text.rfind(sep, start + CHUNK // 2, end) for sep in ("\n\n", "\n", ". ")) if x > 0), -1)
            end = cut + 1 if cut > 0 else end
        out.append(text[start:end])
        if end >= len(text):
            break
        start = max(end - OVERLAP, start + 1)
    return out


# ---- matching quotes and names ---------------------------------------------------------------------------
def _flat(x: str) -> str:
    return re.sub(r"[^0-9a-z]+", " ", str(x).lower()).strip()


class Doc:
    """A document's text prepared for checking quotes: flattened per page."""

    def __init__(self, text: str):
        self.pages = [_flat(p) for p in text.split("\f")]
        self.paged = len(self.pages) > 1

    def find(self, quote: str) -> int | None | bool:
        """-> page number (1-based), None if found in an unpaged text, False if the quote is not in the document."""
        q = _flat(quote)
        if len(q) < 6:
            return False
        for n, p in enumerate(self.pages):
            if q in p:
                return n + 1 if self.paged else None
        joined = " ".join(self.pages)                     # a quote running over a page break
        if q in joined:
            return next((n + 1 for n, p in enumerate(self.pages) if q[:40] in p), None) if self.paged else None
        return False


def name_key(label: str) -> str:
    x = " " + str(label or "").lower() + " "
    for rx, rep in _SUFFIX:
        x = re.sub(rx, rep, x)
    return _flat(x)


def _tokens(k: str) -> set:
    return {t for t in k.split() if t not in ("pvt", "ltd", "inc", "co", "of", "and", "the", "v", "vs")}


def _compatible(ix, a: str, b: str) -> bool:
    return a == b or a in onto.ancestors(ix, b) or b in onto.ancestors(ix, a)


def _more_specific(ix, a: str, b: str) -> str:
    return a if b in onto.ancestors(ix, a) else b


# ---- values ------------------------------------------------------------------------------------------
def value(v, rng: str) -> tuple[str, bool]:
    """A value as the property's type expects it -> (text, fits)."""
    s = re.sub(r"\s+", " ", str(v if not isinstance(v, (dict, list)) else "")).strip()[:2000]
    try:
        if rng in ("integer", "decimal"):
            d = decimal.Decimal(re.sub(r"[,\s]|^(rs\.?|inr|usd|\$)", "", s.lower()))
            if rng == "integer" and d != d.to_integral_value():
                return s, False
            return (str(int(d)) if rng == "integer" else format(d.normalize(), "f")), True
        if rng == "date":
            return dt.date.fromisoformat(s[:10]).isoformat(), True
        if rng == "dateTime":
            return dt.datetime.fromisoformat(s.replace("Z", "")).isoformat(timespec="seconds"), True
        if rng == "boolean":
            if s.lower() in ("true", "false", "yes", "no"):
                return ("true" if s.lower() in ("true", "yes") else "false"), True
            return s, False
        if rng == "gYear":
            return (s, True) if re.fullmatch(r"\d{4}", s) else (s, False)
        if rng == "anyURI":
            return (s, True) if re.fullmatch(r"https?://\S+", s) else (s, False)
    except (decimal.InvalidOperation, ValueError):
        return s, False
    return s, True


# ---- taking in one part of a document ------------------------------------------------------------------------
def accept_chunk(c: dict, store: dict, key: str, doc: Doc, raw: dict) -> dict:
    """Check what the model extracted from one part of document `key` and merge it into `store`. -> counts"""
    ix = onto.index(c)
    inds = ix["individuals"]
    ents = {e["id"]: e for e in store["entities"]}
    rejected = store["rejected"]
    counts = {"entities": 0, "merged": 0, "relations": 0, "rejected": 0}

    def reject(what: str, why: str):
        counts["rejected"] += 1
        if len(rejected) < MAX_REJECTED:
            rejected.append({"doc": key, "what": what[:300], "reason": why})

    def mention(quote) -> dict | None:
        q = onto.s(quote, 400)
        page = doc.find(q) if q else False
        return None if page is False else {"doc": key, "page": page, "quote": q}

    local = {}                                           # the model's ids for this part -> entity ids
    for x in raw.get("entities") if isinstance(raw.get("entities"), list) else []:
        if not isinstance(x, dict):
            continue
        rid, cls, label = onto.s(x.get("id"), 40), onto.s(x.get("class"), 120), onto.s(x.get("label"), 300)
        if rid in ents and not label:                    # a bare reference to an entity already in the graph
            local[rid] = rid
            continue
        if cls not in ix["classes"]:
            reject(f"{label or rid} ({cls or 'no class'})", f"“{cls}” is not a class of the ontology.")
            continue
        if not label:
            reject(f"{rid} ({cls})", "No name was given.")
            continue
        m = mention(x.get("quote"))
        if not m:
            reject(f"{label} ({cls})", "The quote given as evidence is not in the document." if x.get("quote") else "No quote was given as evidence.")
            continue
        aliases = [a for a in onto.strs(x.get("aliases"), 8, 200) if name_key(a) != name_key(label)]
        target = ents.get(rid) if rid in ents and _compatible(ix, ents[rid]["class"], cls) else None
        if not target:                                   # the same thing already extracted (here or from another document)?
            keys = {name_key(label)} | {name_key(a) for a in aliases}
            target = next((e for e in store["entities"] if e["status"] != "rejected" and _compatible(ix, e["class"], cls)
                           and keys & ({name_key(e["label"])} | {name_key(a) for a in e["aliases"]})), None)
        if target:
            counts["merged"] += 1
            target["class"] = _more_specific(ix, target["class"], cls)
            for a in [label] + aliases:
                if name_key(a) != name_key(target["label"]) and a not in target["aliases"] and len(target["aliases"]) < 12:
                    target["aliases"].append(a)
            if not any(mm["doc"] == key and mm["quote"] == m["quote"] for mm in target["mentions"]) and len(target["mentions"]) < 30:
                target["mentions"].append(m)
            e = target
        else:
            store["seq"] += 1
            e = {"id": f"x{store['seq']}", "class": cls, "label": label, "aliases": aliases, "attrs": {}, "mentions": [m], "status": "proposed"}
            store["entities"].append(e)
            ents[e["id"]] = e
            counts["entities"] += 1
        local[rid or e["id"]] = e["id"]
        attrs = x.get("attributes") if isinstance(x.get("attributes"), dict) else {}
        for pid, av in attrs.items():
            p = ix["props"].get(onto.s(pid, 120))
            if not p or p["kind"] != "data":
                reject(f"{label}: {pid}", f"“{pid}” is not an attribute in the ontology.")
                continue
            if not (p["domain"] == e["class"] or p["domain"] in onto.ancestors(ix, e["class"])):
                reject(f"{label}: {pid}", f"{pid} belongs to {p['domain']}, not to {e['class']}.")
                continue
            raw_v, q = (av.get("value"), av.get("quote")) if isinstance(av, dict) else (av, x.get("quote"))
            am = mention(q)
            if not am:
                reject(f"{label}: {pid} = {onto.s(raw_v, 80)}", "The quote given as evidence is not in the document.")
                continue
            v, fits = value(raw_v, p["range"])
            if not v:
                continue
            vals = e["attrs"].setdefault(p["id"], [])
            if not any(a["value"] == v for a in vals) and len(vals) < 10:
                vals.append({"value": v, "fits": fits, **am})
    for x in raw.get("relations") if isinstance(raw.get("relations"), list) else []:
        if not isinstance(x, dict):
            continue
        sid, pid, oid_ = onto.s(x.get("subject"), 40), onto.s(x.get("property"), 120), onto.s(x.get("object"), 120)
        what = f"{sid} {pid} {oid_}"
        p = ix["props"].get(pid)
        s = ents.get(local.get(sid) or (sid if sid in ents else ""))
        if not p or p["kind"] != "object":
            reject(what, f"“{pid}” is not a relationship in the ontology.")
            continue
        if not s:
            reject(what, "Its subject was not extracted (or was left out).")
            continue
        if not (p["domain"] == s["class"] or p["domain"] in onto.ancestors(ix, s["class"])):
            reject(f"{s['label']} {pid} …", f"{pid} starts from {p['domain']}, but {s['label']} is a {s['class']}.")
            continue
        o = ents.get(local.get(oid_) or (oid_ if oid_ in ents else ""))
        if o:
            ocls, oref = o["class"], o["id"]
        elif oid_ in inds:
            ocls, oref = inds[oid_]["type"], "ind:" + oid_
        else:
            reject(f"{s['label']} {pid} {oid_}", "Its object was not extracted and is not a controlled value of the ontology.")
            continue
        if not (ocls == p["range"] or p["range"] in onto.ancestors(ix, ocls)):
            reject(f"{s['label']} {pid} {o['label'] if o else oid_}", f"{pid} points to {p['range']}, not to {ocls}.")
            continue
        m = mention(x.get("quote"))
        if not m:
            reject(f"{s['label']} {pid} {o['label'] if o else oid_}", "The quote given as evidence is not in the document.")
            continue
        r = next((r for r in store["relations"] if r["s"] == s["id"] and r["p"] == pid and r["o"] == oref), None)
        if r:
            if len(r["mentions"]) < 20 and not any(mm["quote"] == m["quote"] for mm in r["mentions"]):
                r["mentions"].append(m)
        else:
            store["seq"] += 1
            store["relations"].append({"id": f"r{store['seq']}", "s": s["id"], "p": pid, "o": oref, "mentions": [m], "status": "proposed"})
            counts["relations"] += 1
    suggest_merges(c, store)
    return counts


def suggest_merges(c: dict, store: dict):
    """Near matches a person should look at: same kind of thing, names sharing most of their words."""
    ix = onto.index(c)
    live = [e for e in store["entities"] if e["status"] != "rejected"]
    seen = {(s["a"], s["b"]) for s in store["suggestions"]}
    for n, a in enumerate(live):
        ka = _tokens(name_key(a["label"]))
        for b in live[n + 1:]:
            if (a["id"], b["id"]) in seen or not _compatible(ix, a["class"], b["class"]):
                continue
            kb = _tokens(name_key(b["label"]))
            if ka and kb and (len(ka & kb) / len(ka | kb) >= 0.6 or (min(len(ka), len(kb)) >= 2 and (ka <= kb or kb <= ka))):
                store["suggestions"].append({"a": a["id"], "b": b["id"]})
                seen.add((a["id"], b["id"]))
    store["suggestions"] = store["suggestions"][-200:]


def forget_document(store: dict, key: str):
    """Before a document is extracted again: what only it proposed (not yet accepted) goes; accepted items stay."""
    def only_here(x):
        return x["status"] != "accepted" and all(m["doc"] == key for m in x["mentions"])
    gone = {e["id"] for e in store["entities"] if only_here(e)}
    store["entities"] = [e for e in store["entities"] if e["id"] not in gone]
    for e in store["entities"]:
        if e["status"] != "accepted":
            e["mentions"] = [m for m in e["mentions"] if m["doc"] != key] or e["mentions"]
    store["relations"] = [r for r in store["relations"] if not only_here(r) and r["s"] not in gone and r["o"] not in gone]
    store["rejected"] = [r for r in store["rejected"] if r["doc"] != key]
    store["suggestions"] = [s for s in store["suggestions"] if s["a"] not in gone and s["b"] not in gone]


ANCHORS = 60            # entities from earlier parts of the same document given with every later part
HEAD = 2_000            # characters of a document's beginning given with every later part


def _line(e: dict) -> str:
    return f"- {e['id']} | {e['class']} | {e['label']}" + (f" | also: {', '.join(e['aliases'][:4])}" if e["aliases"] else "")


def registry(store: dict, text: str, limit: int = 300, doc_key: str | None = None) -> str:
    """What the model is told is already known, so it reuses ids instead of creating duplicates:
    1. with doc_key (a later part of a long document): the entities found in this document's earlier parts - the parties,
       court, provisions... - whether or not this part names them (it may only say "the assessee" or "the Company");
    2. entities from anywhere (other documents too) that this part mentions by name."""
    mine = []
    if doc_key:
        mine = sorted((e for e in store["entities"] if e["status"] != "rejected" and any(m["doc"] == doc_key for m in e["mentions"])),
                      key=lambda e: -sum(m["doc"] == doc_key for m in e["mentions"]))[:ANCHORS]
    flat = " " + name_key(text) + " "                     # "Limited" in one document matches "Ltd" in another
    seen = {e["id"] for e in mine}
    named = []
    for e in store["entities"]:
        if e["status"] == "rejected" or e["id"] in seen:
            continue
        if any((" " + name_key(n) + " ") in flat for n in [e["label"]] + e["aliases"] if len(name_key(n)) >= 4):
            named.append(e)
        if len(named) >= limit:
            break
    out = []
    if mine:
        out.append("Found in the earlier parts of THIS document (this part may refer to them only by role - \"the assessee\", "
                   "\"the appellant\", \"the Company\", \"the Court\" - link those references to these ids):\n" + "\n".join(map(_line, mine)))
    if named:
        out.append("Already in the graph and named in this part:\n" + "\n".join(map(_line, named)))
    return "\n\n".join(out) or "(none yet)"


def head(text: str) -> str:
    """The beginning of a document (title, parties, court, date), cut at a line end."""
    if len(text) <= HEAD:
        return text
    cut = text.rfind("\n", HEAD // 2, HEAD)
    return text[:cut if cut > 0 else HEAD]


# ---- review --------------------------------------------------------------------------------------------
def set_status(store: dict, ids: list, status: str) -> int:
    ids, n = set(ids), 0
    for x in store["entities"] + store["relations"]:
        if x["id"] in ids and x["status"] != status:
            x["status"] = status
            n += 1
    if status == "accepted":                             # a relationship needs both ends in the graph
        live = {e["id"] for e in store["entities"] if e["status"] == "accepted"}
        for r in store["relations"]:
            if r["id"] in ids and (r["s"] not in live or (not r["o"].startswith("ind:") and r["o"] not in live)):
                for e in store["entities"]:
                    if e["id"] in (r["s"], r["o"]) and e["status"] != "accepted":
                        e["status"] = "accepted"
                        n += 1
    if status == "rejected":                             # rejecting an entity rejects its relationships
        dead = {e["id"] for e in store["entities"] if e["status"] == "rejected"}
        for r in store["relations"]:
            if (r["s"] in dead or r["o"] in dead) and r["status"] != "rejected":
                r["status"] = "rejected"
                n += 1
    return n


def merge(c: dict, store: dict, keep: str, drop: str) -> bool:
    """Make two extracted entities one."""
    ix = onto.index(c)
    a = next((e for e in store["entities"] if e["id"] == keep), None)
    b = next((e for e in store["entities"] if e["id"] == drop), None)
    if not a or not b or a is b or not _compatible(ix, a["class"], b["class"]):
        return False
    a["class"] = _more_specific(ix, a["class"], b["class"])
    for x in [b["label"]] + b["aliases"]:
        if x not in a["aliases"] and name_key(x) != name_key(a["label"]):
            a["aliases"].append(x)
    a["mentions"] = (a["mentions"] + [m for m in b["mentions"] if m not in a["mentions"]])[:30]
    for p, vals in b["attrs"].items():
        mine = a["attrs"].setdefault(p, [])
        mine += [v for v in vals if not any(w["value"] == v["value"] for w in mine)]
    if b["status"] == "accepted":
        a["status"] = "accepted"
    store["entities"].remove(b)
    rels = []
    for r in store["relations"]:
        r = {**r, "s": keep if r["s"] == drop else r["s"], "o": keep if r["o"] == drop else r["o"]}
        same = next((x for x in rels if x["s"] == r["s"] and x["p"] == r["p"] and x["o"] == r["o"]), None)
        if same:
            same["mentions"] += [m for m in r["mentions"] if m not in same["mentions"]]
        elif r["s"] != r["o"]:
            rels.append(r)
    store["relations"] = rels
    store["suggestions"] = [s for s in store["suggestions"] if drop not in (s["a"], s["b"])]
    return True


def clean_against(c: dict, store: dict):
    """After the ontology changed: entities whose class or relationships whose property no longer exist are set aside."""
    ix = onto.index(c)
    for e in store["entities"]:
        if e["class"] not in ix["classes"] and e["status"] != "rejected":
            e["status"] = "rejected"
            e["note"] = "Its class is no longer in the ontology."
    for r in store["relations"]:
        if r["p"] not in ix["props"] and r["status"] != "rejected":
            r["status"] = "rejected"
            r["note"] = "Its relationship is no longer in the ontology."


def summary(store: dict) -> dict:
    st = lambda xs, s: sum(1 for x in xs if x["status"] == s)  # noqa: E731
    return {"entities": len(store["entities"]), "relations": len(store["relations"]),
            "accepted": st(store["entities"], "accepted") + st(store["relations"], "accepted"),  # "to_review", not "proposed": _job() drops that key
            "to_review": st(store["entities"], "proposed") + st(store["relations"], "proposed"),
            "rejected_by_check": len(store["rejected"]), "suggestions": len(store["suggestions"]), "documents": len(store["documents"])}


def evidence(store: dict, entity_ids, names: dict) -> list[dict]:
    """Where accepted entities come from: document, page and quote (for answers that cite their sources)."""
    by = {e["id"]: e for e in store["entities"]}
    out = []
    for i in entity_ids:
        e = by.get(i)
        if not e:
            continue
        for m in e["mentions"][:3]:
            out.append({"entity": e["label"], "class": e["class"], "document": names.get(m["doc"], m["doc"]), "page": m["page"], "quote": m["quote"]})
    return out[:60]
