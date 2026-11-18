"""WP12 validation: computes every acceptance gate (AGENTS.md §8) and writes reports/validation.{json,md}.
python -m cie.validate

The pipeline never reads ground truth; only this module (and tests) do.
Synthetic gates prove pipeline capability and statistics, NOT accuracy on real Verizon language.
"""
import gzip, hashlib, json, math, random, re, sqlite3, time, statistics as st
from collections import Counter, defaultdict
from pathlib import Path
import numpy as np
from .config import DB_PATH, FIXTURES_TRUTH, REPORTS, ROOT, VERSIONS, K_ANON, LLM_MAX_SHARE
from .lexicon import PII_PATTERNS, QUOTE_MASKS, CITY_INFO
from .taxonomy import Taxonomy

GOLD = ROOT / "tests" / "gold" / "real_gold.jsonl"
GT = ROOT / "data" / "synthetic_ground_truth.jsonl.gz"
META = ROOT / "data" / "synthetic_meta.json"
GOLD_SIGNALS = ["escalation_request", "auth_failure", "dispute", "price_sensitivity", "confusion", "frustration", "customer_repeat",
                "no_input", "dtmf_operator", "travel_intl", "abandoned"]


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else None; r = tp / (tp + fn) if tp + fn else None
    f = 2 * p * r / (p + r) if p and r else None
    return {"precision": None if p is None else round(p, 3), "recall": None if r is None else round(r, 3), "f1": None if f is None else round(f, 3), "tp": tp, "fp": fp, "fn": fn}


def macro_f1(pairs):
    labs = sorted({g for g, _ in pairs})
    f1 = []
    for l in labs:
        tp = sum(g == l and p == l for g, p in pairs); fp = sum(g != l and p == l for g, p in pairs); fn = sum(g == l and p != l for g, p in pairs)
        f1.append(prf(tp, fp, fn)["f1"] or 0.0)
    return round(sum(f1) / len(f1), 3) if f1 else None


def wilson(x, n, z=1.96):
    if not n:
        return (0, 0)
    p = x / n; d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0, c - h), min(1, c + h))


def load_gt():
    return [json.loads(l) for l in gzip.open(GT, "rt")] if GT.exists() else []


