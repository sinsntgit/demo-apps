"""Logical test of an ontology with an OWL reasoner.

Two engines:
- "owlrl"  - OWL 2 RL rule reasoner (pure Python, always available). To expose classes that can never have a
             member, a probe individual is created for every class and for both ends of every relationship;
             a contradiction raised for a probe means that class (or relationship) is unsatisfiable.
- "hermit" - HermiT, a complete OWL 2 DL reasoner (via owlready2). Needs Java on the server.

A reasoner only tests what is stated as logic (subclassing, disjointness, domains and ranges, inverses,
mandatory properties). It cannot tell whether a concept is missing - that is what the test bed and the AI
gap review are for. The report says how much logic there was to test.
"""
import os
import re
import shutil
import tempfile
import time

from rdflib import Graph, URIRef
from rdflib.namespace import OWL, RDF, RDFS, XSD

from . import exports, onto

_HERMIT_OK = {"string", "integer", "decimal", "boolean", "dateTime", "anyURI"}


def engines() -> dict:
    try:
        import owlready2  # noqa: F401
        have = True
    except ImportError:
        have = False
    java = shutil.which("java")
    return {"owlrl": {"available": True, "label": "OWL 2 RL (built in)"},
            "hermit": {"available": bool(have and java), "label": "HermiT (OWL 2 DL)",
                       "why_not": "" if have and java else "Java is not installed on the server." if have else "The owlready2 package is not installed."}}


