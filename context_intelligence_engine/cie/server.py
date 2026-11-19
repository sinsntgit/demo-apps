"""WP11 API + static UI server (stdlib only).  python -m cie.server --port 8080

Read-only DB connection per request. All responses are JSON; errors return {"error": ...} with a 4xx/5xx status.
"""
import argparse, json, re, sqlite3, traceback
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from .config import DB_PATH, UI_DIR, VERSIONS, K_ANON
from .lexicon import TEXT_SIGNALS, DERIVED_SIGNALS, FAMILY_CATEGORY
from . import api_insights as X, glossary

FAMILY_ORDER = ["need", "buying", "value", "risk", "friction", "experience", "geo", "temporal"]
STATIC = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}


def q(con, sql, args=()):
    return [dict(r) for r in con.execute(sql, args).fetchall()]


def _src_filter(p, alias="s"):
    src = (p.get("source") or ["all"])[0]
    if src in ("verizon_sample", "fixtures", "synthetic"):
        return f" AND {alias}.source=? ", [src]
    return " ", []


def overview(con, p):
    f, a = _src_filter(p)
    n = lambda sql: con.execute(sql + f, a).fetchone()[0]
    funnel = [
        ("Sessions", n("SELECT COUNT(*) FROM conversation_session s WHERE 1=1")),
        ("Traces", n("SELECT COUNT(*) FROM conversation_trace t JOIN conversation_session s USING(session_id) WHERE 1=1")),
        ("Signals", n("SELECT COUNT(*) FROM session_signal x JOIN conversation_session s USING(session_id) WHERE 1=1")),
        ("Episodes", n("SELECT COUNT(*) FROM session_episode e JOIN conversation_session s USING(session_id) WHERE 1=1")),
        ("Need journeys", con.execute("SELECT COUNT(*) FROM need_journey j JOIN conversation_session s ON s.session_id=j.first_session WHERE 1=1" + f, a).fetchone()[0]),
    ]
    by = lambda col: q(con, f"SELECT {col} AS k, COUNT(*) AS n FROM conversation_session s WHERE 1=1 {f} GROUP BY 1 ORDER BY 2 DESC", a)
    fam = {r["family"]: r for r in q(con, f"""SELECT family, COUNT(*) AS signals, COUNT(DISTINCT x.session_id) AS sessions
                     FROM session_signal x JOIN conversation_session s USING(session_id) WHERE 1=1 {f} GROUP BY 1""", a)}
    total = funnel[0][1] or 1
    l1 = q(con, f"""SELECT substr(si.intent_id,1,instr(si.intent_id||'.','.')-1) AS k, COUNT(*) AS n FROM session_intent si
                    JOIN conversation_session s USING(session_id) WHERE si.role='primary' {f} GROUP BY 1 ORDER BY 2 DESC""", a)
    feat = con.execute(f"""SELECT AVG(friction), SUM(opp_flag), SUM(repeat_contact), SUM(buying_flag), SUM(value_flag), SUM(risk_flag)
                           FROM session_feature x JOIN conversation_session s USING(session_id) WHERE 1=1 {f}""", a).fetchone()
    geo_cov = con.execute(f"SELECT AVG(CASE WHEN geo_source!='none' THEN 1.0 ELSE 0 END) FROM conversation_session s WHERE 1=1 {f}", a).fetchone()[0]
    return {
        "funnel": [{"stage": k, "n": v} for k, v in funnel],
        "sources": by("source"), "outcomes": by("outcome"), "auth": by("auth_state"), "lang": by("lang"), "geo_source": by("geo_source"),
        "families": [{"family": k, "label": FAMILY_CATEGORY[k], "signals": fam.get(k, {}).get("signals", 0),
                      "sessions": fam.get(k, {}).get("sessions", 0), "share": round(fam.get(k, {}).get("sessions", 0) / total, 3)} for k in FAMILY_ORDER],
        "l1": l1,
        "kpi": {"sessions": funnel[0][1], "avg_friction": round(feat[0] or 0, 3), "opportunity_sessions": feat[1] or 0,
                "repeat_contact_sessions": feat[2] or 0, "buying_sessions": feat[3] or 0, "value_sessions": feat[4] or 0,
                "risk_sessions": feat[5] or 0, "geo_coverage": round(geo_cov or 0, 3)},
        "versions": VERSIONS, "k_anon": K_ANON, "proxies": X.kpis(con, p),
        "cards": con.execute("SELECT COUNT(*) FROM evidence_card WHERE valid_to IS NULL").fetchone()[0],
        "clusters": con.execute("SELECT COUNT(*) FROM cluster_master").fetchone()[0],
        "patterns": con.execute("SELECT COUNT(*) FROM pattern_master").fetchone()[0],
    }