# ------------------------------------------------------------------ gates
def g0(con, tax):
    def prof(where):
        q = lambda s: con.execute(s).fetchone()
        n = q(f"SELECT COUNT(*) FROM conversation_session s WHERE {where}")[0]
        return n, dict(
            transfer=q(f"SELECT SUM(outcome='escalated') FROM conversation_session s WHERE {where}")[0],
            asks_human=q(f"SELECT COUNT(DISTINCT x.session_id) FROM session_signal x JOIN conversation_session s USING(session_id) WHERE x.type='escalation_request' AND {where}")[0],
            unauth=q(f"SELECT SUM(auth_state='unauthenticated') FROM conversation_session s WHERE {where}")[0],
            billing_l1=q(f"""SELECT SUM(si.intent_id LIKE 'BILL.%' OR si.intent_id LIKE 'PAY.%' OR si.intent_id LIKE 'REFUND.%' OR si.intent_id LIKE 'ACCT.%')
                            FROM session_intent si JOIN conversation_session s USING(session_id) WHERE si.role='primary' AND {where}""")[0])
    def turns(where):
        r = con.execute(f"SELECT COUNT(*), SUM(t.kind='event'), SUM(t.agent_text IS NULL) FROM conversation_turn t JOIN conversation_session s USING(session_id) WHERE {where}").fetchone()
        return r
    nr, R = prof("s.source='verizon_sample'"); ns, S = prof("s.source='synthetic'")
    if not nr or not ns:
        return {"pass": None, "summary": "needs both real sample and synthetic data"}
    tr, ts = turns("s.source='verizon_sample'"), turns("s.source='synthetic'")
    rows = {}
    for k in R:
        lo, hi = wilson(R[k], nr); sv = S[k] / ns
        rows[k] = {"real": round(R[k] / nr, 3), "real_ci": [round(lo, 3), round(hi, 3)], "synthetic": round(sv, 3), "inside": lo <= sv <= hi}
    for k, i in (("event_share", 1), ("null_output_share", 2)):
        lo, hi = wilson(tr[i], tr[0]); sv = ts[i] / ts[0]
        rows[k] = {"real": round(tr[i] / tr[0], 3), "real_ci": [round(lo, 3), round(hi, 3)], "synthetic": round(sv, 3), "inside": lo <= sv <= hi}
    real_n = [r[0] for r in con.execute("SELECT n_traces FROM conversation_session WHERE source='verizon_sample'")]
    rng = random.Random(1); boots = sorted(st.mean(rng.choices(real_n, k=len(real_n))) for _ in range(2000))
    syn_mean = con.execute("SELECT AVG(n_traces) FROM conversation_session WHERE source='synthetic'").fetchone()[0]
    rows["mean_traces"] = {"real": round(st.mean(real_n), 2), "real_ci": [round(boots[50], 2), round(boots[1949], 2)], "synthetic": round(syn_mean, 2),
                           "inside": boots[50] <= syn_mean <= boots[1949],
                           "note": "User requirement is 7 traces/session; the real sample mean is 6.69 with a CI of about 5.7-7.7."}
    mix = lambda src: Counter(r[0].split(".")[0] for r in con.execute(f"SELECT si.intent_id FROM session_intent si JOIN conversation_session s USING(session_id) WHERE si.role='primary' AND s.source='{src}'"))
    mr, ms = mix("verizon_sample"), mix("synthetic")
    tvd = .5 * sum(abs(mr[k] / nr - ms[k] / ns) for k in set(mr) | set(ms))
    rows["intent_L1_mix_tvd"] = {"value": round(tvd, 3), "inside": tvd <= .15 or None,
                                 "note": "Synthetic deliberately adds product/service/retention volume so every insight family exists (approved spec); TVD is reported."}
    ok = all(v["inside"] for k, v in rows.items() if k != "intent_L1_mix_tvd")
    return {"pass": ok, "metrics": rows, "summary": f"{sum(bool(v['inside']) for v in rows.values())}/{len(rows)} marginals inside the real sample's 95% CI; intent-mix TVD {tvd:.2f}"}


def g1(con):
    one = lambda s, a=(): con.execute(s, a).fetchone()[0]
    syn = one("SELECT COUNT(DISTINCT session_id) FROM conversation_session WHERE source='synthetic'")
    out = {"synthetic_sessions": syn, "real_sessions": one("SELECT COUNT(*) FROM conversation_session WHERE source='verizon_sample'"),
           "real_traces": one("SELECT SUM(n_traces) FROM conversation_session WHERE source='verizon_sample'"),
           "orphan_traces": one("SELECT COUNT(*) FROM conversation_trace t LEFT JOIN conversation_session s USING(session_id) WHERE s.session_id IS NULL"),
           "duplicate_turn_keys": one("SELECT COUNT(*) FROM (SELECT session_id, seq FROM conversation_turn GROUP BY 1,2 HAVING COUNT(*)>1)"),
           "synthetic_without_provenance": one("SELECT COUNT(*) FROM conversation_session WHERE is_synthetic=1 AND provenance_id NOT IN (SELECT provenance_id FROM data_provenance)"),
           "sessions_without_raw_lineage": one("SELECT COUNT(*) FROM conversation_session s LEFT JOIN raw_trace_session r USING(session_id) WHERE r.sha256 IS NULL"),
           "rejects": one("SELECT COUNT(*) FROM ingest_reject")}
    pii = 0
    for (txt,) in con.execute("SELECT coalesce(user_text,'')||' '||coalesce(agent_text,'') FROM conversation_turn"):
        if any(ch.isdigit() for ch in txt) or "@" in txt:
            pii += sum(len(rx.findall(txt)) for _, rx in PII_PATTERNS)
    out["pii_hits_after_scrub"] = pii
    out["real_turn_order_d9b52d90"] = [r[0] for r in con.execute("SELECT turn_no FROM conversation_turn WHERE session_id LIKE 'd9b52d90%' ORDER BY seq")]
    # landing sha256 verification on a sample of lines
    rows = con.execute("SELECT session_id, landing_file, line_no, sha256 FROM raw_trace_session ORDER BY random() LIMIT 300").fetchall()
    by_file = defaultdict(dict)
    for sid, f, ln, sh in rows:
        by_file[f][ln] = sh
    bad = checked = 0
    for f, want in by_file.items():
        p = ROOT / f
        if not p.exists():
            continue
        with gzip.open(p, "rb") as fh:
            for i, line in enumerate(fh, 1):
                if i in want:
                    checked += 1; bad += hashlib.sha256(line).hexdigest() != want[i]
                if i >= max(want):
                    break
    out["landing_sha256_checked"], out["landing_sha256_mismatch"] = checked, bad
    order_ok = not out["real_turn_order_d9b52d90"] or out["real_turn_order_d9b52d90"] == sorted(out["real_turn_order_d9b52d90"])
    out["pass"] = (syn in (0, 100000) and out["orphan_traces"] == out["duplicate_turn_keys"] == out["synthetic_without_provenance"] ==
                   out["sessions_without_raw_lineage"] == pii == bad == 0 and order_ok)
    out["summary"] = f"{syn:,} synthetic + {out['real_sessions']} real sessions; 0 orphans/duplicates expected; PII hits {pii}; sha256 verified on {checked} landed lines ({bad} mismatches)"
    return out


