"""The ontology document: its shape, cleaning of anything that comes from a model or a browser,
graph helpers, quality checks, and the server-side verification of test-bed results.

Nothing a model returns is trusted: `clean()` rebuilds every element field by field, repairs or drops
dangling references, and caps sizes. Scores are always computed here, never taken from the model.
"""
import re

XSD = ("string", "integer", "decimal", "boolean", "date", "dateTime", "time", "anyURI", "duration", "gYear")
CARDS = ("0..1", "1", "0..*", "1..*")
ALIGN = ("equivalent", "subclass", "related")
_XSD_ALIAS = {"int": "integer", "number": "decimal", "float": "decimal", "double": "decimal", "bool": "boolean",
              "datetime": "dateTime", "timestamp": "dateTime", "text": "string", "str": "string", "uri": "anyURI",
              "url": "anyURI", "money": "decimal", "currency": "decimal", "year": "gYear", "long": "integer"}


def s(v, n=2000) -> str:
    return re.sub(r"\s+", " ", str(v)).strip()[:n] if v is not None and not isinstance(v, (dict, list)) else ""


def text(v, n=6000) -> str:
    """Multi-line text (keeps line breaks)."""
    return str(v).strip()[:n] if v is not None and not isinstance(v, (dict, list)) else ""


def strs(v, n=12, each=300) -> list[str]:
    if isinstance(v, str):
        v = [v]
    out = []
    for x in v if isinstance(v, list) else []:
        x = s(x.get("term") or x.get("name") or x.get("text") or "" if isinstance(x, dict) else x, each)
        if x and x not in out:
            out.append(x)
    return out[:n]


def ident(v, upper: bool) -> str:
    """A safe local name: UpperCamelCase for classes/individuals, lowerCamelCase for properties."""
    raw = str(v or "").split(":")[-1].split("#")[-1].split("/")[-1]
    parts = [p for p in re.split(r"[^A-Za-z0-9]+", raw) if p]
    if not parts:
        return ""
    out = parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:])
    out = (out[:1].upper() if upper else out[:1].lower()) + out[1:]
    if out[0].isdigit():
        out = ("C" if upper else "p") + out
    return out[:80]


def label_of(i: str) -> str:
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", i).strip().capitalize() if i else ""


def empty(name="", domain="", scope="", namespace="") -> dict:
    slug = re.sub(r"[^a-z0-9]+", "-", (name or domain or "ontology").lower()).strip("-")[:40] or "ontology"
    prefix = re.sub(r"[^a-z]", "", slug)[:8] or "onto"
    return {"meta": {"name": name, "domain": domain, "scope": scope, "prefix": prefix,
                     "namespace": (namespace.rstrip("/#") + "/" if namespace else "https://example.org/ontology/") + slug + "#"},
            "standards": [], "modules": [], "classes": [], "properties": [], "individuals": [], "rules": [],
            "explanation": {}, "use_cases": []}


# ---- cleaning ---------------------------------------------------------------------------------
def clean_standard(x) -> dict | None:
    if not isinstance(x, dict) or not s(x.get("name")):
        return None
    rel = s(x.get("relevance")).lower()
    return {"id": re.sub(r"[^a-z0-9]+", "-", s(x.get("id") or x.get("prefix") or x.get("name"), 40).lower()).strip("-") or "std",
            "name": s(x.get("name"), 200), "publisher": s(x.get("publisher"), 200), "url": _url(x.get("url")),
            "prefix": re.sub(r"[^A-Za-z0-9]", "", s(x.get("prefix"), 20)), "namespace": _url(x.get("namespace")),
            "kind": s(x.get("kind"), 20).lower() if s(x.get("kind")).lower() in ("ontology", "vocabulary", "standard", "upper") else "standard",
            "relevance": rel if rel in ("high", "medium", "low") else "medium",
            "how_used": text(x.get("how_used"), 1500), "reused_terms": strs(x.get("reused_terms"), 20, 120),
            "in_catalogue": bool(x.get("in_catalogue"))}


def _url(v) -> str:
    v = s(v, 400)
    return v if re.match(r"https?://[^\s<>\"]+$", v) else ""


