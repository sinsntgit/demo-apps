"""W3-W4 API handlers: KPI proxies, evidence cards (+ review), clusters (+ review), patterns, geography, journeys,
search/ask, validation, LLM tier status. Imported by server.py."""
import datetime as dt, json
from .config import REPORTS, K_ANON, SCORE_WEIGHTS, SCORING_VERSION, LLM_MODELS, LLM_MAX_SHARE
from .facts import facts_as_of, history
from .lexicon import CITY_INFO

_RETRIEVER = None


def q(con, sql, args=()):
    return [dict(r) for r in con.execute(sql, args).fetchall()]


def src(p, alias="s"):
    v = (p.get("source") or ["all"])[0]
    return (f" AND {alias}.source=? ", [v]) if v in ("verizon_sample", "synthetic", "fixtures") else (f" AND {alias}.source IN ('verizon_sample','synthetic','fixtures') ", [])   # constant list keeps the same fast index plan as a single source


def kpis(con, p):
    """AGENTS.md §7 KPI proxies (all labelled proxy)."""
    f, a = src(p)
    r = con.execute(f"""SELECT COUNT(*) n, SUM(sf.opp_flag) opp, SUM(s.outcome='escalated') esc,
          SUM(EXISTS(SELECT 1 FROM conversation_session x WHERE x.previous_session_id=s.session_id AND julianday(x.created_at)-julianday(s.created_at)<=7)) rep7
          FROM conversation_session s LEFT JOIN session_feature sf USING(session_id) WHERE 1=1 {f}""", a).fetchone()
    will = con.execute(f"""SELECT COUNT(DISTINCT x.session_id) FROM session_signal x JOIN conversation_session s USING(session_id)
          JOIN session_feature sf USING(session_id) WHERE x.type='willingness' AND sf.opp_flag=1 {f}""", a).fetchone()[0]
    unmet = con.execute(f"""SELECT AVG(e.outcome IN ('escalated','abandoned')) FROM session_episode e JOIN conversation_session s USING(session_id)
          JOIN dim_intent d ON d.intent_id=e.intent_id WHERE e.kind='goal' AND d.family IN ('buying','need') {f}""", a).fetchone()[0]
    churn = con.execute(f"""SELECT COUNT(*), SUM(s.outcome!='escalated' AND NOT EXISTS(SELECT 1 FROM conversation_session x WHERE x.previous_session_id=s.session_id))
          FROM conversation_session s WHERE EXISTS(SELECT 1 FROM session_signal z WHERE z.session_id=s.session_id AND z.type='churn_intent') {f}""", a).fetchone()
    n = r["n"] or 1
    dens = 100 * (r["opp"] or 0) / n
    conv = will / max(1, r["opp"] or 0)
    return {"note": "All KPIs are PROXIES from conversation behaviour; no revenue, conversion or churn outcome is claimed.",
            "qualified_opportunity_volume": r["opp"] or 0, "conversion_proxy": round(conv, 3), "unmet_need_share": round(unmet or 0, 3),
            "repeat_contact_rate_7d": round((r["rep7"] or 0) / n, 3), "escalation_rate": round((r["esc"] or 0) / n, 3),
            "save_rate_proxy": round((churn[1] or 0) / churn[0], 3) if churn[0] else None, "churn_intent_sessions": churn[0],
            "opportunity_density_per_100": round(dens, 2), "opportunity_index": 100}


def cards_list(con, p):
    w, a = ["c.valid_to IS NULL"], []
    for k in ("family", "kind", "status", "data_origin"):
        if p.get(k):
            w.append(f"c.{k}=?"); a.append(p[k][0])
    if p.get("q"):
        w.append("(c.title LIKE ? OR c.scope LIKE ?)"); a += [f"%{p['q'][0]}%"] * 2
    rows = q(con, f"""SELECT card_id, version, family, kind, title, observation, population, scope, confidence, composite, status, data_origin, scores
                      FROM evidence_card c WHERE {' AND '.join(w)} ORDER BY composite DESC""", a)
    for r in rows:
        r["scores"] = json.loads(r["scores"] or "{}")
    counts = q(con, "SELECT status, COUNT(*) n FROM evidence_card WHERE valid_to IS NULL GROUP BY 1")
    return {"cards": rows, "status_counts": counts, "score_weights": SCORE_WEIGHTS, "scoring_version": SCORING_VERSION}