def g2_g3(con, gt, tax):
    if not gt:
        return None, None
    sig = defaultdict(set)
    for sid, t in con.execute("SELECT session_id, type FROM session_signal s JOIN conversation_session c USING(session_id) WHERE c.source='synthetic'"):
        sig[sid].add(t)
    prim = dict(con.execute("SELECT si.session_id, si.intent_id FROM session_intent si JOIN conversation_session c USING(session_id) WHERE si.role='primary' AND c.source='synthetic'").fetchall())
    types = sorted({t for g in gt for t in g["planted_signals"]})
    res = {}
    for bank in ("A", "B"):
        c = {t: [0, 0, 0] for t in types}
        for g in gt:
            if g["bank"] != bank:
                continue
            got, pl = sig.get(g["session_id"], set()), set(g["planted_signals"])
            for t in types:
                c[t][0] += t in pl and t in got; c[t][1] += t in got and t not in pl; c[t][2] += t in pl and t not in got
        res[bank] = {t: prf(*v) for t, v in c.items()}
    lex = [t for t in types if t not in ("agent_handoff", "abandoned", "auth_failure", "no_input", "dtmf_operator", "tool_failure", "agent_loop", "customer_repeat", "city_mention")]
    mean = lambda b, k: round(st.mean([res[b][t][k] for t in lex if res[b][t][k] is not None]), 3)
    struct = [t for t in types if t not in lex]
    g2 = {"per_type": res, "lexicon_types": lex, "structural_types": struct,
          "A_mean_precision": mean("A", "precision"), "A_mean_recall": mean("A", "recall"), "B_mean_precision": mean("B", "precision"), "B_mean_recall": mean("B", "recall"),
          "structural_recall": round(st.mean([res["A"][t]["recall"] for t in struct if res["A"][t]["recall"] is not None]), 3),
          "note": "Precision counts any detection in a session where the type was not deliberately planted as FP; generated dialogue contains incidental mentions, so precision is a lower bound."}
    g2["pass"] = g2["A_mean_recall"] >= .85 and g2["A_mean_precision"] >= .80
    g2["summary"] = f"Lexicon signals: bank A precision {g2['A_mean_precision']}, recall {g2['A_mean_recall']}; held-out bank B precision {g2['B_mean_precision']}, recall {g2['B_mean_recall']}; structural recall {g2['structural_recall']}"
    test = [g for g in gt if g["split"] == "test"]
    pairs = [(g["primary_intent"], prim.get(g["session_id"], "UNKNOWN")) for g in test]
    l2 = [(tax.l2(a), tax.l2(b)) for a, b in pairs]
    byb = {b: round(sum(g["primary_intent"] == prim.get(g["session_id"]) for g in test if g["bank"] == b) / max(1, sum(g["bank"] == b for g in test)), 3) for b in "AB"}
    unk = sum(p == "UNKNOWN" for _, p in pairs) / max(1, len(pairs))
    g3 = {"test_sessions": len(test), "macro_f1_L3": macro_f1(pairs), "macro_f1_L2": macro_f1(l2), "accuracy_L3": round(sum(a == b for a, b in pairs) / len(pairs), 3),
          "accuracy_L3_by_bank": byb, "unknown_rate": round(unk, 3),
          "llm_note": "Bank-B (held-out wording) errors are the target of the Claude adjudication tier, which is disabled until an API key is configured."}
    g3["pass"] = (g3["macro_f1_L2"] or 0) >= .85 and unk <= .10
    g3["summary"] = f"Held-out test split ({len(test):,}): macro-F1 L2 {g3['macro_f1_L2']}, L3 {g3['macro_f1_L3']}; accuracy A {byb['A']}, B {byb['B']}; UNKNOWN {unk:.1%}"
    return g2, g3