def clean_class(x) -> dict | None:
    if not isinstance(x, dict):
        return None
    i = ident(x.get("id") or x.get("label") or x.get("name"), True)
    if not i:
        return None
    al = s(x.get("alignment")).lower()
    return {"id": i, "label": s(x.get("label"), 200) or label_of(i), "definition": text(x.get("definition"), 1500),
            "parent": ident(x.get("parent"), True) or None, "module": s(x.get("module"), 60),
            "aligned_to": s(x.get("aligned_to"), 200), "alignment": al if al in ALIGN else ("related" if s(x.get("aligned_to")) else ""),
            "synonyms": strs(x.get("synonyms"), 8, 100), "examples": strs(x.get("examples"), 6, 200),
            "abstract": bool(x.get("abstract")), "derived_from": s(x.get("derived_from"), 200)}


def clean_property(x) -> dict | None:
    if not isinstance(x, dict):
        return None
    i = ident(x.get("id") or x.get("label") or x.get("name"), False)
    if not i:
        return None
    kind = "data" if s(x.get("kind")).lower().startswith(("data", "attr")) else "object"
    rng = s(x.get("range"), 100)
    if kind == "data":
        r = rng.split(":")[-1]
        rng = r if r in XSD else _XSD_ALIAS.get(r.lower(), "string")
    else:
        rng = ident(rng, True)
    card = s(x.get("cardinality")).replace(" ", "").replace("n", "*").replace("many", "*")
    return {"id": i, "label": s(x.get("label"), 200) or label_of(i).lower(), "definition": text(x.get("definition"), 1500),
            "kind": kind, "domain": ident(x.get("domain"), True), "range": rng,
            "cardinality": card if card in CARDS else "0..*" if kind == "object" else "0..1",
            "inverse": ident(x.get("inverse"), False), "aligned_to": s(x.get("aligned_to"), 200),
            "derived_from": s(x.get("derived_from"), 200)}


def clean_individual(x) -> dict | None:
    if not isinstance(x, dict):
        return None
    i = ident(x.get("id") or x.get("label"), True)
    return {"id": i, "label": s(x.get("label"), 200) or label_of(i), "type": ident(x.get("type"), True),
            "definition": text(x.get("definition"), 800)} if i else None


def clean_rule(x, n=0) -> dict | None:
    if isinstance(x, str):
        x = {"statement": x}
    if not isinstance(x, dict) or not s(x.get("statement")):
        return None
    kind = s(x.get("kind")).lower()
    return {"id": s(x.get("id"), 20) or f"R{n + 1}", "label": s(x.get("label"), 200), "statement": text(x.get("statement"), 1500),
            "kind": kind if kind in ("constraint", "disjoint", "derivation", "definition") else "constraint",
            "applies_to": [ident(c, True) for c in strs(x.get("applies_to"), 10, 80)]}


def clean_use_case(x, n=0) -> dict | None:
    if not isinstance(x, dict) or not (s(x.get("question")) or s(x.get("title"))):
        return None
    return {"id": s(x.get("id"), 20) or f"UC{n + 1}", "title": s(x.get("title"), 200) or s(x.get("question"), 120),
            "actor": s(x.get("actor"), 120), "question": text(x.get("question"), 800), "description": text(x.get("description"), 2500),
            "classes": [ident(c, True) for c in strs(x.get("classes"), 30, 80)],
            "properties": [ident(p, False) for p in strs(x.get("properties"), 40, 80)],
            "answer_path": strs(x.get("answer_path"), 12, 500), "sparql": text(x.get("sparql"), 4000),
            "sample_answer": text(x.get("sample_answer"), 1500), "source": s(x.get("source"), 20) or "generated"}


def clean_explanation(x) -> dict:
    x = x if isinstance(x, dict) else {}
    dec = []
    for d in x.get("design_decisions") if isinstance(x.get("design_decisions"), list) else []:
        if isinstance(d, dict) and s(d.get("title")):
            dec.append({"title": s(d.get("title"), 200), "text": text(d.get("text"), 2000)})
        elif isinstance(d, str) and s(d):
            dec.append({"title": s(d, 120), "text": ""})
    notes = x.get("module_notes") if isinstance(x.get("module_notes"), dict) else {}
    return {"summary": text(x.get("summary"), 4000), "purpose": text(x.get("purpose"), 3000),
            "scope_in": strs(x.get("scope_in"), 20, 400), "scope_out": strs(x.get("scope_out"), 20, 400),
            "design_decisions": dec[:12], "how_to_read": text(x.get("how_to_read"), 3000),
            "module_notes": {s(k, 60): text(v, 2500) for k, v in list(notes.items())[:40] if text(v)},
            "standards_approach": text(x.get("standards_approach"), 3000)}


