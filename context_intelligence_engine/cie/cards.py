"""WP10 evidence cards: business-reviewable units built from scored patterns.

Each card: title, observation, population (support/denominator), period, scope, trend, 3-5 sanitised quotes with
session/turn/trace references, confidence, separate score dimensions + provisional composite, KPI hypothesis, action
hypothesis, caveats, data origin, governance (versions, run), review status. Cards are versioned by pattern_key:
a rerun with changed numbers creates version n+1, closes the old one (valid_to, superseded_by) and carries review status.
"""
import datetime as dt, hashlib, json, re
from collections import Counter
from . import db
from .config import VERSIONS, MAX_CARDS, MAX_CARDS_PER_SUBJECT, SCORING_VERSION, K_ANON, CARD_KIND_CAPS
from .lexicon import PII_PATTERNS, QUOTE_MASKS
from .scoring import scores_for

KPI = {"buying": "Qualified opportunity volume; conversion proxy; unmet-need share",
       "need": "Qualified opportunity volume; unmet-need share",
       "value": "Opportunity density; acceptance proxy (revenue per eligible session needs Phase-2 data)",
       "risk": "Repeat-contact rate; escalation rate; save-rate proxy",
       "friction": "Escalation rate; abandonment; containment",
       "temporal": "Repeat-contact rate; next-contact intent mix",
       "geo": "City-level intent mix; emerging local demand; regional opportunity gap"}
METRIC_LABEL = {"escalation_rate": "Escalation to a human", "abandon_rate": "Abandonment", "repeat_contact_7d": "Thread-linked repeat contact (7 days)",
                "auth_failure_rate": "Authentication failure", "opportunity_density": "Buying/value signal density"}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def sanitise(text):
    for ph, rx in PII_PATTERNS:
        text = rx.sub(ph, text)
    for rx, ph in QUOTE_MASKS:
        text = rx.sub(ph, text)
    return re.sub(r"\s+", " ", text).strip()


def _cell_sessions(con, p, limit=400):
    k, s, dv = p["kind"], p["subject"], p["dim_value"]
    base = """SELECT s.session_id, s.source FROM conversation_session s JOIN session_intent si ON si.session_id=s.session_id AND si.role='primary'
              LEFT JOIN session_feature f ON f.session_id=s.session_id WHERE """
    mcond = {"escalation_rate": "s.outcome='escalated'", "abandon_rate": "s.outcome='abandoned'", "auth_failure_rate": "f.n_auth_failures>0",
             "repeat_contact_7d": "EXISTS(SELECT 1 FROM conversation_session n WHERE n.previous_session_id=s.session_id)",
             "opportunity_density": "f.opp_flag=1"}.get(p["metric"], "1=1")
    if k == "geo_mix":
        q, a = base + "si.intent_id=? AND s.city=?", (s, dv)
    elif k == "segment_mix":
        q, a = base + "si.intent_id=? AND f.segment=?", (s, dv)
    elif k == "risk_rate" and p["subject_type"] == "intent":
        q, a = base + f"si.intent_id=? AND {mcond}", (s,)
    elif k in ("risk_rate", "opportunity"):
        q, a = base + f"s.city=? AND {mcond}", (dv,)
    elif k == "emerging":
        col = "s.city" if p["dim_type"] == "city" else "s.region"
        q, a = base + f"si.intent_id=? AND {col}=?", (s, dv)
    elif k == "sequence":
        a_, b_ = s.split(">")
        q = base + "si.intent_id=? AND EXISTS(SELECT 1 FROM session_intent pi WHERE pi.session_id=s.previous_session_id AND pi.role='primary' AND pi.intent_id=?)"
        a = (b_, a_)
    else:
        return []
    return con.execute(q + " ORDER BY s.source DESC, s.session_id LIMIT ?", (*a, limit)).fetchall()