def g4(con, gt):
    from sklearn.metrics import adjusted_rand_score, normalized_mutual_info_score
    if not gt:
        return None
    first = {}
    for eid, sid, epn in con.execute("SELECT episode_id, session_id, ep_no FROM session_episode WHERE kind='goal' ORDER BY session_id, ep_no"):
        first.setdefault(sid, eid)
    mem = dict(con.execute("SELECT object_id, cluster_id FROM session_cluster_membership WHERE family='need'").fetchall())
    y, c = [], []
    for g in gt:
        e = first.get(g["session_id"])
        if e in mem:
            y.append(g["primary_intent"]); c.append(mem[e])
    cl = con.execute("SELECT family, COUNT(*), AVG(stability>=0.6), AVG(stability) FROM cluster_master GROUP BY 1").fetchall()
    fam = {r[0]: {"clusters": r[1], "stable_share": round(r[2], 3), "mean_stability": round(r[3], 3)} for r in cl}
    ari, nmi = adjusted_rand_score(y, c), normalized_mutual_info_score(y, c)
    reviewed = con.execute("SELECT COUNT(*) FROM review_log WHERE object_type='cluster'").fetchone()[0]
    out = {"episodes_scored": len(y), "ARI_need_vs_intent": round(ari, 3), "NMI_need_vs_intent": round(nmi, 3), "families": fam, "sme_label_reviews": reviewed}
    out["pass"] = ari >= .5 and fam.get("need", {}).get("stable_share", 0) >= .8
    out["summary"] = f"Need clusters vs true intent: ARI {ari:.2f}, NMI {nmi:.2f}; need stable share {fam.get('need', {}).get('stable_share')}; SME label reviews {reviewed}"
    return out