def clean(content: dict, max_classes: int = 250) -> dict:
    """Rebuild an ontology document from untrusted input. Dangling references are repaired or dropped."""
    c = content if isinstance(content, dict) else {}
    meta = c.get("meta") if isinstance(c.get("meta"), dict) else {}
    out = empty(s(meta.get("name"), 255), s(meta.get("domain"), 500), text(meta.get("scope"), 4000))
    if re.fullmatch(r"[a-z][a-z0-9]{0,11}", s(meta.get("prefix"))):
        out["meta"]["prefix"] = s(meta.get("prefix"))
    if _url(meta.get("namespace")) and s(meta.get("namespace"))[-1] in "#/":
        out["meta"]["namespace"] = s(meta.get("namespace"), 400)

    def uniq(items, fn):
        seen, res = set(), []
        for n, x in enumerate(items if isinstance(items, list) else []):
            y = fn(x, n) if fn in (clean_rule, clean_use_case) else fn(x)
            if y and y["id"].lower() not in seen:
                seen.add(y["id"].lower())
                res.append(y)
        return res

    out["standards"] = uniq(c.get("standards"), clean_standard)[:30]
    mods = []
    for m in c.get("modules") if isinstance(c.get("modules"), list) else []:
        if isinstance(m, dict) and s(m.get("id") or m.get("name")):
            mid = ident(m.get("id") or m.get("name"), True)
            if mid and mid not in [x["id"] for x in mods]:
                mods.append({"id": mid, "name": s(m.get("name"), 120) or label_of(mid), "description": text(m.get("description"), 1500)})
    classes = uniq(c.get("classes"), clean_class)[:max_classes]
    ids = {k["id"] for k in classes}
    mod_ids = {m["id"] for m in mods}
    for k in classes:
        k["module"] = ident(k["module"], True)
        if k["parent"] == k["id"] or k["parent"] not in ids:
            k["parent"] = None
    by = {k["id"]: k for k in classes}
    for k in classes:                               # break inheritance cycles
        seen, cur = {k["id"]}, k["parent"]
        while cur:
            if cur in seen:
                k["parent"] = None
                break
            seen.add(cur)
            cur = by[cur]["parent"]
    for k in classes:                               # a class without a module inherits its ancestor's
        cur = k
        while cur and cur["module"] not in mod_ids:
            cur = by.get(cur["parent"]) if cur["parent"] else None
        k["module"] = cur["module"] if cur else k["module"]
        if k["module"] not in mod_ids:
            if k["module"]:
                mods.append({"id": k["module"], "name": label_of(k["module"]), "description": ""})
            else:
                if "General" not in mod_ids:
                    mods.append({"id": "General", "name": "General", "description": ""})
                k["module"] = "General"
            mod_ids = {m["id"] for m in mods}
    out["modules"] = [m for m in mods if any(k["module"] == m["id"] for k in classes)] or mods[:0]
    out["classes"] = classes
    props = []
    for p in uniq(c.get("properties"), clean_property):
        if p["id"].lower() in {i.lower() for i in ids}:
            p["id"] = "has" + p["id"][:1].upper() + p["id"][1:]
        if p["domain"] not in ids or (p["kind"] == "object" and p["range"] not in ids):
            continue                                # a property must connect things that exist
        props.append(p)
    pids = {p["id"] for p in props}
    for p in props:
        if p["inverse"] not in pids or p["inverse"] == p["id"]:
            p["inverse"] = ""
    out["properties"] = props[:max_classes * 6]
    out["individuals"] = [i for i in uniq(c.get("individuals"), clean_individual) if i["type"] in ids and i["id"] not in ids][:600]
    rules = uniq(c.get("rules"), clean_rule)[:80]
    for r in rules:
        r["applies_to"] = [x for x in r["applies_to"] if x in ids]
    out["rules"] = rules
    out["explanation"] = clean_explanation(c.get("explanation"))
    out["explanation"]["module_notes"] = {k: v for k, v in out["explanation"]["module_notes"].items() if k in mod_ids}
    ucs = uniq(c.get("use_cases"), clean_use_case)[:60]
    for u in ucs:
        u["properties"] = [p for p in u["properties"] if p in pids]
        u["classes"] = [k for k in u["classes"] if k in ids]
        for p in props:                              # classes a listed property touches belong to the picture
            if p["id"] in u["properties"]:
                for k in (p["domain"], p["range"] if p["kind"] == "object" else None):
                    if k and k not in u["classes"]:
                        u["classes"].append(k)
    out["use_cases"] = ucs
    return out