def sessions(con, p):
    f, a = _src_filter(p)
    where, args = [], list(a)
    if p.get("intent"):
        where.append("EXISTS (SELECT 1 FROM session_intent si WHERE si.session_id=s.session_id AND si.intent_id LIKE ?)"); args.append(p["intent"][0] + "%")
    if p.get("signal"):
        where.append("EXISTS (SELECT 1 FROM session_signal x WHERE x.session_id=s.session_id AND x.type=?)"); args.append(p["signal"][0])
    if p.get("outcome"):
        where.append("s.outcome=?"); args.append(p["outcome"][0])
    if p.get("q"):
        where.append("(s.session_id LIKE ? OR s.external_id LIKE ? OR EXISTS (SELECT 1 FROM conversation_turn t WHERE t.session_id=s.session_id AND t.user_text LIKE ?))")
        args += [f"%{p['q'][0]}%"] * 3
    w = (" AND " + " AND ".join(where)) if where else ""
    limit = min(int((p.get("limit") or [100])[0]), 500); offset = int((p.get("offset") or [0])[0])
    rows = q(con, f"""SELECT s.session_id, s.external_id, s.source, s.created_at, s.n_traces, s.auth_state, s.outcome, s.city, s.state,
                       s.thread_id, s.thread_pos, s.lang, si.intent_id AS primary_intent, si.confidence AS intent_conf, sf.segment, sf.friction,
                       (SELECT COUNT(*) FROM session_signal x WHERE x.session_id=s.session_id) AS n_signals
                       FROM conversation_session s LEFT JOIN session_intent si ON si.session_id=s.session_id AND si.role='primary'
                       LEFT JOIN session_feature sf ON sf.session_id=s.session_id WHERE 1=1 {f} {w}
                       ORDER BY s.source DESC, s.created_at LIMIT ? OFFSET ?""", args + [limit, offset])
    total = con.execute(f"SELECT COUNT(*) FROM conversation_session s WHERE 1=1 {f} {w}", args).fetchone()[0]
    return {"total": total, "rows": rows}