def _quotes(con, p, sessions, n=5):
    subj = p["subject"].split(">")[-1] if p["kind"] == "sequence" else p["subject"]
    want = {"escalation_rate": "escalation_request", "abandon_rate": "no_input", "repeat_contact_7d": "repeat_contact_language",
            "auth_failure_rate": "auth_failure", "opportunity_density": "willingness"}.get(p["metric"])
    out, seen_text = [], set()
    for sid, src in sessions:
        row = None
        if want:
            row = con.execute("""SELECT t.seq, t.turn_no, t.trace_id, t.user_text FROM session_signal x JOIN conversation_turn t ON t.session_id=x.session_id AND t.seq=x.seq
                                 WHERE x.session_id=? AND x.type=? AND t.user_text IS NOT NULL AND length(t.user_text)>12 LIMIT 1""", (sid, want)).fetchone()
        if not row and p["subject_type"] in ("intent", "intent_pair"):
            row = con.execute("""SELECT t.seq, t.turn_no, t.trace_id, t.user_text FROM turn_intent ti JOIN conversation_turn t ON t.session_id=ti.session_id AND t.seq=ti.seq
                                 WHERE ti.session_id=? AND ti.intent_id=? AND t.user_text IS NOT NULL AND length(t.user_text)>12 LIMIT 1""", (sid, subj)).fetchone()
        if not row:
            row = con.execute("""SELECT t.seq, t.turn_no, t.trace_id, t.user_text FROM session_signal x JOIN conversation_turn t ON t.session_id=x.session_id AND t.seq=x.seq
                                 WHERE x.session_id=? AND t.user_text IS NOT NULL AND length(t.user_text)>15 ORDER BY x.confidence DESC LIMIT 1""", (sid,)).fetchone()
        if not row:
            continue
        q = sanitise(row[3])
        if q.lower() in seen_text:
            continue
        seen_text.add(q.lower())
        out.append((sid, row[0], row[1], row[2], q, src))
        if len(out) >= n:
            break
    return out


def _text(p, names):
    lab, dv, lift = p["subject_label"], p["dim_value"], p["lift_shrunk"] or 0
    r, b = p["rate"] or 0, p["baseline"] or 0
    k = p["kind"]
    if k == "geo_mix":
        return (f"{lab} is {lift:.1f}x more common in {dv}",
                f"{r:.1%} of customer needs from {dv} service locations are '{lab}' ({p['support']} of {p['denominator']} thread-needs) vs {b:.1%} across all locations.",
                f"{dv} (service location)")
    if k == "segment_mix":
        return (f"{lab} concentrates in the {dv} segment", f"{r:.1%} of {dv} needs are '{lab}' vs {b:.1%} overall ({p['support']} of {p['denominator']}).", f"{dv} segment")
    if k == "risk_rate":
        m = METRIC_LABEL.get(p["metric"], p["metric"])
        who = f"'{lab}' calls" if p["subject_type"] == "intent" else f"calls from {dv}"
        word = "higher" if lift >= 1 else "lower"
        return (f"{m} is {lift:.1f}x {word} for {who}" if lift >= 1 else f"{m} is {1 / max(lift, 1e-6):.1f}x lower for {who}",
                f"{m}: {r:.1%} of {who} ({p['support']} of {p['denominator']}) vs {b:.1%} on average.", dv if p["subject_type"] == "city" else "all locations")
    if k == "opportunity":
        ex = json.loads(p["extra"] or "{}")
        return (f"{dv} shows {lift:.1f}x the buying/value signal density",
                f"{r:.1%} of {dv} sessions carry a buying or value signal vs {b:.1%} overall; {ex.get('conversion_proxy', 0):.0%} of those include explicit willingness (conversion proxy).",
                f"{dv} (service location)")
    if k == "emerging":
        return (f"{lab} is surging in {dv} ({p['trend']:.1f}x)",
                f"In {p['period']}, {r:.1%} of needs in {dv} were '{lab}' vs {b:.1%} in the prior weeks ({p['support']} of {p['denominator']}).", f"{dv} ({p['dim_type']})")
    if k == "sequence":
        a, bb = lab.split(" → ")
        return (f"'{a}' is often followed by '{bb}'",
                f"{r:.1%} of follow-up contacts after '{a}' are '{bb}' ({p['support']} of {p['denominator']}) vs {b:.1%} of all follow-ups (thread-linked).",
                "thread-linked follow-ups")
    return (lab, "", dv)