def merge(base: dict, patch: dict, max_classes: int = 250) -> tuple[dict, dict]:
    """Apply additions / updates / removals (from a refine step, a completeness review or test-bed fixes).
    An element with an existing id replaces it. Returns (new content, counts)."""
    out = {k: (list(v) if isinstance(v, list) else dict(v) if isinstance(v, dict) else v) for k, v in base.items()}
    counts = {"added": 0, "updated": 0, "removed": 0}
    patch = patch if isinstance(patch, dict) else {}
    rm_c = {ident(x, True) for x in strs(patch.get("remove_classes"), 200, 80)}
    rm_p = {ident(x, False) for x in strs(patch.get("remove_properties"), 400, 80)}
    for key, rm in (("classes", rm_c), ("properties", rm_p)):
        before = len(out[key])
        out[key] = [x for x in out[key] if x["id"] not in rm]
        counts["removed"] += before - len(out[key])
    if rm_c:
        out["individuals"] = [i for i in out["individuals"] if i["type"] not in rm_c]
    for key, fn in (("modules", None), ("classes", clean_class), ("properties", clean_property),
                    ("individuals", clean_individual), ("rules", clean_rule)):
        incoming = patch.get(key) if isinstance(patch.get(key), list) else []
        for n, x in enumerate(incoming):
            if key == "modules":
                y = {"id": ident(x.get("id") or x.get("name"), True), "name": s(x.get("name"), 120), "description": text(x.get("description"), 1500)} \
                    if isinstance(x, dict) else None
                if y and not y["id"]:
                    y = None
            elif key == "rules":
                y = clean_rule(x, len(out["rules"]) + n)
            else:
                y = fn(x)
            if not y:
                continue
            idx = next((i for i, e in enumerate(out[key]) if e["id"].lower() == y["id"].lower()), None)
            if idx is None:
                out[key].append(y)
                counts["added"] += key != "modules"
            else:
                out[key][idx] = {**out[key][idx], **{k: v for k, v in y.items() if v not in ("", None, [])}}
                counts["updated"] += key != "modules"
    return clean(out, max_classes), counts


# ---- graph helpers ----------------------------------------------------------------------------
def index(c: dict) -> dict:
    classes = {k["id"]: k for k in c["classes"]}
    children: dict = {}
    for k in c["classes"]:
        children.setdefault(k["parent"], []).append(k["id"])
    return {"classes": classes, "props": {p["id"]: p for p in c["properties"]}, "children": children,
            "individuals": {i["id"]: i for i in c["individuals"]}}


def ancestors(ix: dict, cid: str) -> list[str]:
    out, cur = [], ix["classes"].get(cid, {}).get("parent")
    while cur and cur not in out:
        out.append(cur)
        cur = ix["classes"][cur]["parent"]
    return out


def descendants(ix: dict, cid: str) -> list[str]:
    out, todo = [], list(ix["children"].get(cid, []))
    while todo:
        x = todo.pop()
        out.append(x)
        todo.extend(ix["children"].get(x, []))
    return out


def props_of(c: dict, ix: dict, cid: str) -> list[dict]:
    """Properties of a class, including those inherited from its ancestors (marked)."""
    line = [cid] + ancestors(ix, cid)
    return [dict(p, inherited_from=p["domain"] if p["domain"] != cid else "") for p in c["properties"] if p["domain"] in line]