def card_detail(con, cid):
    c = q(con, "SELECT * FROM evidence_card WHERE card_id=?", (cid,))
    if not c:
        return None
    c = c[0]
    for k in ("caveats", "scores", "metrics", "governance"):
        c[k] = json.loads(c[k] or "null")
    c["evidence"] = q(con, "SELECT * FROM evidence_ref WHERE card_id=?", (cid,))
    c["versions"] = q(con, "SELECT card_id, version, status, valid_from, valid_to, superseded_by, composite FROM evidence_card WHERE pattern_key=? ORDER BY version", (c["pattern_key"],))
    c["reviews"] = q(con, "SELECT * FROM review_log WHERE object_type='card' AND object_id IN (SELECT CAST(card_id AS TEXT) FROM evidence_card WHERE pattern_key=?) ORDER BY review_id DESC", (c["pattern_key"],))
    c["pattern"] = (q(con, "SELECT * FROM pattern_master WHERE pattern_id=?", (c["pattern_id"],)) or [None])[0]
    return c


def card_review(con_rw, cid, body):
    st = body.get("status")
    if st not in ("draft", "in_review", "approved", "rejected"):
        raise ValueError("status must be draft, in_review, approved or rejected")
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    n = con_rw.execute("UPDATE evidence_card SET status=?, reviewer=?, review_note=?, reviewed_at=? WHERE card_id=? AND valid_to IS NULL",
                       (st, (body.get("reviewer") or "anonymous")[:80], (body.get("note") or "")[:2000], now, cid)).rowcount
    if not n:
        raise ValueError("card not found or superseded (review the current version)")
    con_rw.execute("INSERT INTO review_log(object_type,object_id,action,reviewer,note,at) VALUES('card',?,?,?,?,?)",
                   (str(cid), st, (body.get("reviewer") or "anonymous")[:80], (body.get("note") or "")[:2000], now))
    con_rw.commit()
    return {"ok": True, "status": st}


def clusters_list(con, p):
    fam = (p.get("family") or ["need"])[0]
    rows = q(con, """SELECT cluster_id, stable_id, family, label, status, size, sessions, stability, silhouette, esc_rate, abandon_rate, published,
                     top_terms, top_intents, top_signals FROM cluster_master WHERE family=? ORDER BY size DESC""", (fam,))
    for r in rows:
        for k in ("top_terms", "top_intents", "top_signals"):
            r[k] = json.loads(r[k] or "[]")
    return {"family": fam, "clusters": rows, "families": q(con, "SELECT family, COUNT(*) n, SUM(published) published FROM cluster_master GROUP BY 1")}


def cluster_detail(con, cid):
    c = q(con, "SELECT * FROM cluster_master WHERE cluster_id=?", (cid,))
    if not c:
        return None
    c = c[0]; c.pop("centroid", None)
    for k in ("top_terms", "top_intents", "top_signals", "profile"):
        c[k] = json.loads(c[k] or "null")
    if c["family"] == "geo":
        c["members"] = c["profile"].get("cities", [])
        return c
    c["cities"] = q(con, """SELECT s.city, COUNT(*) n FROM session_cluster_membership m JOIN conversation_session s ON s.session_id=m.session_id
                            WHERE m.cluster_id=? GROUP BY 1 ORDER BY 2 DESC LIMIT 8""", (cid,))
    c["weekly"] = q(con, """SELECT s.day, COUNT(*) n FROM session_cluster_membership m JOIN conversation_session s ON s.session_id=m.session_id
                            WHERE m.cluster_id=? GROUP BY 1 ORDER BY 1""", (cid,))
    c["examples"] = q(con, """SELECT m.session_id, t.seq, t.user_text FROM session_cluster_membership m JOIN conversation_turn t ON t.session_id=m.session_id
                              WHERE m.cluster_id=? AND t.user_text IS NOT NULL AND length(t.user_text)>25 ORDER BY m.similarity DESC LIMIT 6""", (cid,))
    c["reviews"] = q(con, "SELECT * FROM review_log WHERE object_type='cluster' AND object_id=? ORDER BY review_id DESC", (str(cid),))
    return c


