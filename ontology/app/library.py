"""The pre-built library: starter ontologies by industry that users copy and build on.

Each ontology is a plain-text file in `library/*.onto` (format below), so new ones can be added without
code. They are written for this application - condensed reference models aligned to the published
standards of each industry - and are NOT the official standards themselves (the UI says so). An official
ontology file can be brought in with Import.

File format (one item per line; indentation is free):

    id: lending                       short unique id
    name: Lending and loan origination
    industry: Banking & financial services
    domain: ...                       one line each: domain, scope, summary, purpose, read (how to read the model)
    in: a; b; c                       what is covered          out: a; b      what is not
    std: fibo | high | how it is used | term, term           a standard from catalogue.py (id | relevance | use | terms)
    == Party | Parties | description                         starts a module (id | name | description)
    Borrower : Party | definition | =schema:Person           a class (: parent optional; alignment optional:
                                                              =term equivalent, <term subclass, ~term related)
      - date of birth : date ! | definition                  an attribute (type; "!" = mandatory; definition optional)
      > applies for > LoanApplication * | definition | inverse label
                                                              a relationship (cardinality ? 1 * +; definition and inverse optional)
      * Draft, Submitted, Approved                           controlled values of the class
    rule: constraint | Label | statement | ClassA, ClassB    kind: constraint | derivation | disjoint | definition
    uc: Title | who asks | question | Class, Class | Class.attribute, relationship label
"""
import re
from functools import lru_cache
from pathlib import Path

from . import catalogue, config, onto

DIR = config.BASE_DIR / "library"
CARD = {"?": "0..1", "1": "1", "*": "0..*", "+": "1..*"}
TYPES = {"text": "string", "number": "decimal", "amount": "decimal", "count": "integer", "yesno": "boolean", "datetime": "dateTime", "year": "gYear", "link": "anyURI"}


class LibraryError(Exception):
    pass