def stats(c: dict) -> dict:
    ix = index(c)
    depth = max((len(ancestors(ix, k)) + 1 for k in ix["classes"]), default=0)
    return {"modules": len(c["modules"]), "classes": len(c["classes"]),
            "object_properties": sum(p["kind"] == "object" for p in c["properties"]),
            "data_properties": sum(p["kind"] == "data" for p in c["properties"]),
            "individuals": len(c["individuals"]), "rules": len(c["rules"]), "use_cases": len(c["use_cases"]),
            "standards": len(c["standards"]), "aligned_classes": sum(bool(k["aligned_to"]) for k in c["classes"]),
            "max_depth": depth}


def components(c: dict, ix: dict) -> dict[str, int]:
    """Connected components of the class graph (object properties + inheritance, either direction)."""
    adj: dict = {k: set() for k in ix["classes"]}
    for k in c["classes"]:
        if k["parent"]:
            adj[k["id"]].add(k["parent"]); adj[k["parent"]].add(k["id"])
    for p in c["properties"]:
        if p["kind"] == "object":
            adj[p["domain"]].add(p["range"]); adj[p["range"]].add(p["domain"])
    comp, n = {}, 0
    for k in adj:
        if k in comp:
            continue
        todo = [k]
        while todo:
            x = todo.pop()
            if x not in comp:
                comp[x] = n
                todo.extend(adj[x] - comp.keys())
        n += 1
    return comp


# ---- quality checks (in the spirit of OOPS! pitfall scanning) ---------------------------------
def quality(c: dict) -> dict:
    ix = index(c)
    findings = []

    def add(code, severity, title, items, advice):
        if items:
            findings.append({"code": code, "severity": severity, "title": title, "items": sorted(set(items))[:60],
                             "count": len(set(items)), "advice": advice})

    used = {p["domain"] for p in c["properties"]} | {p["range"] for p in c["properties"] if p["kind"] == "object"}
    has_kids = {k["parent"] for k in c["classes"] if k["parent"]}
    typed = {i["type"] for i in c["individuals"]}
    add("Q01", "high", "Classes without a definition", [k["id"] for k in c["classes"] if len(k["definition"]) < 15],
        "Every class needs a one-sentence definition a business reader can check.")
    add("Q02", "medium", "Properties without a definition", [p["id"] for p in c["properties"] if len(p["definition"]) < 10],
        "Say what the property means and when it is filled in.")
    isolated = [k["id"] for k in c["classes"] if k["id"] not in used and k["id"] not in has_kids and k["id"] not in typed
                and not any(a in used for a in ancestors(ix, k["id"]))]
    add("Q03", "high", "Classes not connected to anything", isolated,
        "No property uses these classes and they inherit none. Add the relationships or attributes that give them a purpose, or remove them.")
    only_kid = [p for p, kids in ix["children"].items() if p and len(kids) == 1]
    add("Q04", "low", "Parents with a single subclass", only_kid,
        "A lone subclass often means the split is not needed yet, or sibling subclasses are missing.")
    labels: dict = {}
    for k in c["classes"]:
        labels.setdefault(k["label"].lower(), []).append(k["id"])
    add("Q05", "medium", "Different classes share the same label", [" / ".join(v) for v in labels.values() if len(v) > 1],
        "Readers cannot tell these apart. Rename one or merge them.")
    comp = components(c, ix)
    sizes: dict = {}
    for k, n in comp.items():
        sizes[n] = sizes.get(n, 0) + 1
    main = max(sizes, key=sizes.get) if sizes else None
    islands = [k for k, n in comp.items() if n != main and sizes[n] > 1]
    add("Q06", "medium", "Groups of classes cut off from the main model", islands,
        "These classes link to each other but not to the rest of the ontology, so questions cannot join across them.")
    nodata = [k["id"] for k in c["classes"] if not k["abstract"] and k["id"] not in has_kids
              and not any(p["kind"] == "data" for p in props_of(c, ix, k["id"])) and k["id"] not in typed]
    add("Q07", "low", "Leaf classes with no attributes", nodata,
        "Concrete classes usually carry at least an identifier, name, date or amount.")
    add("Q08", "low", "Relationships without an inverse", [p["id"] for p in c["properties"] if p["kind"] == "object" and not p["inverse"]],
        "Optional. An inverse (e.g. places / placedBy) makes navigation in both directions explicit.")
    add("Q09", "medium", "Naming convention", [k["id"] for k in c["classes"] if not re.fullmatch(r"[A-Z][A-Za-z0-9]*", k["id"])] +
        [p["id"] for p in c["properties"] if not re.fullmatch(r"[a-z][A-Za-z0-9]*", p["id"])],
        "Classes are UpperCamelCase nouns, properties lowerCamelCase verbs or attributes.")
    add("Q10", "medium", "Use cases that reference nothing in the ontology", [u["id"] for u in c["use_cases"] if not u["classes"]],
        "A use case should name the classes and properties that answer it.")
    covered = {k for u in c["use_cases"] for k in u["classes"]}
    if c["use_cases"]:
        unused_mods = [m["name"] for m in c["modules"] if not any(k["id"] in covered for k in c["classes"] if k["module"] == m["id"])]
        add("Q11", "low", "Modules no use case touches", unused_mods,
            "Either a use case is missing for this area, or the area is outside what the ontology is for.")
    if c["classes"] and not c["standards"]:
        findings.append({"code": "Q12", "severity": "medium", "title": "No industry standard is referenced", "items": [], "count": 1,
                         "advice": "Record the published ontologies or standards this model builds on."})
    weights = {"high": 3.0, "medium": 1.5, "low": 0.5}
    size = max(len(c["classes"]) + len(c["properties"]), 1)
    penalty = sum(weights[f["severity"]] * min(f["count"], size) for f in findings) / size
    score = max(0, round(100 - 100 * min(penalty / 3, 1))) if c["classes"] else 0
    order = {"high": 0, "medium": 1, "low": 2}
    findings.sort(key=lambda f: (order[f["severity"]], -f["count"]))
    return {"score": score, "findings": findings, "stats": stats(c)}


