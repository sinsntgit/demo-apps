"""Diagram layouts. Each function returns a neutral spec - nodes with pixel positions, edges, a legend -
that the browser draws as SVG (static/js/diagram.js) and the server draws with matplotlib for PDF and
PowerPoint (render.draw). One layout, two renderers: change the picture here and both follow.

Node: {id, label, x, y, w, h, group, style, attrs, sub}   (x, y = centre; style: class | root | dim | hit | gap)
Edge: {a, b, label, style}                                  (style: sub = "is a kind of", rel = relationship, gap = proposed)
"""
from . import onto

ROW, PAD = 26, 30


def _w(label: str, attrs=()) -> int:
    longest = max([len(label)] + [len(a) - 2 for a in attrs])
    return max(74, min(250, int(longest * 7.1) + 24))


def _groups(c: dict) -> dict:
    return {m["id"]: i for i, m in enumerate(c["modules"])}


def _legend(c: dict, used: set) -> list:
    return [{"group": i, "name": m["name"]} for i, m in enumerate(c["modules"]) if i in used]


def hierarchy(c: dict, module: str | None = None, max_depth: int | None = None, collapsed: set | None = None) -> dict:
    """Left-to-right tree of the class hierarchy. With `module`, that module's classes plus their ancestors.
    Branches deeper than `max_depth`, and the classes in `collapsed`, are folded: their subclasses are hidden and
    the box says how many. Each node carries `kids` and `collapsed` so a viewer can offer expand / collapse."""
    ix, grp = onto.index(c), _groups(c)
    keep = {k["id"] for k in c["classes"] if not module or k["module"] == module}
    if module:
        for k in list(keep):
            keep.update(onto.ancestors(ix, k))
    kids = {p: [k for k in v if k in keep] for p, v in ix["children"].items()}
    roots = [k["id"] for k in c["classes"] if k["id"] in keep and (not k["parent"] or k["parent"] not in keep)]
    title = next((m["name"] for m in c["modules"] if m["id"] == module), None) or c["meta"]["name"] or "Ontology"
    nodes, edges, widths, row = {}, [], {}, [0]

    def place(cid, depth):
        k = ix["classes"][cid]
        ch = kids.get(cid, [])
        hidden = bool(ch) and ((max_depth is not None and depth >= max_depth) or cid in (collapsed or ()))
        sub = f"+{len(onto.descendants(ix, cid))} more" if hidden else ""
        label = k["label"]
        node = {"id": cid, "label": label, "depth": depth, "group": grp.get(k["module"], 0), "sub": sub, "attrs": [], "kids": len(ch), "collapsed": hidden,
                "style": "dim" if module and k["module"] != module else "class", "w": _w(label + ("  " + sub if sub else "")), "h": 28}
        nodes[cid] = node
        widths[depth] = max(widths.get(depth, 0), node["w"])
        if not ch or hidden:
            node["row"] = row[0]
            row[0] += 1
        else:
            for x in ch:
                place(x, depth + 1)
                edges.append({"a": cid, "b": x, "label": "", "style": "sub"})
            node["row"] = (nodes[ch[0]]["row"] + nodes[ch[-1]]["row"]) / 2

    for r in roots:
        place(r, 1)
    root = {"id": "__root", "label": title, "depth": 0, "group": -1, "sub": "", "attrs": [], "kids": 0, "collapsed": False, "style": "root", "w": _w(title), "h": 30,
            "row": (nodes[roots[0]]["row"] + nodes[roots[-1]]["row"]) / 2 if roots else 0}
    widths[0] = root["w"]
    edges += [{"a": "__root", "b": r, "label": "", "style": "sub"} for r in roots]
    nodes = {"__root": root, **nodes}
    xs, x = {}, PAD
    for d in sorted(widths):
        xs[d] = x
        x += widths[d] + 46
    for n in nodes.values():
        n["x"] = xs[n["depth"]] + n["w"] / 2        # left-aligned within its column
        n["y"] = PAD + n.pop("row") * (ROW + 8) + 14
        del n["depth"]
    used = {n["group"] for n in nodes.values()}
    return {"kind": "hierarchy", "nodes": list(nodes.values()), "edges": edges, "width": x - 46 + PAD,
            "height": PAD * 2 + max(row[0], 1) * (ROW + 8), "legend": _legend(c, used)}


