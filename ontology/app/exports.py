"""Standard exports: OWL (RDF/XML), Turtle, JSON-LD - built with rdflib - and the native JSON document."""
import json
import re

from rdflib import BNode, Graph, Literal, Namespace, URIRef
from rdflib.namespace import DCTERMS, OWL, RDF, RDFS, SKOS, XSD

from . import config, onto

FORMATS = {"ttl": ("turtle", "text/turtle", "ttl"), "owl": ("pretty-xml", "application/rdf+xml", "owl"),
           "jsonld": ("json-ld", "application/ld+json", "jsonld"), "json": (None, "application/json", "json")}


def filename(name: str, ext: str) -> str:
    return (re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower() or "ontology") + "." + ext


def _external(term: str, prefixes: dict) -> URIRef | None:
    """prefix:Term -> IRI, using the namespaces of the standards the ontology builds on."""
    if re.match(r"https?://\S+$", term):
        return URIRef(term)
    m = re.fullmatch(r"([A-Za-z][\w-]*):([\w.\-]+)", term or "")
    if m and prefixes.get(m.group(1)):
        return URIRef(prefixes[m.group(1)] + m.group(2))
    return None


def graph(c: dict, version: int = 0) -> Graph:
    g = Graph()
    ns = Namespace(c["meta"]["namespace"])
    g.bind(c["meta"]["prefix"] or "onto", ns)
    for p, n in (("owl", OWL), ("skos", SKOS), ("dcterms", DCTERMS)):
        g.bind(p, n)
    prefixes = {}
    for s in c["standards"]:
        if s["prefix"] and s["namespace"]:
            prefixes[s["prefix"]] = s["namespace"]
            g.bind(s["prefix"], Namespace(s["namespace"]), override=False)
    o = URIRef(c["meta"]["namespace"].rstrip("#/"))
    g.add((o, RDF.type, OWL.Ontology))
    g.add((o, RDFS.label, Literal(c["meta"]["name"], lang="en")))
    if c["explanation"].get("summary"):
        g.add((o, DCTERMS.description, Literal(c["explanation"]["summary"], lang="en")))
    if c["meta"]["scope"]:
        g.add((o, SKOS.scopeNote, Literal(c["meta"]["scope"], lang="en")))
    if version:
        g.add((o, OWL.versionInfo, Literal(str(version))))
    g.add((o, DCTERMS.creator, Literal(config.APP_NAME)))
    for s in c["standards"]:
        if s["url"]:
            g.add((o, DCTERMS.source, URIRef(s["url"])))
    for r in c["rules"]:
        g.add((o, SKOS.editorialNote, Literal(f"{r['id']} ({r['kind']}): {r['statement']}", lang="en")))
    module = ns["module"]
    g.add((module, RDF.type, OWL.AnnotationProperty))
    g.add((module, RDFS.label, Literal("module", lang="en")))
    mods = {m["id"]: m["name"] for m in c["modules"]}
    for k in c["classes"]:
        u = ns[k["id"]]
        g.add((u, RDF.type, OWL.Class))
        g.add((u, RDFS.label, Literal(k["label"], lang="en")))
        g.add((u, RDFS.isDefinedBy, o))
        if k["definition"]:
            g.add((u, SKOS.definition, Literal(k["definition"], lang="en")))
        if k["parent"]:
            g.add((u, RDFS.subClassOf, ns[k["parent"]]))
        if k.get("derived_from"):
            g.add((u, SKOS.note, Literal("Derived from: " + k["derived_from"], lang="en")))
        if k["module"] in mods:
            g.add((u, module, Literal(mods[k["module"]])))
        for x in k["synonyms"]:
            g.add((u, SKOS.altLabel, Literal(x, lang="en")))
        for x in k["examples"]:
            g.add((u, SKOS.example, Literal(x, lang="en")))
        ext = _external(k["aligned_to"], prefixes)
        if ext is not None:
            g.add((u, {"equivalent": OWL.equivalentClass, "subclass": RDFS.subClassOf}.get(k["alignment"], RDFS.seeAlso), ext))
    for p in c["properties"]:
        u = ns[p["id"]]
        obj = p["kind"] == "object"
        g.add((u, RDF.type, OWL.ObjectProperty if obj else OWL.DatatypeProperty))
        g.add((u, RDFS.label, Literal(p["label"], lang="en")))
        g.add((u, RDFS.isDefinedBy, o))
        if p["definition"]:
            g.add((u, SKOS.definition, Literal(p["definition"], lang="en")))
        g.add((u, RDFS.domain, ns[p["domain"]]))
        g.add((u, RDFS.range, ns[p["range"]] if obj else XSD[p["range"]]))
        if p["inverse"]:
            g.add((u, OWL.inverseOf, ns[p["inverse"]]))
        if p.get("derived_from"):
            g.add((u, SKOS.note, Literal("Derived from: " + p["derived_from"], lang="en")))
        if p["cardinality"] in ("0..1", "1"):
            g.add((u, RDF.type, OWL.FunctionalProperty))
        if p["cardinality"] in ("1", "1..*"):          # mandatory: a restriction on the domain class
            r = BNode()
            g.add((r, RDF.type, OWL.Restriction))
            g.add((r, OWL.onProperty, u))
            g.add((r, OWL.minCardinality, Literal(1, datatype=XSD.nonNegativeInteger)))
            g.add((ns[p["domain"]], RDFS.subClassOf, r))
        ext = _external(p["aligned_to"], prefixes)
        if ext is not None:
            g.add((u, RDFS.seeAlso, ext))
    for r in c["rules"]:                                # "A and B never overlap" is real logic a reasoner can test
        if r["kind"] == "disjoint":
            for n, a in enumerate(r["applies_to"]):
                for b in r["applies_to"][n + 1:]:
                    g.add((ns[a], OWL.disjointWith, ns[b]))
    for i in c["individuals"]:
        u = ns[i["id"]]
        g.add((u, RDF.type, OWL.NamedIndividual))
        g.add((u, RDF.type, ns[i["type"]]))
        g.add((u, RDFS.label, Literal(i["label"], lang="en")))
        if i["definition"]:
            g.add((u, SKOS.definition, Literal(i["definition"], lang="en")))
    return g