def _logic(c: dict) -> dict:
    return {"subclass": sum(bool(k["parent"]) for k in c["classes"]),
            "disjoint": sum(len(r["applies_to"]) * (len(r["applies_to"]) - 1) // 2 for r in c["rules"] if r["kind"] == "disjoint"),
            "domain_range": len(c["properties"]), "inverse": sum(bool(p["inverse"]) for p in c["properties"]) // 2,
            "mandatory": sum(p["cardinality"] in ("1", "1..*") for p in c["properties"]),
            "functional": sum(p["cardinality"] in ("0..1", "1") for p in c["properties"]),
            "typed_values": len(c["individuals"]),
            "alignments": sum(k["alignment"] in ("equivalent", "subclass") and bool(k["aligned_to"]) for k in c["classes"])}


def structural(c: dict) -> list:
    """Contradictions that follow from the definitions themselves; found without a reasoner, reported with it."""
    ix, out = onto.index(c), []
    for p in c["properties"]:
        q = ix["props"].get(p["inverse"])
        if q and p["kind"] == "object" and p["id"] < q["id"]:
            if q["inverse"] != p["id"]:
                out.append({"severity": "medium", "elements": [p["id"], q["id"]],
                            "text": f"{p['id']} names {q['id']} as its inverse, but {q['id']} names {q['inverse'] or 'nothing'}."})
            ok = lambda a, b: a == b or a in onto.ancestors(ix, b) or b in onto.ancestors(ix, a)  # noqa: E731
            if not (ok(p["domain"], q["range"]) and ok(p["range"], q["domain"])):
                out.append({"severity": "high", "elements": [p["id"], q["id"]],
                            "text": f"{p['id']} ({p['domain']} → {p['range']}) and its inverse {q['id']} ({q['domain']} → {q['range']}) "
                                    "do not mirror each other, so a reasoner would classify things on either end as both kinds."})
    for r in c["rules"]:
        if r["kind"] == "disjoint":
            for n, a in enumerate(r["applies_to"]):
                for b in r["applies_to"][n + 1:]:
                    if a == b or a in onto.ancestors(ix, b) or b in onto.ancestors(ix, a):
                        out.append({"severity": "high", "elements": [a, b],
                                    "text": f"Rule {r['id']} says {a} and {b} never overlap, yet one is a kind of the other."})
    return out


def _graph(c: dict, hermit: bool) -> Graph:
    g = exports.graph(c, 0)
    if hermit:                                         # HermiT rejects datatypes outside the OWL 2 map; swap them in this copy only
        for s, p, o in list(g.triples((None, RDFS.range, None))):
            if str(o).startswith(str(XSD)) and str(o).rsplit("#", 1)[-1] not in _HERMIT_OK:
                g.remove((s, p, o)); g.add((s, p, XSD.dateTime if "date" in str(o).lower() else XSD.string))
        for s, p, o in list(g):                        # annotations pointing outside are not logic
            if p in (RDFS.seeAlso,):
                g.remove((s, p, o))
    return g


def run(c: dict, engine: str = "owlrl") -> dict:
    t0 = time.time()
    ns = c["meta"]["namespace"]
    ix = onto.index(c)
    res = {"engine": engine, "consistent": True, "unsatisfiable": [], "problems": structural(c), "logic": _logic(c),
           "inferred": {}, "error": "", "notes": []}
    if not c["classes"]:
        res["error"] = "The ontology has no classes yet."
        return res
    local = lambda iri: str(iri)[len(ns):] if str(iri).startswith(ns) else str(iri)  # noqa: E731
    if engine == "hermit":
        if not engines()["hermit"]["available"]:
            res["error"] = "HermiT is not available on this server: " + engines()["hermit"]["why_not"]
            return res
        import owlready2
        path = tempfile.mktemp(suffix=".owl")
        try:
            _graph(c, True).serialize(path, format="xml")
            world = owlready2.World()
            o = world.get_ontology("file://" + path).load()
            try:
                with o:
                    owlready2.sync_reasoner_hermit(world, infer_property_values=False, debug=0)
                bad = [local(k.iri) for k in world.inconsistent_classes()]
                res["unsatisfiable"] = sorted(b for b in bad if b in ix["classes"])
            except owlready2.OwlReadyInconsistentOntologyError:
                res["consistent"] = False
                res["problems"].append({"severity": "high", "elements": [],
                                        "text": "HermiT found the ontology inconsistent: its statements contradict each other, so "
                                                "nothing can be concluded from it. The built-in reasoner names the elements involved."})
            except owlready2.OwlReadyJavaError as e:
                msg = re.sub(r"\s+", " ", str(e))
                res["error"] = "HermiT could not process the ontology: " + (msg.split("Exception")[-1][:300] if "Exception" in msg else msg[:300])
        finally:
            if os.path.exists(path):
                os.unlink(path)
    else:
        import owlrl
        g = _graph(c, False)
        before = len(g)
        asserted_sub = set(g.triples((None, RDFS.subClassOf, None)))
        for k in c["classes"]:
            g.add((URIRef(ns + "_probe_" + k["id"]), RDF.type, URIRef(ns + k["id"])))
        for p in c["properties"]:
            if p["kind"] == "object":
                g.add((URIRef(ns + "_from_" + p["id"]), URIRef(ns + p["id"]), URIRef(ns + "_to_" + p["id"])))
        owlrl.DeductiveClosure(owlrl.OWLRL_Semantics).expand(g)
        err = URIRef("http://www.daml.org/2002/03/agents/agent-ont#error")
        unsat, seen = set(), set()
        for _, _, msg in g.triples((None, err, None)):
            m = str(msg)
            hit = re.findall(re.escape(ns) + r"_(probe|from|to)_(\w+)", m)
            pretty = re.sub(re.escape(ns), "", m)
            for kind, name in hit:
                if kind == "probe" and name in ix["classes"]:
                    unsat.add(name)
                    text = "No " + name + " can exist: " + re.sub(r"_probe_\w+", "any " + name, pretty)
                    els = [name]
                else:
                    text = f"The relationship {name} cannot hold between anything: " + re.sub(r"_(from|to)_\w+", "its " + ("subject" if kind == "from" else "object"), pretty)
                    els = [name]
                if text not in seen:
                    seen.add(text)
                    res["problems"].append({"severity": "high", "elements": els, "text": text})
            if not hit and pretty not in seen:
                seen.add(pretty)
                res["consistent"] = False
                res["problems"].append({"severity": "high", "elements": [], "text": pretty})
        res["unsatisfiable"] = sorted(unsat)
        inferred_sub = {(local(s), local(o)) for s, _, o in g.triples((None, RDFS.subClassOf, None))
                        if (s, RDFS.subClassOf, o) not in asserted_sub and local(s) in ix["classes"] and local(o) in ix["classes"] and s != o}
        types = sum(1 for i in c["individuals"] for _, _, t in g.triples((URIRef(ns + i["id"]), RDF.type, None))
                    if local(t) in ix["classes"] and local(t) != i["type"])
        res["inferred"] = {"statements": len(g) - before, "subclass": len(inferred_sub), "value_types": types,
                           "examples": [f"{a} is a kind of {b}" for a, b in sorted(inferred_sub)[:8]]}
    lg = res["logic"]
    if not lg["disjoint"]:
        res["notes"].append("No 'never overlap' (disjointness) rules are declared, so the reasoner cannot detect something being "
                            "classified as two incompatible kinds. Add disjoint rules for sibling classes that must not overlap.")
    if not lg["mandatory"]:
        res["notes"].append("No property is mandatory, so the reasoner cannot flag incomplete records.")
    res["seconds"] = round(time.time() - t0, 1)
    res["problems"].sort(key=lambda p: p["severity"] != "high")
    return res