def relations(c: dict, class_ids: list, prop_ids: list | None = None, attrs: bool = True, hit: set | None = None, spread: bool = True, focus: set | None = None,
              gap_classes: list | None = None, gap_props: list | None = None, dim: set | None = None) -> dict:
    """Layered left-to-right graph of some classes and the relationships between them.
    prop_ids: limit to these properties (None = every property between the classes).
    focus: only links that touch one of these classes are drawn."""
    ix, grp = onto.index(c), _groups(c)
    ids = [k for i, k in enumerate(class_ids) if k in ix["classes"] and k not in class_ids[:i]]
    gap_classes, gap_props, hit, dim = gap_classes or [], gap_props or [], hit or set(), dim or set()
    gap_ids = [g["id"] for g in gap_classes if g["id"] not in ids]
    every = ids + gap_ids
    props = [p for p in c["properties"] if p["domain"] in ids and (prop_ids is None or p["id"] in prop_ids)]
    pair: dict = {}
    for p in props:                                  # one line per pair of classes; an inverse adds nothing to the picture
        if p["kind"] == "object" and p["range"] in ids and (not focus or p["domain"] in focus or p["range"] in focus):
            if (p["range"], p["domain"]) in pair and p["inverse"]:
                continue
            pair.setdefault((p["domain"], p["range"]), []).append(p["label"] or p["id"])
    edges = [{"a": a, "b": b, "label": ", ".join(v[:2]) + (f" +{len(v) - 2}" if len(v) > 2 else ""), "style": "rel"} for (a, b), v in pair.items()]
    for k in ids:
        par = ix["classes"][k]["parent"]
        if par in ids:
            edges.append({"a": par, "b": k, "label": "", "style": "sub"})
    for p in gap_props:
        if p["kind"] == "object" and p["domain"] in every and p["range"] in every:
            edges.append({"a": p["domain"], "b": p["range"], "label": p["label"] or p["id"], "style": "gap"})
    for g in gap_classes:
        if g.get("parent") in every and g["id"] in gap_ids:
            edges.append({"a": g["parent"], "b": g["id"], "label": "", "style": "gap-sub"})
    nodes = {}
    for k in every:
        is_gap = k in gap_ids
        src = next(g for g in gap_classes if g["id"] == k) if is_gap else ix["classes"][k]
        a = []
        if attrs:
            a = ["• " + (p["label"] or p["id"]) for p in props if p["kind"] == "data" and p["domain"] == k]
            a += ["+ " + (p["label"] or p["id"]) for p in gap_props if p["kind"] == "data" and p["domain"] == k]
            if len(a) > 7:
                a = a[:6] + [f"• … {len(a) - 6} more"]
        nodes[k] = {"id": k, "label": src["label"], "group": grp.get(src.get("module"), 0), "sub": "", "attrs": a,
                    "style": "gap" if is_gap else "hit" if k in hit else "dim" if k in dim else "class",
                    "w": _w(src["label"], a), "h": 30 + 15 * len(a)}
    # layering: breadth-first over all edges in either direction. With `spread`, the best-connected class
    # sits in the middle and its neighbourhoods are balanced to its left and right.
    adj: dict = {k: [] for k in every}
    for e in edges:
        if e["b"] not in adj[e["a"]]:
            adj[e["a"]].append(e["b"]); adj[e["b"]].append(e["a"])
    layer: dict = {}
    starts = sorted(every, key=lambda k: -len(adj[k])) if spread else every
    for start in starts:
        if start in layer:
            continue
        layer[start] = 0
        side = {start: 1}
        if spread and len(adj[start]) > 3:
            weight = {}
            for n in adj[start]:                     # size of what hangs off each neighbour
                seen, todo = {start, n}, [n]
                while todo:
                    for y in adj[todo.pop()]:
                        if y not in seen and y not in adj[start]:
                            seen.add(y); todo.append(y)
                weight[n] = sum(nodes[x]["h"] + 34 for x in seen) - nodes[start]["h"]
            load = {1: 0, -1: 0}
            for n in sorted(adj[start], key=lambda n: -weight[n]):
                if n in layer:
                    continue
                sd = 1 if load[1] <= load[-1] else -1
                side[n], layer[n] = sd, sd
                load[sd] += weight[n]
        todo = [start] + [n for n in adj[start] if n in side]
        while todo:
            x = todo.pop(0)
            for y in adj[x]:
                if y not in layer:
                    side[y] = side[x]
                    layer[y] = layer[x] + side[x]
                    todo.append(y)
    cols: dict = {}
    for k in every:
        cols.setdefault(layer[k], []).append(k)
    pos = {}
    for d in sorted(cols, key=abs):                  # order each column by where its neighbours already sit
        if d:
            cols[d].sort(key=lambda k: sum(pos[n] for n in adj[k] if n in pos) / max(1, sum(n in pos for n in adj[k])))
        y = 0
        for k in cols[d]:
            pos[k] = y + nodes[k]["h"] / 2
            y += nodes[k]["h"] + 34
    heights = {d: sum(nodes[k]["h"] + 34 for k in v) - 34 for d, v in cols.items()}
    tall = max(heights.values(), default=0)
    x, order = PAD, sorted(cols)
    for i, d in enumerate(order):
        w = max(nodes[k]["w"] for k in cols[d])
        nxt = order[i + 1] if i + 1 < len(order) else None
        longest = max([len(e["label"]) for e in edges if {layer[e["a"]], layer[e["b"]]} == {d, nxt}] or [0])
        for k in cols[d]:
            nodes[k]["x"] = x + w / 2
            nodes[k]["y"] = PAD + (tall - heights[d]) / 2 + pos[k]
        x += w + max(80, min(230, longest * 6 + 56))
    right = x - max(80, min(230, longest * 6 + 56)) + PAD if order else 200
    bends = 0
    for e in edges:                                  # a link inside one column bows out to the right, clear of the boxes between
        a, b = nodes[e["a"]], nodes[e["b"]]
        if layer[e["a"]] == layer[e["b"]] and abs(cols[layer[e["a"]]].index(e["a"]) - cols[layer[e["b"]]].index(e["b"])) > 1:
            between = [nodes[k] for k in cols[layer[e["a"]]] if min(a["y"], b["y"]) <= nodes[k]["y"] <= max(a["y"], b["y"])]
            e["cx"] = max(n["x"] + n["w"] / 2 for n in between) + 70 + 26 * bends
            e["cy"] = (a["y"] + b["y"]) / 2
            right = max(right, e["cx"] - 10 + len(e["label"]) * 3.2)
            bends += 1
    used = {n["group"] for n in nodes.values() if n["style"] != "gap"}
    return {"kind": "relations", "nodes": list(nodes.values()), "edges": edges, "width": max(right, 200),
            "height": tall + PAD * 2, "legend": _legend(c, used)}