def export(c: dict, fmt: str, version: int = 0) -> tuple[bytes, str, str]:
    """-> (bytes, media type, file name)"""
    rd, media, ext = FORMATS[fmt]
    if fmt == "json":
        doc = {"format": "ontostudio-ontology", "format_version": 1, "version": version, "stats": onto.stats(c), **c}
        data = json.dumps(doc, indent=2, ensure_ascii=False)
    else:
        data = graph(c, version).serialize(format=rd)
    return data.encode("utf-8"), media, filename(c["meta"]["name"], ext)


# ---- import -------------------------------------------------------------------------------------
def import_file(name: str, data: bytes) -> dict:
    """An ontology file (.json in this app's format, or .ttl / .owl / .rdf / .jsonld / .nt) -> raw content for onto.clean."""
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext == "json":
        doc = json.loads(data.decode("utf-8"))
        if not isinstance(doc, dict) or "classes" not in doc:
            raise ValueError("This JSON file is not an ontology exported from this application.")
        return doc
    fmt = {"ttl": "turtle", "owl": "xml", "rdf": "xml", "xml": "xml", "jsonld": "json-ld", "nt": "nt", "n3": "n3"}.get(ext)
    if not fmt:
        raise ValueError("Use a .json, .ttl, .owl, .rdf, .jsonld or .nt file.")
    g = Graph()
    try:
        g.parse(data=data, format=fmt)
    except Exception as e:
        if fmt == "xml":                               # .owl files are sometimes Turtle
            try:
                g = Graph(); g.parse(data=data, format="turtle")
            except Exception:
                raise ValueError(f"The file could not be read as RDF/XML ({type(e).__name__}).")
        else:
            raise ValueError(f"The file could not be read as {fmt} ({type(e).__name__}).")

    def local(u):
        return re.split(r"[#/]", str(u).rstrip("#/"))[-1]

    def lit(s, *preds):
        best = None
        for p in preds:
            for o in g.objects(s, p):
                if isinstance(o, Literal) and (best is None or o.language in (None, "en")):
                    best = str(o)
            if best:
                return best
        return ""

    IAO_DEF = URIRef("http://purl.obolibrary.org/obo/IAO_0000115")
    cls = {s for t in (OWL.Class, RDFS.Class) for s in g.subjects(RDF.type, t) if isinstance(s, URIRef)}
    cls |= {s for s, o in g.subject_objects(RDFS.subClassOf) if isinstance(s, URIRef) and isinstance(o, URIRef)} - {OWL.Thing}
    ids = {u: onto.ident(local(u), True) for u in cls}
    classes = [{"id": ids[u], "label": lit(u, RDFS.label, SKOS.prefLabel), "definition": lit(u, SKOS.definition, IAO_DEF, RDFS.comment, DCTERMS.description),
                "parent": next((ids[o] for o in g.objects(u, RDFS.subClassOf) if o in ids and o != u), None), "module": "Imported",
                "synonyms": [str(o) for o in g.objects(u, SKOS.altLabel)][:8]} for u in sorted(cls, key=str)]
    props = []
    for kind, t in (("object", OWL.ObjectProperty), ("data", OWL.DatatypeProperty)):
        for u in sorted(set(g.subjects(RDF.type, t)), key=str):
            dom = next((ids[o] for o in g.objects(u, RDFS.domain) if o in ids), "")
            rng = next((o for o in g.objects(u, RDFS.range) if isinstance(o, URIRef)), None)
            inv = next((local(o) for o in g.objects(u, OWL.inverseOf)), "")
            props.append({"id": local(u), "label": lit(u, RDFS.label), "definition": lit(u, SKOS.definition, IAO_DEF, RDFS.comment), "kind": kind,
                          "domain": dom, "range": (ids.get(rng, "") if kind == "object" else local(rng)) if rng is not None else "",
                          "inverse": inv, "cardinality": "0..1" if (u, RDF.type, OWL.FunctionalProperty) in g else ""})
    inds = [{"id": local(s), "label": lit(s, RDFS.label), "type": ids[o], "definition": lit(s, SKOS.definition, RDFS.comment)}
            for s, o in g.subject_objects(RDF.type) if o in ids and isinstance(s, URIRef) and s not in ids]
    head = next(iter(g.subjects(RDF.type, OWL.Ontology)), None)
    return {"meta": {"name": lit(head, RDFS.label, DCTERMS.title) if head is not None else ""},
            "modules": [{"id": "Imported", "name": "Imported", "description": "Classes read from the imported file."}],
            "classes": classes, "properties": props, "individuals": inds,
            "explanation": {"summary": lit(head, DCTERMS.description, RDFS.comment) if head is not None else ""},
            "_dropped": {"properties": sum(1 for p in props if not p["domain"] or not p["range"])}}