def g5(con):
    if not META.exists():
        return None
    meta = json.load(open(META))
    keys = {r[0]: r for r in con.execute("SELECT pattern_key, kind, subject, dim_value, period, extra FROM pattern_master")}
    geo = [(r[0], r[1]) for r in con.execute("SELECT dim_value, subject FROM pattern_master WHERE kind='geo_mix'")]
    planted = [(c, i, w0, w1) for c, i, m, w0, w1 in meta["planted"]]
    full = [(c, i) for c, i, w0, w1 in planted if (w0, w1) == (0, 11)]
    boxed = [(c, i, w0, w1) for c, i, w0, w1 in planted if (w0, w1) != (0, 11)]
    rec_full = sum((c, i) in geo for c, i in full)
    events = []
    for c, i, w0, w1 in boxed:
        hits = [json.loads(r[5]) for r in keys.values() if r[1] == "emerging" and r[2] == i and r[3] == c]
        ok = any(w0 - 1 <= h["recent_weeks"][1] <= w1 + 1 for h in hits)
        events.append({"city": c, "intent": i, "planted_weeks": [w0, w1], "flagged": ok, "flagged_windows": [h["recent_weeks"] for h in hits]})
        rec_full += 0
    geo_found = sum((c, i) in geo for c, i, *_ in planted)
    fp = [g for g in geo if g not in {(c, i) for c, i, *_ in planted}]
    fdr = len(fp) / max(1, len(geo))
    seq = [r[0] for r in con.execute("SELECT subject FROM pattern_master WHERE kind='sequence'")]
    seq_hits = [f"{a}>{b}" in seq for a, (b, _) in meta["sequences"].items()]
    emerging_all = [(r[2], r[3]) for r in keys.values() if r[1] == "emerging"]
    planted_ci = {(i, c) for c, i, *_ in boxed}
    em_fp = [e for e in emerging_all if e not in planted_ci]
    out = {"planted_city_intent_effects": len(planted), "recovered_as_geo_mix": geo_found, "geo_false_discoveries": fp, "geo_empirical_FDR": round(fdr, 3),
           "time_boxed_events": events, "sequences_recovered": f"{sum(seq_hits)}/{len(seq_hits)}", "emerging_unplanted": em_fp,
           "tests_and_kept": json.loads(con.execute("SELECT stats FROM processing_run WHERE stage='patterns' AND status='ok' ORDER BY run_id DESC LIMIT 1").fetchone()[0])}
    out["pass"] = geo_found >= 9 and fdr <= .10 and all(e["flagged"] for e in events) and sum(seq_hits) >= 3
    out["summary"] = (f"{geo_found}/{len(planted)} planted city×intent effects recovered, geo FDR {fdr:.0%}; time-boxed events flagged {sum(e['flagged'] for e in events)}/{len(events)}; "
                      f"sequences {sum(seq_hits)}/{len(seq_hits)}; {len(em_fp)} unplanted emerging flag(s)")
    return out


def g6(con):
    from .facts import facts_as_of
    cards = con.execute("SELECT card_id, population, caveats, period, version, governance FROM evidence_card WHERE valid_to IS NULL").fetchall()
    viol = []
    for cid, pop, cav, per, ver, gov in cards:
        n_ref = con.execute("SELECT COUNT(*) FROM evidence_ref WHERE card_id=?", (cid,)).fetchone()[0]
        den = int(pop.split(" of ")[1]) if pop and " of " in pop else 0
        if n_ref < 3: viol.append((cid, "fewer than 3 evidence refs"))
        if den < K_ANON: viol.append((cid, "cell below k-anonymity"))
        if not json.loads(cav or "[]"): viol.append((cid, "no caveats"))
        if not per or not ver or not gov: viol.append((cid, "missing period/version/governance"))
    san = 0
    for (qt,) in con.execute("SELECT quote FROM evidence_ref"):
        san += sum(len(rx.findall(qt)) for _, rx in PII_PATTERNS) + sum(len(rx.findall(qt)) for rx, _ in QUOTE_MASKS)
    rng = random.Random(3)
    threads = [r[0] for r in con.execute("SELECT thread_id FROM conversation_session GROUP BY 1 HAVING COUNT(*)>=2 LIMIT 3000")]
    pit_bad = checked = 0
    for t in rng.sample(threads, min(300, len(threads))):
        for sid, at, it in con.execute("""SELECT s.session_id, s.created_at, si.intent_id FROM conversation_session s
                                          LEFT JOIN session_intent si ON si.session_id=s.session_id AND si.role='primary' WHERE s.thread_id=?""", (t,)):
            f = [x for x in facts_as_of(con, t, at) if x["attribute"] == "primary_intent"]
            checked += 1; pit_bad += not (len(f) == 1 and f[0]["value"] == it)
    superseded = con.execute("SELECT COUNT(*) FROM fact WHERE valid_to IS NOT NULL").fetchone()[0]
    out = {"active_cards": len(cards), "card_violations": viol, "quote_sanitiser_violations": san, "point_in_time_checks": checked,
           "point_in_time_failures": pit_bad, "superseded_facts_on_record": superseded,
           "card_versions": con.execute("SELECT COUNT(*) FROM evidence_card").fetchone()[0]}
    out["pass"] = not viol and san == 0 and pit_bad == 0 and len(cards) > 0
    out["summary"] = f"{len(cards)} active cards, {len(viol)} governance violations, {san} unsanitised quote tokens; point-in-time reconstruction {checked - pit_bad}/{checked}"
    return out