def module_map(c: dict, module: str) -> dict:
    """A module's classes, their relationships, and the classes of other modules they link to (dimmed)."""
    own = [k["id"] for k in c["classes"] if k["module"] == module]
    outside = []
    for p in c["properties"]:
        if p["kind"] == "object":
            if p["domain"] in own and p["range"] not in own:
                outside.append(p["range"])
            if p["range"] in own and p["domain"] not in own:
                outside.append(p["domain"])
    outside = list(dict.fromkeys(outside))[:12]
    return relations(c, own + outside, attrs=False, dim=set(outside), focus=set(own))


def use_case(c: dict, uc: dict) -> dict:
    return relations(c, uc["classes"], prop_ids=uc["properties"], spread=len(uc["classes"]) > 5)


def test(c: dict, res: dict) -> dict:
    """What a tested use case touches: existing elements it maps to, and the proposed additions (dashed)."""
    ix = onto.index(c)
    props = [m["id"] for r in res["requirements"] for m in r["mapped"] if m["type"].endswith("property")]
    classes = list(res["hit_classes"])
    for p in props:
        if ix["props"][p]["kind"] == "object" and ix["props"][p]["range"] not in classes:
            classes.append(ix["props"][p]["range"])
    sug = res["suggestions"]
    for p in sug["properties"]:                       # show the existing classes a proposed link attaches to
        for k in (p["domain"], p["range"] if p["kind"] == "object" else None):
            if k in ix["classes"] and k not in classes:
                classes.append(k)
    for g in sug["classes"]:
        if g.get("parent") in ix["classes"] and g["parent"] not in classes:
            classes.append(g["parent"])
    return relations(c, classes, prop_ids=props, hit=set(res["hit_classes"]), gap_classes=sug["classes"], gap_props=sug["properties"])


RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
LANE_MAX = 12