# ---- outline for prompts ---------------------------------------------------------------------
def outline(c: dict, definitions: bool = True, modules: set | None = None) -> str:
    """Compact text form of the ontology, used in prompts."""
    lines = ["MODULES"] + [f"- {m['id']}: {m['name']}" for m in c["modules"]]
    lines.append("\nCLASSES  (id | parent | module" + (" | definition)" if definitions else ")"))
    for k in c["classes"]:
        if modules and k["module"] not in modules:
            continue
        row = f"- {k['id']} | {k['parent'] or '-'} | {k['module']}"
        lines.append(row + (f" | {k['definition'][:220]}" if definitions else ""))
    lines.append("\nPROPERTIES  (id | kind | domain -> range | cardinality" + (" | definition)" if definitions else ")"))
    for p in c["properties"]:
        row = f"- {p['id']} | {p['kind']} | {p['domain']} -> {p['range']} | {p['cardinality']}"
        lines.append(row + (f" | {p['definition'][:160]}" if definitions else ""))
    if c["individuals"]:
        lines.append("\nCONTROLLED VALUES  (type: values)")
        by: dict = {}
        for i in c["individuals"]:
            by.setdefault(i["type"], []).append(i["id"])
        lines += [f"- {t}: {', '.join(v)}" for t, v in by.items()]
    if c["rules"]:
        lines.append("\nRULES")
        lines += [f"- {r['id']}: {r['statement'][:300]}" for r in c["rules"]]
    return "\n".join(lines)


# ---- test bed: verify what the model claimed ---------------------------------------------------
STATUS = ("covered", "partial", "missing")
KINDS = ("concept", "relationship", "attribute", "rule")