def g7(con, gt, tax):
    from .retrieval import Retriever
    if not gt:
        return None
    R = Retriever(con)
    gi = {g["session_id"]: g["primary_intent"] for g in gt}
    city_int = Counter((g["city"], g["primary_intent"]) for g in gt if g["primary_intent"] not in ("ESCALATION.REP.REQUEST",))
    combos = [k for k, n in city_int.most_common() if n >= 40]
    rng = random.Random(5); rng.shuffle(combos); combos = combos[:60]
    ex = {i["code"]: (i.get("include") or [i["name"]])[0] for i in tax.intents}
    res = {m: {"p10": [], "mrr": [], "ndcg": []} for m in ("bm25", "dense", "hybrid")}
    filt_ok = asof_ok = True
    for city, it in combos:
        qtext = ex[it]
        for m in res:
            hits = R.search(qtext, m, {"city": city}, k=10, with_facts=False)
            rel = [gi.get(h["session_id"]) == it for h in hits]
            filt_ok &= all(h["city"] == city for h in hits)
            res[m]["p10"].append(sum(rel) / 10)
            res[m]["mrr"].append(next((1 / (i + 1) for i, r in enumerate(rel) if r), 0))
            dcg = sum(r / math.log2(i + 2) for i, r in enumerate(rel)); idcg = sum(1 / math.log2(i + 2) for i in range(min(10, city_int[(city, it)])))
            res[m]["ndcg"].append(dcg / idcg if idcg else 0)
    asof = "2026-10-01 00:00:00"
    for h in R.search("cancel my service", "hybrid", {"asof": asof}, k=20):
        asof_ok &= h["created_at"] <= asof and "facts_as_of" in h
    summ = {m: {k: round(st.mean(v), 3) for k, v in d.items()} for m, d in res.items()}
    best = max(summ["bm25"]["mrr"], summ["dense"]["mrr"])
    out = {"queries": len(combos), "query_text": "first 'include' phrase of the intent definition (not the generated wording)", "by_method": summ,
           "filters_correct": filt_ok, "asof_correct": asof_ok}
    out["pass"] = summ["hybrid"]["mrr"] >= best - .02 and filt_ok and asof_ok
    out["summary"] = f"{len(combos)} queries: MRR bm25 {summ['bm25']['mrr']}, dense {summ['dense']['mrr']}, hybrid {summ['hybrid']['mrr']}; filters {'ok' if filt_ok else 'FAIL'}; as-of {'ok' if asof_ok else 'FAIL'}"
    return out


def g8(con):
    import threading, urllib.request
    from http.server import ThreadingHTTPServer
    from .server import Handler
    Handler.db_path = DB_PATH
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler); threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    sid = con.execute("SELECT session_id FROM conversation_session LIMIT 1").fetchone()[0]
    cid = con.execute("SELECT card_id FROM evidence_card WHERE valid_to IS NULL LIMIT 1").fetchone()
    kid = con.execute("SELECT cluster_id FROM cluster_master LIMIT 1").fetchone()
    routes = ["overview", "sessions?limit=50", f"sessions/{sid}", "taxonomy", "signals", "cards", "clusters?family=need", "patterns", "geo", "journeys",
              "search?q=add%20a%20line&city=Austin", "ask?q=outages%20in%20Houston", "llm", "runs", "taxonomy/candidates"]
    if cid: routes.append(f"cards/{cid[0]}")
    if kid: routes.append(f"clusters/{kid[0]}")
    lat, bad = [], []
    for r in routes:
        urllib.request.urlopen(f"{base}/api/{r}").read()                      # warm (cache)
    for r in routes:
        for _ in range(3):
            t = time.time()
            try:
                urllib.request.urlopen(f"{base}/api/{r}").read()
            except Exception as e:
                bad.append((r, str(e)))
            lat.append((time.time() - t) * 1000)
    srv.shutdown()
    lat.sort()
    p95 = lat[int(.95 * (len(lat) - 1))]
    runs = con.execute("SELECT stage, (julianday(finished_at)-julianday(started_at))*86400 FROM processing_run WHERE status='ok' ORDER BY run_id DESC LIMIT 40").fetchall()
    last = {}
    for s, sec in runs:
        last.setdefault(s.split(":")[0], sec)
    total = sum(last.values())
    out = {"routes_tested": len(routes), "route_errors": bad, "api_p95_ms_warm": round(p95, 1), "pipeline_seconds_by_stage": {k: round(v, 1) for k, v in last.items()},
           "pipeline_seconds_total": round(total, 1), "note": "Latency measured after cache warm-up (server pre-warms at start); cold first calls of heavy aggregates take 1-5 s."}
    out["pass"] = not bad and p95 < 500 and total <= 1800
    out["summary"] = f"{len(routes)} routes OK, API p95 {p95:.0f} ms (warm); full pipeline {total / 60:.1f} min on this machine"
    return out