def session_detail(con, sid):
    s = q(con, "SELECT * FROM conversation_session WHERE session_id=?", (sid,))
    if not s:
        return None
    s = s[0]
    turns = q(con, "SELECT * FROM conversation_turn WHERE session_id=? ORDER BY seq", (sid,))
    tools = q(con, "SELECT seq, tool, agent_role, intent_name, query, requested_operator, failed FROM tool_call WHERE session_id=? ORDER BY seq", (sid,))
    sigs = q(con, "SELECT seq, family, category, type, value, text, confidence, method FROM session_signal WHERE session_id=? ORDER BY seq", (sid,))
    tint = q(con, "SELECT seq, intent_id, confidence, method, evidence FROM turn_intent WHERE session_id=?", (sid,))
    for t in turns:
        t["tools"] = [x for x in tools if x["seq"] == t["seq"]]
        t["signals"] = [x for x in sigs if x["seq"] == t["seq"]]
        t["intent"] = next((x for x in tint if x["seq"] == t["seq"]), None)
    names = {r["intent_id"]: r["name"] for r in q(con, "SELECT intent_id, name FROM dim_intent")}
    intents = q(con, "SELECT intent_id, role, confidence, method, evidence FROM session_intent WHERE session_id=?", (sid,))
    for i in intents:
        i["name"] = names.get(i["intent_id"])
    eps = q(con, "SELECT * FROM session_episode WHERE session_id=? ORDER BY ep_no", (sid,))
    for e in eps:
        e["intent_name"] = names.get(e["intent_id"])
    thread = q(con, """SELECT s.session_id, s.created_at, s.thread_pos, s.outcome, si.intent_id FROM conversation_session s
                       LEFT JOIN session_intent si ON si.session_id=s.session_id AND si.role='primary'
                       WHERE s.thread_id=? ORDER BY s.thread_pos""", (s["thread_id"],))
    journeys = q(con, "SELECT * FROM need_journey WHERE thread_id=?", (s["thread_id"],))
    evals = q(con, """SELECT metric, canonical_metric, value, value_text, scale, status, evaluator, substr(rationale,1,600) AS rationale
                      FROM agent_evaluation WHERE session_id=? AND entity_type='session' ORDER BY canonical_metric IS NULL, metric""", (sid,))
    verdicts = q(con, "SELECT policy_id, verdict, severity, policy_type, evidence, reason FROM policy_verdict WHERE session_id=?", (sid,))
    feat = q(con, "SELECT * FROM session_feature WHERE session_id=?", (sid,))
    raw = q(con, "SELECT landing_file, line_no, sha256 FROM raw_trace_session WHERE session_id=?", (sid,))
    ctx = X.session_context(con, sid)
    return {**ctx, "session": s, "turns": turns, "intents": intents, "episodes": eps, "thread": thread, "journeys": journeys,
            "evaluations": evals, "policy": verdicts, "features": feat[0] if feat else None, "raw": raw[0] if raw else None}


def taxonomy(con, p):
    f, a = _src_filter(p)
    nodes = q(con, "SELECT d.*, i.definition, i.include_criteria, i.exclude_criteria, i.examples, i.platform_intent_patterns FROM dim_intent d LEFT JOIN intent_definition i USING(intent_id) ORDER BY intent_id")
    cnt = {(r["intent_id"], r["role"]): r["n"] for r in q(con, f"""SELECT si.intent_id, si.role, COUNT(*) AS n FROM session_intent si
                 JOIN conversation_session s USING(session_id) WHERE 1=1 {f} GROUP BY 1,2""", a)}
    real = {r["intent_id"]: r["n"] for r in q(con, """SELECT si.intent_id, COUNT(*) AS n FROM session_intent si JOIN conversation_session s USING(session_id)
                 WHERE s.source='verizon_sample' AND si.role='primary' GROUP BY 1""")}
    for nd in nodes:
        nd["primary"] = cnt.get((nd["intent_id"], "primary"), 0)
        nd["secondary"] = cnt.get((nd["intent_id"], "secondary"), 0)
        nd["real_primary"] = real.get(nd["intent_id"], 0)
        for k in ("include_criteria", "exclude_criteria", "examples", "platform_intent_patterns"):
            nd[k] = json.loads(nd[k]) if nd.get(k) else []
    reviews = q(con, "SELECT * FROM review_log WHERE object_type='intent' ORDER BY review_id DESC LIMIT 50")
    platform = q(con, """SELECT c.intent_name, COUNT(*) AS n, COUNT(DISTINCT c.session_id) AS sessions FROM tool_call c JOIN conversation_session s USING(session_id)
                         WHERE c.intent_name IS NOT NULL AND s.source='verizon_sample' GROUP BY 1 ORDER BY 2 DESC""")
    return {"version": VERSIONS["taxonomy"], "nodes": nodes, "reviews": reviews, "platform_labels_real": platform}