def parse(text: str, source: str = "") -> dict:
    """Library file -> {"id", "name", "industry", "content"} with content ready for onto.clean."""
    head: dict = {}
    stds, modules, classes, props, inds, rules, ucs = [], [], [], [], [], [], []
    by_label: dict = {}             # (class id, property label) -> property id; label -> [ids]
    used: set = set()
    module = cls = None

    def fail(n, msg):
        raise LibraryError(f"{source} line {n}: {msg}")

    def split(s, n):
        parts = [p.strip() for p in s.split("|")]
        return parts + [""] * (n - len(parts))

    lines = text.splitlines()
    pending_uc = []
    for n, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("=="):
            mid, name, desc = split(line[2:], 3)
            module = onto.ident(mid, True)
            modules.append({"id": module, "name": name or mid, "description": desc})
            cls = None
        elif line.startswith("- "):
            if not cls:
                fail(n, "an attribute needs a class above it")
            spec, definition = split(line[2:], 2)
            m = re.fullmatch(r"(.+?)\s*:\s*(\w+)\s*(!?)", spec)
            if not m:
                fail(n, "attribute must look like '- name : type' (add ! if mandatory)")
            label, typ, must = m.group(1).strip(), m.group(2), m.group(3)
            typ = TYPES.get(typ.lower(), typ)
            if typ not in onto.XSD:
                fail(n, f"unknown type '{typ}'")
            pid = onto.ident(cls["id"] + " " + label, False)
            if pid in used:
                fail(n, f"attribute '{label}' is defined twice on {cls['id']}")
            used.add(pid)
            props.append({"id": pid, "label": label, "kind": "data", "domain": cls["id"], "range": typ, "cardinality": "1" if must else "0..1",
                          "definition": definition or f"The {label} of the {cls['label'].lower()}."})
            by_label[(cls["id"], label.lower())] = pid
            by_label.setdefault(label.lower(), []).append(pid)
        elif line.startswith("> "):
            if not cls:
                fail(n, "a relationship needs a class above it")
            spec, definition, inverse = split(line[2:], 3)
            m = re.fullmatch(r"(.+?)\s*>\s*(\w+)\s*([?1*+]?)", spec)
            if not m:
                fail(n, "relationship must look like '> label > TargetClass *'")
            label, target, card = m.group(1).strip(), m.group(2), m.group(3) or "*"
            pid = onto.ident(label, False)
            if pid in used:
                pid = onto.ident(label + " " + target, False)
            if pid in used:
                pid = onto.ident(cls["id"] + " " + label + " " + target, False)
            used.add(pid)
            props.append({"id": pid, "label": label, "kind": "object", "domain": cls["id"], "range": target, "cardinality": CARD[card],
                          "definition": definition, "_inverse": inverse, "_line": n})
            by_label[(cls["id"], label.lower())] = pid
            by_label.setdefault(label.lower(), []).append(pid)
        elif line.startswith("* "):
            if not cls:
                fail(n, "values need a class above them")
            for v in [x.strip() for x in line[2:].split(",") if x.strip()]:
                inds.append({"id": onto.ident(cls["id"] + " " + v, True), "label": v, "type": cls["id"], "definition": ""})
        elif re.match(r"(rule|uc|std|in|out|id|name|industry|domain|scope|summary|purpose|read)\s*:", line):
            key, rest = line.split(":", 1)
            key, rest = key.strip(), rest.strip()
            if key == "std":
                sid, rel, how, terms = split(rest, 4)
                ref = catalogue.BY_ID.get(sid)
                if not ref:
                    fail(n, f"'{sid}' is not in the standards catalogue")
                stds.append({**{k: ref[k] for k in ("id", "name", "publisher", "url", "prefix", "namespace", "kind")}, "relevance": rel or "medium",
                             "how_used": how, "reused_terms": [t.strip() for t in terms.split(",") if t.strip()], "in_catalogue": True})
            elif key == "rule":
                kind, label, statement, applies = split(rest, 4)
                rules.append({"id": f"R{len(rules) + 1}", "kind": kind, "label": label, "statement": statement,
                              "applies_to": [x.strip() for x in applies.split(",") if x.strip()]})
            elif key == "uc":
                pending_uc.append((n, split(rest, 5)))
            elif key in ("in", "out"):
                head[key] = [x.strip() for x in rest.split(";") if x.strip()]
            else:
                head[key] = rest
        else:                                           # a class
            if not module:
                fail(n, "a class needs a module (a line starting with ==) above it")
            name, definition, align = split(line, 3)
            m = re.fullmatch(r"([\w ]+?)\s*(?::\s*(\w+))?", name)
            if not m:
                fail(n, "class must look like 'ClassName : Parent | definition'")
            label_src = m.group(1).strip()
            cid = onto.ident(label_src, True)
            cls = {"id": cid, "label": onto.label_of(cid) if " " not in label_src else label_src, "parent": m.group(2), "module": module, "definition": definition,
                   "aligned_to": align[1:].strip() if align else "", "alignment": {"=": "equivalent", "<": "subclass", "~": "related"}.get(align[:1], "") if align else ""}
            if not definition:
                fail(n, f"class {cid} needs a definition")
            classes.append(cls)

    for key in ("id", "name", "industry", "domain", "summary"):
        if not head.get(key):
            raise LibraryError(f"{source}: '{key}:' is missing")
    ids = {c["id"]: c for c in classes}
    for c in classes:
        if c["parent"] and c["parent"] not in ids:
            raise LibraryError(f"{source}: class {c['id']} has an unknown parent '{c['parent']}'")
    for p in list(props):                               # relationships: targets, definitions, inverses
        if p["kind"] != "object" or "_line" not in p:
            continue
        n = p.pop("_line")
        inv = p.pop("_inverse")
        if p["range"] not in ids:
            fail(n, f"relationship '{p['label']}' points to an unknown class '{p['range']}'")
        if not p["definition"]:
            p["definition"] = f"{ids[p['domain']]['label']} {p['label']} {ids[p['range']]['label'].lower()}."
        if inv:
            iid = onto.ident(inv, False)
            if iid in used:
                iid = onto.ident(inv + " " + p["domain"], False)
            used.add(iid)
            p["inverse"] = iid
            props.append({"id": iid, "label": inv, "kind": "object", "domain": p["range"], "range": p["domain"], "cardinality": "0..*",
                          "definition": f"Inverse of “{p['label']}”.", "inverse": p["id"]})
            by_label[(p["range"], inv.lower())] = iid
            by_label.setdefault(inv.lower(), []).append(iid)
    for n, (title, actor, question, cl, pr) in pending_uc:
        want_c = [onto.ident(x, True) for x in cl.split(",") if x.strip()]
        for c in want_c:
            if c not in ids:
                fail(n, f"use case names an unknown class '{c}'")
        want_p = []
        for x in [x.strip() for x in pr.split(",") if x.strip()]:
            if "." in x:
                c, label = x.split(".", 1)
                pid = by_label.get((onto.ident(c, True), label.strip().lower()))
            else:
                hits = by_label.get(x.lower(), [])
                pid = hits[0] if len(hits) == 1 else None
                if len(hits) > 1:
                    fail(n, f"'{x}' exists on several classes - write it as Class.{x}")
            if not pid:
                fail(n, f"use case names an unknown property '{x}'")
            want_p.append(pid)
        ucs.append({"id": f"UC{len(ucs) + 1}", "title": title, "actor": actor, "question": question,
                    "description": f"Answered from {', '.join(ids[c]['label'] for c in want_c)}.", "classes": want_c, "properties": want_p,
                    "source": "library"})
    content = {"meta": {"name": head["name"], "domain": head["domain"], "scope": head.get("scope", "")}, "standards": stds, "modules": modules,
               "classes": classes, "properties": props, "individuals": inds, "rules": rules, "use_cases": ucs,
               "explanation": {"summary": head["summary"], "purpose": head.get("purpose", ""), "how_to_read": head.get("read", ""),
                               "scope_in": head.get("in", []), "scope_out": head.get("out", []),
                               "module_notes": {m["id"]: m["description"] for m in modules if m["description"]},
                               "standards_approach": "A starter model written for this application and aligned to the published standards listed "
                                                     "here. It condenses their core concepts; it is not the official standard. Extend it for your "
                                                     "organisation, and import the official ontology file if you need it in full."}}
    cleaned = onto.clean(content, 400)
    lost = {p["id"] for p in props} - {p["id"] for p in cleaned["properties"]}
    if lost or len(cleaned["classes"]) != len(classes) or len(cleaned["individuals"]) != len(inds):
        raise LibraryError(f"{source}: some elements did not survive validation: {sorted(lost)[:8]} "
                           f"(classes {len(classes)}→{len(cleaned['classes'])}, values {len(inds)}→{len(cleaned['individuals'])})")
    return {"id": re.sub(r"[^a-z0-9-]", "", head["id"].lower()), "name": head["name"], "industry": head["industry"], "content": cleaned}