def instances(c: dict, pic: dict, data_base: str) -> dict | None:
    """Records from a knowledge graph and the links between them: one column per class, in the order the
    classes first appear in the answer. Records that are in the answer are highlighted; the records they link to
    are drawn plainly. pic = {"focus": [IRI], "extra": [IRI], "triples": [[s, p, {t, v}]]} (kg_worker.picture)."""
    ix = onto.index(c)
    ns = c["meta"]["namespace"]
    focus = list(pic.get("focus", []))
    ents = focus + [x for x in pic.get("extra", []) if x not in focus]
    info = {e: {"types": [], "label": "", "attrs": []} for e in ents}
    links: dict = {}
    for s, p, o in pic.get("triples", []):
        e = info.get(s)
        if e is None:
            continue
        if p == RDF_TYPE:
            if o["t"] == "iri" and o["v"].startswith(ns) and o["v"][len(ns):] in ix["classes"]:
                e["types"].append(o["v"][len(ns):])
        elif p == RDFS_LABEL:
            if o["t"] == "lit" and not e["label"]:
                e["label"] = o["v"]
        elif p.startswith(ns) and p[len(ns):] in ix["props"]:
            prop = ix["props"][p[len(ns):]]
            if o["t"] == "iri" and o["v"] in info:
                links.setdefault((s, o["v"]), []).append(prop)
            elif o["t"] == "iri" and o["v"].startswith(ns):                 # a controlled value
                ind = ix["individuals"].get(o["v"][len(ns):])
                e["attrs"].append(f"• {prop['label']}: {ind['label'] if ind else o['v'][len(ns):]}")
            elif o["t"] == "lit" and s in focus:
                e["attrs"].append(f"• {prop['label']}: {o['v']}")
    for e in info.values():                              # the most specific class: not an ancestor of another one
        ts = list(dict.fromkeys(e["types"]))
        e["cls"] = next((t for t in ts if not any(t in onto.ancestors(ix, u) for u in ts if u != t)), None)
    ents = [x for x in ents if info[x]["cls"]]
    if not ents:
        return None
    lanes: list = []
    for x in ents:
        if info[x]["cls"] not in lanes:
            lanes.append(info[x]["cls"])
    shown, hidden = {}, {}
    for x in ents:
        k = info[x]["cls"]
        if sum(1 for y in shown if info[y]["cls"] == k) < LANE_MAX:
            shown[x] = True
        else:
            hidden[k] = hidden.get(k, 0) + 1
    nodes = {}
    for x in shown:
        e = info[x]
        attrs = [a if len(a) <= 40 else a[:39] + "…" for a in e["attrs"][:4]] + ([f"• … {len(e['attrs']) - 4} more"] if len(e["attrs"]) > 4 else [])
        lab = (e["label"] or x.rsplit("/", 1)[-1])[:44]
        nodes[x] = {"id": x, "label": lab, "group": lanes.index(e["cls"]), "sub": "", "attrs": attrs,
                    "style": "hit" if x in focus else "class", "w": _w(lab, attrs), "h": 30 + 15 * len(attrs)}
    for k, n in hidden.items():
        nid = f"more:{k}"
        lab = f"… {n} more {ix['classes'][k]['label']}"
        nodes[nid] = {"id": nid, "label": lab, "group": lanes.index(k), "sub": "", "attrs": [], "style": "dim", "w": _w(lab), "h": 30}
        info[nid] = {"cls": k}
    edges, done = [], set()
    for (a, b), props in links.items():
        if a not in nodes or b not in nodes or (b, a) in done:
            continue
        back = links.get((b, a), [])
        names = [p["label"] or p["id"] for p in props]
        names += [p["label"] or p["id"] for p in back if not any(q.get("inverse") == p["id"] or p.get("inverse") == q["id"] for q in props)]
        done.add((a, b))
        edges.append({"a": a, "b": b, "label": ", ".join(dict.fromkeys(names[:2])) + (f" +{len(names) - 2}" if len(names) > 2 else ""), "style": "rel"})
    if len([x for x in focus if x in nodes]) == 1:      # one record: it on the left, everything it links to stacked on the right
        one = next(x for x in focus if x in nodes)
        rest = sorted((x for x in nodes if x != one), key=lambda x: (lanes.index(info[x]["cls"]), nodes[x]["label"]))
        cols = {0: [one], 1: rest} if rest else {0: [one]}
        lanes_x = {x: (0 if x == one else 1) for x in nodes}
    else:
        cols = {i: [x for x in nodes if info[x]["cls"] == k] for i, k in enumerate(lanes)}
        lanes_x = {x: lanes.index(info[x]["cls"]) for x in nodes}
    heights = {i: sum(nodes[x]["h"] + 22 for x in v) - 22 for i, v in cols.items()}
    tall = max(heights.values(), default=0)
    x, right = PAD, PAD
    for i in range(len(cols)):
        w = max(nodes[n]["w"] for n in cols[i]) if cols[i] else 100
        y = PAD + (tall - heights[i]) / 2
        for n in cols[i]:
            nodes[n]["x"], nodes[n]["y"] = x + w / 2, y + nodes[n]["h"] / 2
            y += nodes[n]["h"] + 22
        longest = max([len(e["label"]) for e in edges if i in (lanes_x[e["a"]], lanes_x[e["b"]])] or [0])
        right = x + w + PAD
        x += w + max(90, min(230, longest * 6 + 60))
    bends = 0
    for e in edges:                                      # a link between records of the same class bows out to the right
        a, b = nodes[e["a"]], nodes[e["b"]]
        if lanes_x[e["a"]] == lanes_x[e["b"]]:
            e["cx"] = a["x"] + a["w"] / 2 + 60 + 22 * (bends % 4)
            e["cy"] = (a["y"] + b["y"]) / 2
            right = max(right, e["cx"] + 20 + len(e["label"]) * 3.2)
            bends += 1
    return {"kind": "instances", "nodes": list(nodes.values()), "edges": edges, "width": max(right, 200), "height": tall + PAD * 2,
            "legend": [{"group": i, "name": ix["classes"][k]["label"]} for i, k in enumerate(lanes)]}