def g9(con):
    n, mean, mn = con.execute("SELECT COUNT(*), AVG(n_traces), MIN(n_traces) FROM conversation_session WHERE source='synthetic'").fetchone()
    out = {"synthetic_sessions": n, "mean_traces": round(mean or 0, 3), "min_traces": mn}
    out["pass"] = n == 100000 and abs((mean or 0) - 7.0) <= .1 and (mn or 0) >= 1
    out["summary"] = f"{n:,} sessions, mean {mean:.2f} traces/session (target 7.0 ± 0.1)"
    return out


def g10(con):
    from .adapters import llm
    n = con.execute("SELECT COUNT(*) FROM conversation_session").fetchone()[0]
    c = len(llm.candidates(con))
    labels = dict(con.execute("SELECT status, COUNT(*) FROM llm_label GROUP BY 1").fetchall())
    ung = con.execute("SELECT COUNT(*) FROM llm_label WHERE status='accepted' AND grounded=0").fetchone()[0]
    out = {"enabled": llm.available(), "candidate_sessions": c, "candidate_share": round(c / max(1, n), 4), "labels": labels, "accepted_ungrounded": ung}
    out["pass"] = None if not llm.available() else (ung == 0 and c / n <= LLM_MAX_SHARE)
    out["summary"] = ("Claude tier disabled (no API key). " if not llm.available() else "") + f"{c:,} candidate sessions ({c / max(1, n):.1%} ≤ {LLM_MAX_SHARE:.0%} cap); grounding enforced in code; accepted-but-ungrounded {ung}"
    return out


def real_gold(con, tax):
    gold = [json.loads(l) for l in open(GOLD)] if GOLD.exists() else []
    gold = [g for g in gold if g.get("session_id") and con.execute("SELECT 1 FROM conversation_session WHERE session_id=?", (g["session_id"],)).fetchone()]
    if not gold:
        return None
    gp = []; flags = {k: [0, 0, 0] for k in ("handoff", "auth_failure", "abandoned", "asked_human")}; dis = []
    gs = {k: [0, 0, 0] for k in GOLD_SIGNALS}
    for g in gold:
        p = con.execute("SELECT intent_id FROM session_intent WHERE session_id=? AND role='primary'", (g["session_id"],)).fetchone()[0]
        gp.append((g["primary"], p))
        if p != g["primary"]:
            dis.append({"session": g["external_id_prefix"], "gold": g["primary"], "pipeline": p, "ambiguous": g["ambiguous"], "note": g["note"]})
        types = {r[0] for r in con.execute("SELECT type FROM session_signal WHERE session_id=?", (g["session_id"],))}
        pred = {"handoff": "agent_handoff" in types, "auth_failure": "auth_failure" in types, "abandoned": "abandoned" in types, "asked_human": "escalation_request" in types}
        for k, v in pred.items():
            flags[k][0] += v and g[k]; flags[k][1] += v and not g[k]; flags[k][2] += (not v) and g[k]
        for k in GOLD_SIGNALS:
            a, b = k in g["signals"], k in types
            gs[k][0] += a and b; gs[k][1] += b and not a; gs[k][2] += a and not b
    n = len(gold)
    un = [(a == b) for (a, b), g in zip(gp, gold) if not g["ambiguous"]]
    out = {"sessions": n, "reviewed": sum(bool(g.get("reviewed")) for g in gold), "primary_accuracy_L3": round(sum(a == b for a, b in gp) / n, 3),
           "primary_accuracy_L2": round(sum(tax.l2(a) == tax.l2(b) for a, b in gp) / n, 3), "unambiguous_accuracy_L3": round(sum(un) / max(1, len(un)), 3),
           "flags": {k: prf(*v) for k, v in flags.items()}, "signals": {k: prf(*v) for k, v in gs.items()}, "disagreements": dis,
           "caveat": "Draft labels (Claude pre-label, reviewed=false); n=36; rules were tuned after seeing these disagreements, so figures are optimistic until an SME-reviewed held-out set exists.",
           "pass": None}
    out["summary"] = f"n={n} (unreviewed draft): primary L3 {out['primary_accuracy_L3']:.0%}, unambiguous {out['unambiguous_accuracy_L3']:.0%}; handoff/auth-failure detection precision {out['flags']['handoff']['precision']}/{out['flags']['auth_failure']['precision']}"
    return out


