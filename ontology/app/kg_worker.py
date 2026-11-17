"""Runs knowledge-graph queries in a separate process, so that a query that takes too long can be stopped
(the application kills this process at the time limit). The store is opened read-only: nothing can be written.

Reads one JSON request as the first line of stdin (for a live graph, followed by the graph as N-Triples):  {"store": folder, "query": SPARQL, "prefixes": {}, "limit": rows to return,
                                   "picture": {"data": IRI prefix of records, "max": records} | null}
and writes one JSON answer on stdout. Imports nothing from the application.
"""
import json
import re
import sys

COUNT_MAX = 100_000            # rows counted beyond those returned; past this the count says "more than"
SAFE_IRI = re.compile(r'^[^<>"{}|^`\\\s]+$')
RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
LABEL = "http://www.w3.org/2000/01/rdf-schema#label"


def term(px, t):
    if t is None:
        return None
    if isinstance(t, px.NamedNode):
        return {"t": "iri", "v": t.value}
    if isinstance(t, px.Literal):
        out = {"t": "lit", "v": t.value}
        dt = t.datatype.value if t.datatype is not None else ""
        if dt and not dt.endswith(("#string", "#langString")):
            out["dt"] = dt.rsplit("#", 1)[-1]
        if t.language:
            out["lang"] = t.language
        return out
    if isinstance(t, px.BlankNode):
        return {"t": "bnode", "v": t.value}
    return {"t": "lit", "v": str(t)}


def picture(px, store, focus: list, data: str, most: int) -> dict:
    """Records in the answer, what they link to, and the types, names and values of both."""
    focus = [x for x in dict.fromkeys(focus) if SAFE_IRI.match(x)][:most]
    if not focus:
        return {"focus": [], "triples": []}
    triples, extra = [], []
    vals = " ".join(f"<{x}>" for x in focus)
    for sol in store.query(f"SELECT ?s ?p ?o WHERE {{ VALUES ?s {{ {vals} }} ?s ?p ?o }} LIMIT 6000"):
        o = sol["o"]
        triples.append([sol["s"].value, sol["p"].value, term(px, o)])
        if isinstance(o, px.NamedNode) and o.value.startswith(data) and o.value not in focus and o.value not in extra:
            extra.append(o.value)
    extra = [x for x in extra if SAFE_IRI.match(x)][:max(0, most + 15 - len(focus))]
    if extra:
        vals = " ".join(f"<{x}>" for x in extra)
        for sol in store.query(f"SELECT ?s ?p ?o WHERE {{ VALUES ?s {{ {vals} }} VALUES ?p {{ <{RDF_TYPE}> <{LABEL}> }} ?s ?p ?o }} LIMIT 3000"):
            triples.append([sol["s"].value, sol["p"].value, term(px, sol["o"])])
    return {"focus": focus, "extra": extra, "triples": triples}


def main():
    raw = sys.stdin.buffer.read()
    head, _, body = raw.partition(b"\n")              # first line: the request; the rest (live graphs): the graph itself
    req = json.loads(head.decode("utf-8"))
    import pyoxigraph as px
    try:
        if req.get("inline"):                          # a live graph: held in memory only, never written to disk
            store = px.Store()
            store.load(body, px.RdfFormat.N_TRIPLES)
        else:
            store = px.Store.read_only(req["store"])
    except Exception as e:                                    # noqa: BLE001 - reported to the user plainly
        return {"error": "store", "message": f"The knowledge graph could not be opened ({type(e).__name__})."}
    try:
        res = store.query(req["query"], prefixes=req.get("prefixes") or None)
    except SyntaxError as e:
        return {"error": "syntax", "message": str(e)[:600]}
    except Exception as e:                                    # noqa: BLE001
        return {"error": "run", "message": f"{type(e).__name__}: {str(e)[:600]}"}
    limit = int(req.get("limit") or 500)
    try:
        if isinstance(res, px.QueryBoolean):
            return {"kind": "ask", "value": bool(res)}
        if isinstance(res, px.QuerySolutions):
            names = [v.value for v in res.variables]
            rows, n = [], 0
            for sol in res:
                n += 1
                if len(rows) < limit:
                    rows.append([term(px, sol[v]) for v in names])
                elif n >= COUNT_MAX:
                    break
            out = {"kind": "select", "columns": names, "rows": rows, "count": n, "more": n >= COUNT_MAX}
            pic = req.get("picture")
            if pic:
                focus = pic.get("focus") or [c["v"] for r in rows for c in r if c and c["t"] == "iri" and c["v"].startswith(pic["data"])]
                out["picture"] = picture(px, store, focus, pic["data"], int(pic.get("max") or 30))
            return out
        triples = []                                          # CONSTRUCT / DESCRIBE
        n = 0
        for t in res:
            n += 1
            if len(triples) < limit:
                triples.append([term(px, t.subject), term(px, t.predicate), term(px, t.object)])
        return {"kind": "select", "columns": ["subject", "predicate", "object"], "rows": triples, "count": n, "more": False}
    except Exception as e:                                    # noqa: BLE001 - errors while iterating results
        return {"error": "run", "message": f"{type(e).__name__}: {str(e)[:600]}"}


if __name__ == "__main__":
    sys.stdout.write(json.dumps(main()))