@lru_cache(maxsize=1)
def load() -> dict:
    """All library ontologies, by id. A file that does not parse is reported and skipped, never a start-up blocker."""
    import logging
    out: dict = {}
    for path in sorted(DIR.glob("*.onto")) if DIR.is_dir() else []:
        try:
            item = parse(path.read_text(encoding="utf-8"), path.name)
        except (LibraryError, OSError, UnicodeDecodeError) as e:
            logging.getLogger("ontostudio").warning("Library file skipped: %s", e)
            continue
        out[item["id"]] = item
    if "retail" not in out:                             # the hand-written retail sample doubles as the retail entry
        from . import sample
        c = sample.content()
        c["meta"]["name"] = "Retail order management"
        out["retail"] = {"id": "retail", "name": "Retail order management", "industry": "Retail & e-commerce", "content": c}
    return dict(sorted(out.items(), key=lambda kv: (kv[1]["industry"], kv[1]["name"])))


def summary(item: dict) -> dict:
    c = item["content"]
    st = onto.stats(c)
    return {"id": item["id"], "name": item["name"], "industry": item["industry"], "domain": c["meta"]["domain"], "summary": c["explanation"]["summary"],
            "classes": st["classes"], "properties": st["object_properties"] + st["data_properties"], "use_cases": st["use_cases"],
            "modules": [m["name"] for m in c["modules"]], "standards": [s["name"].split(" - ")[0].split(" (")[0] for s in c["standards"]]}