def catalogue(con, p):
    f, a = _src_filter(p)
    cnt = {r["type"]: r for r in q(con, f"""SELECT type, COUNT(*) AS n, COUNT(DISTINCT x.session_id) AS sessions,
               SUM(CASE WHEN s.source='verizon_sample' THEN 1 ELSE 0 END) AS real_n FROM session_signal x
               JOIN conversation_session s USING(session_id) WHERE 1=1 {f} GROUP BY 1""", a)}
    items = [dict(family=fm, type=t, method="lexicon", confidence=c, description=d, pattern=rx.pattern) for fm, t, c, rx, d in TEXT_SIGNALS]
    items += [dict(family=fm, type=t, method=m, confidence=None, description=d, pattern=None) for fm, t, m, d in DERIVED_SIGNALS]
    seen = set()
    out = []
    for it in items:
        if it["type"] in seen:
            continue
        seen.add(it["type"])
        c = cnt.get(it["type"], {})
        it.update(category=FAMILY_CATEGORY[it["family"]], n=c.get("n", 0), sessions=c.get("sessions", 0), real_n=c.get("real_n", 0))
        it["examples"] = q(con, f"""SELECT x.session_id, x.seq, x.text, x.value, s.source FROM session_signal x JOIN conversation_session s USING(session_id)
                                   WHERE x.type=? {f} ORDER BY s.source DESC, x.confidence DESC LIMIT 3""", [it["type"]] + a)
        out.append(it)
    out.sort(key=lambda x: (FAMILY_ORDER.index(x["family"]), -x["n"]))
    return {"rules_version": VERSIONS["rules"], "signals": out}


def runs(con, p):
    return {"runs": q(con, "SELECT * FROM processing_run ORDER BY run_id DESC LIMIT 50"),
            "rejects": q(con, "SELECT * FROM ingest_reject ORDER BY rowid DESC LIMIT 50"),
            "provenance": q(con, "SELECT source, is_synthetic, batch, COUNT(*) AS n FROM data_provenance GROUP BY 1,2,3")}