def _hypothesis(p):
    fam, k = p["family"], p["kind"]
    if k == "sequence":
        return ("The first contact predicts the next one. Resolving or pre-empting the first need could prevent the follow-up.",
                "Investigate a proactive step after the first contact (callback, status message, retention offer) and test it on the cohort.")
    if fam == "buying":
        return ("Recurring local demand that the agent does not convert today: a qualified upsell/cross-sell opportunity hypothesis.",
                "Review whether the agent offers the relevant product in this scope; pilot a targeted offer and track the conversion proxy.")
    if fam == "value":
        return ("Price/value language concentrates here: a retention-and-value hypothesis (right-sizing, discounts, loyalty offers).",
                "Check plan-fit tooling and offer eligibility for this scope; measure acceptance proxy before and after.")
    if fam in ("risk", "friction", "temporal"):
        return ("Friction or unresolved contact concentrates here: a retention-risk hypothesis.",
                "Inspect the transcripts behind this card; fix the failing step (authentication, tool, policy) or add a guided path, then monitor escalation/repeat rates.")
    return ("A recurring customer need concentrates in this scope.", "Review self-service coverage and agent flows for this need in this scope.")


def run(con):
    names = {r[0]: r[1] for r in con.execute("SELECT intent_id, name FROM dim_intent")}
    with db.stage(con, "cards", {**VERSIONS, "scoring": SCORING_VERSION}) as (run_id, stats):
        P = [dict(r) for r in con.execute("""SELECT p.*, s.value AS composite FROM pattern_master p JOIN pattern_score s ON s.pattern_id=p.pattern_id
                                             AND s.dimension='composite_provisional' ORDER BY s.value DESC""")]
        per_subject, per_kind, chosen = Counter(), Counter(), []
        for p in P:
            subj = p["subject"]
            kk = p["kind"] + ((":up" if (p["lift_shrunk"] or 1) >= 1 else ":down") if p["kind"] == "risk_rate" else "")
            if per_subject[subj] >= MAX_CARDS_PER_SUBJECT or per_kind[kk] >= CARD_KIND_CAPS.get(kk, 99):
                continue
            per_subject[subj] += 1; per_kind[kk] += 1; chosen.append(p)
            if len(chosen) >= MAX_CARDS:
                break
        active = {r["pattern_key"]: dict(r) for r in con.execute("SELECT * FROM evidence_card WHERE valid_to IS NULL")}
        new_keys, created, kept, versioned = set(), 0, 0, 0
        ts = now()
        for p in chosen:
            sess = _cell_sessions(con, p)
            quotes = _quotes(con, p, sess)
            if len(quotes) < 3 or p["denominator"] < K_ANON:
                continue                                         # governance: >=3 evidence quotes, k-anonymous cell
            new_keys.add(p["pattern_key"])
            title, obs, scope = _text(p, names)
            hyp, action = _hypothesis(p)
            sc = scores_for(con, p["pattern_id"])
            ev = sc.get("evidence_strength", 0)
            conf = "High" if ev >= .75 else "Medium" if ev >= .55 else "Low"
            srcs = Counter(src for _, src in sess)
            origin = "verizon_sample" if set(srcs) == {"verizon_sample"} else "synthetic" if "verizon_sample" not in srcs else "mixed"
            caveats = []
            if origin != "verizon_sample":
                caveats.append("Built on SYNTHETIC conversations: counts and rates describe the generated population, not Verizon customers.")
            if p["dim_type"] in ("city", "region") or p["kind"] == "opportunity":
                caveats.append("Geography = service location from an ASSUMED field contract (AGENTS.md §2.7), not where the caller was.")
            if p["metric"] in ("repeat_contact_7d",) or p["kind"] == "sequence":
                caveats.append("Repeat contact is thread-linked via previous_session_id only; unlinked repeat calls are missed.")
            if p["kind"] == "sequence":
                caveats.append("Association, not causation.")
            if p["metric"] in ("escalation_rate", "abandon_rate"):
                caveats.append("Outcomes are proxies (transfer tool / disconnect), not verified dispositions.")
            if p["support"] < 50:
                caveats.append(f"Small support ({p['support']} sessions): treat as directional.")
            caveats.append("Phase 1 proves behavioural signals and hypotheses only; no revenue, conversion or churn outcome is claimed.")
            trend = (f"{p['trend']:.1f}x recent vs prior (two-proportion test, Bonferroni over windows, BH q={p['qval']:.1e})" if p["kind"] == "emerging"
                     else f"Demand Momentum {sc.get('trend', 0):.2f} (last 4 weeks vs earlier weeks of this cell)")
            metrics = {k: p[k] for k in ("support", "denominator", "rate", "baseline", "lift", "lift_shrunk", "ci_lo", "ci_hi", "pval", "qval")}
            h = hashlib.sha1(json.dumps({k: round(v, 4) if isinstance(v, float) else v for k, v in metrics.items()}, sort_keys=True).encode()).hexdigest()
            gov = {"pattern_run": p["run_id"], "card_run": run_id, "versions": VERSIONS, "scoring": SCORING_VERSION, "metrics_hash": h}
            prev = active.get(p["pattern_key"])
            if prev and json.loads(prev["governance"]).get("metrics_hash") == h:
                kept += 1
                if con.execute("SELECT COUNT(*) FROM evidence_ref WHERE card_id=?", (prev["card_id"],)).fetchone()[0] < 3:
                    # evidence_ref is a derived table that --rebuild clears while cards (and their reviews) are kept: restore the quotes
                    con.executemany("INSERT INTO evidence_ref VALUES(?,?,?,?,?,?,?)", [(prev["card_id"], *q) for q in quotes])
                continue
            status = "draft"
            version = 1
            if prev:
                version = prev["version"] + 1
                status = "in_review" if prev["status"] == "approved" else prev["status"]   # material change re-opens an approved card
            cur = con.execute("""INSERT INTO evidence_card(pattern_key, pattern_id, version, family, kind, title, observation, population, period, scope, trend,
                                 confidence, hypothesis, action, kpi, caveats, scores, composite, metrics, data_origin, governance, status, valid_from, run_id)
                                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                              (p["pattern_key"], p["pattern_id"], version, p["family"], p["kind"], title, obs, f"{p['support']} of {p['denominator']}",
                               p["period"], scope, trend, conf, hyp, action, KPI.get(p["family"], KPI["need"]), json.dumps(caveats), json.dumps(sc),
                               p["composite"], json.dumps(metrics), origin, json.dumps(gov), status, ts, run_id))
            cid = cur.lastrowid
            con.executemany("INSERT INTO evidence_ref VALUES(?,?,?,?,?,?,?)", [(cid, *q) for q in quotes])
            if prev:
                con.execute("UPDATE evidence_card SET valid_to=?, superseded_by=? WHERE card_id=?", (ts, cid, prev["card_id"]))
                versioned += 1
            else:
                created += 1
        retired = 0
        for key, c in active.items():
            if key not in new_keys:
                con.execute("UPDATE evidence_card SET valid_to=?, status=CASE WHEN status='approved' THEN 'retired' ELSE status END WHERE card_id=?", (ts, c["card_id"]))
                retired += 1
        stats.update(created=created, unchanged=kept, new_versions=versioned, retired=retired)
    return stats