def verify_test(c: dict, raw: dict) -> dict:
    """Turn a model's coverage assessment into a checked result. Every mapped element must exist; a
    requirement claimed as covered without valid evidence is downgraded; the score is computed here."""
    ix = index(c)
    rule_ids = {r["id"] for r in c["rules"]}
    reqs = []
    for n, r in enumerate(raw.get("requirements") if isinstance(raw.get("requirements"), list) else []):
        if not isinstance(r, dict) or not s(r.get("text") or r.get("requirement")):
            continue
        kind = s(r.get("kind")).lower()
        kind = kind if kind in KINDS else "concept"
        status = s(r.get("status")).lower()
        status = status if status in STATUS else "missing"
        mapped, dropped = [], []
        for m in strs(r.get("mapped"), 12, 80):
            k, p = ident(m, True), ident(m, False)
            if k in ix["classes"]:
                mapped.append({"id": k, "type": "class"})
            elif p in ix["props"]:
                mapped.append({"id": p, "type": ix["props"][p]["kind"] + " property"})
            elif k in ix["individuals"]:
                mapped.append({"id": k, "type": "value"})
            elif m in rule_ids:
                mapped.append({"id": m, "type": "rule"})
            else:
                dropped.append(m)
        mapped = [m for i, m in enumerate(mapped) if m not in mapped[:i]]
        claimed, check = status, ""
        types = {m["type"] for m in mapped}
        if status != "missing" and not mapped:
            status, check = "missing", "Marked as addressed, but nothing it points to exists in the ontology."
        elif status == "covered":
            if dropped:
                status, check = "partial", f"Points to {', '.join(dropped)}, which does not exist in the ontology."
            elif kind == "relationship" and "object property" not in types:
                status, check = "partial", "The concepts exist, but no relationship (object property) links them."
            elif kind == "attribute" and not types & {"data property", "value"}:
                status, check = "partial", "The concept exists, but no attribute (data property) holds this value."
        reqs.append({"id": f"RQ{n + 1}", "text": s(r.get("text") or r.get("requirement"), 400), "kind": kind, "status": status,
                     "claimed": claimed, "mapped": mapped, "note": text(r.get("note") or r.get("rationale"), 800), "check": check})
    reqs = reqs[:40]
    counts = {k: sum(r["status"] == k for r in reqs) for k in STATUS}
    total = len(reqs)
    score = round((counts["covered"] + 0.5 * counts["partial"]) / total, 3) if total else 0.0
    # are the concepts the use case needs actually joined up?
    hit = sorted({m["id"] for r in reqs for m in r["mapped"] if m["type"] == "class"} |
                 {ix["props"][m["id"]]["domain"] for r in reqs for m in r["mapped"] if m["type"].endswith("property")})
    comp = components(c, ix)
    groups: dict = {}
    for k in hit:
        groups.setdefault(comp[k], []).append(k)
    disconnected = sorted(groups.values(), key=len, reverse=True)[1:] if len(groups) > 1 else []
    sug = raw.get("suggestions") if isinstance(raw.get("suggestions"), dict) else {}
    s_classes = [x for x in (clean_class(k) for k in (sug.get("classes") or []) if isinstance(k, dict)) if x and x["id"] not in ix["classes"]][:20]
    new_ids = set(ix["classes"]) | {k["id"] for k in s_classes}
    s_props = []
    for p in (sug.get("properties") or []) if isinstance(sug.get("properties"), list) else []:
        y = clean_property(p)
        if y and y["id"] not in ix["props"] and y["domain"] in new_ids and (y["kind"] == "data" or y["range"] in new_ids):
            s_props.append(y)
    for k in s_classes:
        if k["parent"] not in new_ids:
            k["parent"] = None
        if not any(m["id"] == k["module"] for m in c["modules"]):
            k["module"] = c["modules"][0]["id"] if c["modules"] else "General"
    verdict = "addressed" if score >= 0.85 and not counts["missing"] else "not_addressed" if score < 0.4 else "partly"
    gaps = [{"text": s(g.get("text") if isinstance(g, dict) else g, 500),
             "impact": s(g.get("impact"), 300) if isinstance(g, dict) else ""}
            for g in (raw.get("gaps") if isinstance(raw.get("gaps"), list) else []) if s(g.get("text") if isinstance(g, dict) else g)][:20]
    return {"title": s(raw.get("title"), 200), "summary": text(raw.get("summary"), 2500), "requirements": reqs, "counts": counts, "score": score,
            "verdict": verdict, "gaps": gaps, "disconnected": disconnected, "hit_classes": hit,
            "suggestions": {"classes": s_classes, "properties": s_props[:40]},
            "answer_path": strs(raw.get("answer_path"), 12, 500), "sparql": text(raw.get("sparql"), 4000),
            "downgraded": sum(bool(r["check"]) for r in reqs)}