def cluster_review(con_rw, cid, body):
    act = body.get("action")
    if act not in ("approve", "rename", "reject", "comment"):
        raise ValueError("action must be approve, rename, reject or comment")
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    if act == "rename":
        if not body.get("label"):
            raise ValueError("label required for rename")
        con_rw.execute("UPDATE cluster_master SET label=?, status='renamed' WHERE cluster_id=?", (body["label"][:120], cid))
    elif act in ("approve", "reject"):
        con_rw.execute("UPDATE cluster_master SET status=? WHERE cluster_id=?", ("approved" if act == "approve" else "rejected", cid))
    con_rw.execute("INSERT INTO review_log(object_type,object_id,action,reviewer,note,at) VALUES('cluster',?,?,?,?,?)",
                   (str(cid), act, (body.get("reviewer") or "anonymous")[:80], (body.get("note") or body.get("label") or "")[:2000], now))
    con_rw.commit()
    return {"ok": True}


def patterns_list(con, p):
    w, a = [], []
    if p.get("kind"):
        w.append("p.kind=?"); a.append(p["kind"][0])
    rows = q(con, f"""SELECT p.*, s.value composite FROM pattern_master p LEFT JOIN pattern_score s ON s.pattern_id=p.pattern_id AND s.dimension='composite_provisional'
                      {'WHERE ' + ' AND '.join(w) if w else ''} ORDER BY s.value DESC LIMIT 300""", a)
    return {"patterns": rows, "kinds": q(con, "SELECT kind, COUNT(*) n FROM pattern_master GROUP BY 1"),
            "tests": q(con, "SELECT stats FROM processing_run WHERE stage='patterns' AND status='ok' ORDER BY run_id DESC LIMIT 1")}


def geo(con, p):
    f, a = src(p)
    rows = q(con, f"""SELECT s.city, s.state, s.region, COUNT(*) sessions, AVG(s.outcome='escalated') esc, AVG(sf.opp_flag) opp, AVG(sf.risk_flag) risk
                      FROM conversation_session s LEFT JOIN session_feature sf USING(session_id) WHERE s.city IS NOT NULL AND s.city!='UNKNOWN' {f}
                      GROUP BY 1,2,3 HAVING COUNT(*)>=? ORDER BY 4 DESC""", a + [K_ANON])
    top = {}
    for r in con.execute(f"""SELECT s.city, si.intent_id, COUNT(*) n FROM conversation_session s JOIN session_intent si ON si.session_id=s.session_id AND si.role='primary'
                             WHERE 1=1 {f} GROUP BY 1,2""", a):
        top.setdefault(r[0], []).append((r[2], r[1]))
    names = dict(con.execute("SELECT intent_id, name FROM dim_intent").fetchall())
    pats = {}
    for r in con.execute("SELECT dim_value, COUNT(*) FROM pattern_master WHERE dim_type='city' GROUP BY 1"):
        pats[r[0]] = r[1]
    cards = {}
    for r in con.execute("SELECT scope, card_id, title FROM evidence_card WHERE valid_to IS NULL"):
        for c in CITY_INFO:
            if (r[0] or "").startswith(c):
                cards.setdefault(c, []).append({"card_id": r[1], "title": r[2]})
    geoc = {}
    for r in con.execute("SELECT m.object_id, c.label FROM session_cluster_membership m JOIN cluster_master c USING(cluster_id) WHERE m.family='geo'"):
        geoc[r[0]] = r[1]
    gl = {r["city"]: r for r in rows}
    tot = sum(r["sessions"] for r in rows) or 1
    gopp = sum(r["opp"] * r["sessions"] for r in rows) / tot
    for r in rows:
        info = CITY_INFO.get(r["city"], {})
        r.update(lat=info.get("lat"), lon=info.get("lon"), opportunity_index=round(100 * r["opp"] / gopp) if gopp else None,
                 top_intents=[(names.get(i, i), n) for n, i in sorted(top.get(r["city"], []), reverse=True)[:3]], patterns=pats.get(r["city"], 0),
                 cards=cards.get(r["city"], []), demand_profile=geoc.get(r["city"]))
    cov = con.execute(f"SELECT AVG(CASE WHEN s.geo_source!='none' THEN 1.0 ELSE 0 END) FROM conversation_session s WHERE 1=1 {f}", a).fetchone()[0]
    return {"cities": rows, "geo_coverage": round(cov or 0, 3), "location_note": "Service location from an ASSUMED field contract (not caller location)."}