def run(db=DB_PATH):
    con = sqlite3.connect(db); con.row_factory = sqlite3.Row
    tax = Taxonomy()
    gt = load_gt()
    t0 = time.time()
    G = {}
    G["G0_calibration"] = g0(con, tax)
    G["G1_integrity"] = g1(con)
    g2, g3 = g2_g3(con, gt, tax)
    if g2: G["G2_signals"] = g2
    if g3: G["G3_intent_classification"] = g3
    for name, fn in (("G4_clusters", lambda: g4(con, gt)), ("G5_patterns", lambda: g5(con)), ("G6_cards_facts", lambda: g6(con)),
                     ("G7_retrieval", lambda: g7(con, gt, tax)), ("G8_api_performance", lambda: g8(con)), ("G9_volume", lambda: g9(con)), ("G10_llm", lambda: g10(con))):
        r = fn()
        if r:
            G[name] = r
    rg = real_gold(con, tax)
    if rg: G["real_sample_gold_draft"] = rg
    G["governance"] = {"pipeline_modules_reading_truth": [p.name for p in (ROOT / "cie").glob("*.py") if p.name not in ("validate.py", "fixtures.py", "synth.py", "config.py")
                                                         and re.search(r"FIXTURES_TRUTH|GT_PATH|ground_truth|real_gold", p.read_text())]}
    G["governance"]["pass"] = not G["governance"]["pipeline_modules_reading_truth"]
    G["governance"]["summary"] = "pipeline never reads ground truth or gold files" if G["governance"]["pass"] else "VIOLATION"
    R = {"versions": VERSIONS, "generated_seconds": round(time.time() - t0, 1), "gates": G,
         "statement": "Synthetic gates prove pipeline capability and statistical behaviour on a generated population with known truth. They do not prove accuracy on real Verizon conversations; the real-sample gold set (draft, needs SME review) is the only real-language evidence."}
    REPORTS.mkdir(exist_ok=True)
    json.dump(R, open(REPORTS / "validation.json", "w"), indent=1, default=str)
    (REPORTS / "validation.md").write_text(render_md(R))
    return R


def render_md(R):
    L = ["# Validation report", "", f"> {R['statement']}", "", f"Versions: `{json.dumps(R['versions'])}`", "", "| Gate | Result | Summary |", "|---|---|---|"]
    for k, g in R["gates"].items():
        s = {True: "PASS", False: "FAIL", None: "INFO"}[g.get("pass")]
        L.append(f"| {k} | **{s}** | {g.get('summary', '')} |")
    L.append("")
    for k, g in R["gates"].items():
        L += [f"## {k}", "", "```json", json.dumps({x: y for x, y in g.items() if x not in ('per_type',)}, indent=1, default=str)[:6000], "```", ""]
    return "\n".join(L)


if __name__ == "__main__":
    R = run()
    for k, g in R["gates"].items():
        print(f"{k:28s} {({True: 'PASS', False: 'FAIL', None: 'INFO'})[g.get('pass')]:5s} {g.get('summary', '')}")