def review(con_rw, body):
    import datetime as dt
    if body.get("object_type") not in ("intent", "card", "cluster", "candidate") or not body.get("object_id") or body.get("action") not in ("approve", "reject", "comment", "rename", "merge", "split"):
        raise ValueError("object_type, object_id and a valid action are required")
    con_rw.execute("INSERT INTO review_log(object_type,object_id,action,reviewer,note,at) VALUES(?,?,?,?,?,?)",
                   (body["object_type"], body["object_id"], body["action"], (body.get("reviewer") or "anonymous")[:80],
                    (body.get("note") or "")[:2000], dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")))
    con_rw.commit()
    return {"ok": True}


import threading
_CACHE, _CACHE_LOCK = {}, threading.Lock()
CACHEABLE = ("/api/overview", "/api/signals", "/api/geo", "/api/taxonomy", "/api/journeys", "/api/kpis", "/api/patterns", "/api/clusters",
             "/api/cards", "/api/taxonomy/candidates", "/api/validation", "/api/glossary")


def _version(con):
    """Cache key part: changes whenever a pipeline stage or a review writes."""
    r = con.execute("SELECT (SELECT MAX(run_id) FROM processing_run), (SELECT MAX(review_id) FROM review_log)").fetchone()
    return f"{r[0]}:{r[1]}"


class Handler(BaseHTTPRequestHandler):
    db_path = DB_PATH

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _ro(self):
        con = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        return con

    def _send_cached(self, key, payload):
        body = json.dumps(payload, default=str).encode()
        with _CACHE_LOCK:
            if len(_CACHE) > 500:
                _CACHE.clear()
            _CACHE[key] = body
        return self._send(200, body)

    def do_GET(self):
        u = urlparse(self.path)
        p = parse_qs(u.query)
        try:
            if u.path.startswith("/api/"):
                con = self._ro()
                try:
                    if u.path in CACHEABLE:
                        key = (u.path, u.query, _version(con))
                        with _CACHE_LOCK:
                            hit = _CACHE.get(key)
                        if hit is not None:
                            return self._send(200, hit)
                    m = re.match(r"^/api/sessions/([\w\-:.#]+)$", u.path)
                    if u.path == "/api/overview": return self._send_cached(key, overview(con, p))
                    if u.path == "/api/sessions": return self._send(200, sessions(con, p))
                    if m:
                        d = session_detail(con, m.group(1))
                        return self._send(200, d) if d else self._send(404, {"error": "session not found"})
                    if u.path == "/api/taxonomy": return self._send_cached(key, taxonomy(con, p))
                    if u.path == "/api/signals": return self._send_cached(key, catalogue(con, p))
                    if u.path == "/api/runs": return self._send(200, runs(con, p))
                    if u.path == "/api/glossary": return self._send_cached(key, glossary.payload())
                    if u.path == "/api/sources":
                        rows = con.execute("SELECT source, COUNT(*) FROM conversation_session GROUP BY 1").fetchall()
                        c = {r[0]: r[1] for r in rows}
                        return self._send(200, {"all": sum(c.values()), **c})
                    m2 = re.match(r"^/api/(cards|clusters)/(\d+)$", u.path)
                    if m2:
                        d = (X.card_detail if m2.group(1) == "cards" else X.cluster_detail)(con, int(m2.group(2)))
                        return self._send(200, d) if d else self._send(404, {"error": "not found"})
                    routes = {"/api/cards": X.cards_list, "/api/clusters": X.clusters_list, "/api/patterns": X.patterns_list, "/api/geo": X.geo,
                              "/api/journeys": X.journeys, "/api/search": X.search, "/api/ask": X.ask, "/api/validation": X.validation,
                              "/api/llm": X.llm_status, "/api/kpis": X.kpis, "/api/taxonomy/candidates": X.candidates}
                    if u.path in routes:
                        res = routes[u.path](con, p)
                        return self._send_cached(key, res) if u.path in CACHEABLE else self._send(200, res)
                    return self._send(404, {"error": "unknown endpoint"})
                finally:
                    con.close()
            name = "index.html" if u.path in ("/", "") else u.path.lstrip("/")
            fp = (UI_DIR / name).resolve()
            if UI_DIR.resolve() not in fp.parents or not fp.is_file():
                return self._send(404, {"error": "not found"})
            return self._send(200, fp.read_bytes(), STATIC.get(fp.suffix, "application/octet-stream"))
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"error": repr(e)[:300]})

    def do_POST(self):
        u = urlparse(self.path)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(n, 100_000)) or b"{}")
            m2 = re.match(r"^/api/(cards|clusters)/(\d+)/review$", u.path)
            if m2:
                con = sqlite3.connect(self.db_path)
                try:
                    fn = X.card_review if m2.group(1) == "cards" else X.cluster_review
                    return self._send(200, fn(con, int(m2.group(2)), body))
                finally:
                    con.close()
            if u.path in ("/api/review", "/api/taxonomy/review"):
                con = sqlite3.connect(self.db_path)
                try:
                    return self._send(200, review(con, body))
                finally:
                    con.close()
            return self._send(404, {"error": "unknown endpoint"})
        except ValueError as e:
            return self._send(400, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"error": repr(e)[:300]})


def serve(port=8080, host="127.0.0.1", db_path=None):
    Handler.db_path = db_path or DB_PATH
    srv = None
    for p in range(port, port + 20):                 # port busy or reserved (e.g. Windows WinError 10013) -> try the next one
        try:
            srv = ThreadingHTTPServer((host, p), Handler)
            break
        except OSError as e:
            print(f"port {p} unavailable ({e.__class__.__name__}: {e}); trying {p + 1}", flush=True)
    if srv is None:
        raise SystemExit(f"no free port between {port} and {port + 19}; try: python run_all.py --port 18080")
    port = srv.server_address[1]
    print(f"\n>>> Context Intelligence Engine UI: open http://{host}:{port}   (Ctrl+C to stop)\n", flush=True)

    def warm():
        import urllib.request
        for src in ("all", "verizon_sample", "synthetic"):
            for path in ("overview", "signals", "geo", "taxonomy", "journeys", "cards", "clusters?family=need", "search?q=warmup"):
                try:
                    urllib.request.urlopen(f"http://{host}:{port}/api/{path}{'&' if '?' in path else '?'}source={src}", timeout=120).read()
                except Exception:
                    pass
    threading.Thread(target=warm, daemon=True).start()
    srv.serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080); ap.add_argument("--host", default="127.0.0.1"); ap.add_argument("--db", default=None)
    a = ap.parse_args()
    serve(a.port, a.host, a.db)