def journeys(con, p):
    names = dict(con.execute("SELECT intent_id, name FROM dim_intent").fetchall())
    seq = q(con, "SELECT p.*, s.value composite FROM pattern_master p LEFT JOIN pattern_score s ON s.pattern_id=p.pattern_id AND s.dimension='composite_provisional' WHERE kind='sequence' ORDER BY lift_shrunk DESC")
    emer = q(con, "SELECT * FROM pattern_master WHERE kind='emerging' ORDER BY trend DESC")
    sizes = q(con, "SELECT n, COUNT(*) threads FROM (SELECT thread_id, COUNT(*) n FROM conversation_session GROUP BY 1) GROUP BY 1 ORDER BY 1")
    nj = q(con, """SELECT intent_l2, COUNT(*) journeys, SUM(n_sessions>1) multi, AVG(resolved) resolved FROM need_journey GROUP BY 1
                   HAVING SUM(n_sessions>1)>=? ORDER BY 3 DESC LIMIT 15""", (K_ANON,))
    for r in nj:
        r["name"] = names.get(r["intent_l2"], r["intent_l2"])
    weekly = q(con, "SELECT week, SUM(sessions) n FROM agg_daily_intent GROUP BY 1 ORDER BY CAST(week AS INTEGER)")
    return {"sequences": seq, "emerging": emer, "thread_sizes": sizes, "need_journeys": nj, "weekly": weekly,
            "note": "Repeat contact is thread-linked via previous_session_id only (no customer id)."}


def retriever(con):
    global _RETRIEVER
    from .retrieval import Retriever
    if _RETRIEVER is None:
        _RETRIEVER = Retriever(con)
    _RETRIEVER.con = con
    return _RETRIEVER


def search(con, p):
    g = lambda k: (p.get(k) or [None])[0]
    filt = {k: g(k) for k in ("city", "intent", "segment", "outcome", "source", "asof", "region") if g(k)}
    if filt.get("source") == "all":
        filt.pop("source")                    # the UI's "All sources" is not a source name
    R = retriever(con)
    return {"results": R.search(g("q") or "", g("method") or "hybrid", filt, int(g("k") or 20)), "filters": filt}


def ask(con, p):
    return retriever(con).ask((p.get("q") or [""])[0])


def validation(con, p):
    f = REPORTS / "validation.json"
    if not f.exists():
        return {"error": "No validation report yet. Run: python -m cie.validate"}
    rep = json.load(open(f, encoding="utf-8"))
    last = con.execute("SELECT MAX(finished_at) FROM processing_run WHERE status='ok'").fetchone()[0]
    gen = rep.get("generated_at")
    rep["stale"] = bool(last and (not gen or gen < last))          # report older than the latest build of this database
    rep["last_build_at"] = last
    return rep


def llm_status(con, p):
    from .adapters import llm
    labels = q(con, "SELECT status, COUNT(*) n FROM llm_label GROUP BY 1")
    return {"enabled": llm.available(), "models": LLM_MODELS, "max_share": LLM_MAX_SHARE, "candidates": len(llm.candidates(con)), "labels": labels,
            "cache_rows": con.execute("SELECT COUNT(*) FROM llm_cache").fetchone()[0],
            "note": "Claude is used only for low-confidence adjudication; labels are accepted only when grounded and in agreement with the rules."}


def session_context(con, sid):
    s = con.execute("SELECT thread_id, created_at FROM conversation_session WHERE session_id=?", (sid,)).fetchone()
    if not s:
        return {}
    return {"facts_as_of_session": facts_as_of(con, s[0], s[1]), "fact_history": history(con, s[0]),
            "clusters": q(con, """SELECT m.family, c.cluster_id, c.label FROM session_cluster_membership m JOIN cluster_master c USING(cluster_id)
                                 WHERE m.session_id=?""", (sid,))}


def candidates(con, p):
    rows = q(con, "SELECT * FROM taxonomy_candidate ORDER BY parent_intent, size DESC")
    for r in rows:
        r["top_terms"] = json.loads(r["top_terms"] or "[]"); r["examples"] = json.loads(r["examples"] or "[]")
    return {"candidates": rows}
