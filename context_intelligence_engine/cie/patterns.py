"""WP7 patterns (+ daily aggregates).  Every tested cell gets a two-proportion z-test; Benjamini-Hochberg runs across
ALL tests of a run; rates are Beta-binomial shrunk toward the baseline; Wilson CIs; k-anonymity floor.

Pattern kinds
  geo_mix      intent (L3) over-represented in a service-location city vs the rest
  segment_mix  intent over-represented in a behavioural segment
  risk_rate    escalation / abandonment / thread-linked repeat / auth-failure rate by intent and by city vs global
  opportunity  buying-or-value signal density by city vs global
  emerging     intent share in a city (or region) in a 2-week window vs the prior 6 weeks (max over windows, Bonferroni)
  sequence     P(next contact in the thread is intent B | previous was A) vs P(B) among all follow-ups
"""
import json, math
from collections import Counter, defaultdict
from datetime import date
import numpy as np
from scipy.stats import norm
from . import db
from .config import (SEGMENT_DEFINES, VERSIONS, K_ANON, MIN_SUPPORT, FDR_Q, MIN_LIFT, SHRINK_M, RECENT_WEEKS, PRIOR_WEEKS, EMERGING_MIN_RATIO, REPEAT_WINDOW_DAYS)
from .taxonomy import Taxonomy, UNKNOWN, REP_INTENT


def wilson(x, n, z=1.96):
    if n == 0:
        return 0.0, 0.0
    p = x / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def ztest(x1, n1, x2, n2):
    """two-sided two-proportion z-test p-value"""
    if n1 == 0 or n2 == 0:
        return 1.0
    p = (x1 + x2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    if se == 0:
        return 1.0
    return float(2 * norm.sf(abs((x1 / n1 - x2 / n2) / se)))


def bh(pvals):
    p = np.asarray(pvals, dtype=float)
    n = len(p)
    if n == 0:
        return []
    order = np.argsort(p)
    q = np.empty(n)
    prev = 1.0
    for rank, i in enumerate(order[::-1]):
        k = n - rank
        prev = min(prev, p[i] * n / k)
        q[i] = prev
    return q.tolist()


def shrunk(x, n, base, m=SHRINK_M):
    return (x + m * base) / (n + m)


def load_frame(con, tax):
    rows = con.execute("""SELECT s.session_id, s.thread_id, s.created_at, s.day, s.city, s.region, s.source, s.outcome, s.thread_id, s.previous_session_id,
                             si.intent_id, f.segment, f.opp_flag, f.n_auth_failures
                          FROM conversation_session s
                          LEFT JOIN session_intent si ON si.session_id=s.session_id AND si.role='primary'
                          LEFT JOIN session_feature f ON f.session_id=s.session_id""").fetchall()
    days = sorted({r["day"] for r in rows if r["day"]})
    d0 = date.fromisoformat(days[0])
    follow = {}
    for r in con.execute("SELECT previous_session_id, MIN(created_at) FROM conversation_session WHERE previous_session_id IS NOT NULL GROUP BY 1"):
        follow[r[0]] = r[1]
    willing = {r[0] for r in con.execute("SELECT DISTINCT session_id FROM session_signal WHERE type='willingness'")}
    F = []
    for r in rows:
        nxt = follow.get(r["session_id"])
        rep7 = 0
        if nxt and r["created_at"]:
            try:
                rep7 = int((date.fromisoformat(nxt[:10]) - date.fromisoformat(r["created_at"][:10])).days <= REPEAT_WINDOW_DAYS)
            except ValueError:
                pass
        F.append(dict(sid=r["session_id"], day=r["day"], week=(date.fromisoformat(r["day"]) - d0).days // 7 if r["day"] else None,
                      city=r["city"], region=r["region"], source=r["source"], outcome=r["outcome"], intent=r["intent_id"] or UNKNOWN,
                      l2=tax.l2(r["intent_id"] or UNKNOWN), segment=r["segment"], opp=r["opp_flag"] or 0, auth_fail=int((r["n_auth_failures"] or 0) > 0),
                      rep7=rep7, willing=int(r["session_id"] in willing), prev=r["previous_session_id"], thread=r["thread_id"]))
    return F, d0


def unique_units(F):
    """One unit per (thread, intent): repeat contacts about the same need are not independent observations."""
    seen, out = set(), []
    for f in sorted(F, key=lambda f: f["day"] or ""):
        k = (f["thread"], f["intent"])
        if k not in seen:
            seen.add(k); out.append(f)
    return out


def build_aggregates(con, F, run_id):
    con.execute("DELETE FROM agg_daily_intent")
    agg = defaultdict(lambda: [0, 0, 0, 0])
    for f in F:
        k = (f["day"], f["week"], f["intent"], f["city"], f["region"], f["segment"], f["outcome"], f["source"])
        a = agg[k]; a[0] += 1; a[1] += f["opp"]; a[2] += f["willing"]; a[3] += f["rep7"]
    con.executemany("INSERT INTO agg_daily_intent VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [(*k[:1], str(k[1]), *k[2:], *v) for k, v in agg.items()])
    return len(agg)


def candidates(F, tax, names):
    """Yield (kind, subject_type, subject, dim_type, dim_value, metric, x, n, X, N, extra) for every tested cell."""
    F_all = F
    F = unique_units(F_all)                              # composition tests use thread-intent units
    N = len(F)
    known = [f for f in F if f["city"] and f["city"] != "UNKNOWN"]
    by_city = defaultdict(list)
    for f in known:
        by_city[f["city"]].append(f)
    intents = Counter(f["intent"] for f in F if f["intent"] not in (UNKNOWN,))
    # geo_mix: intent x city (cell vs rest of known-geo sessions)
    Nk = len(known); ik = Counter(f["intent"] for f in known)
    for city, fs in by_city.items():
        n = len(fs)
        if n < K_ANON:
            continue
        cnt = Counter(f["intent"] for f in fs)
        for it, total in ik.items():
            if it == UNKNOWN or total < K_ANON:
                continue
            x = cnt.get(it, 0)
            yield ("geo_mix", "intent", it, "city", city, "intent_share", x, n, total - x, Nk - n, {})
    # segment_mix
    by_seg = defaultdict(list)
    for f in F:
        by_seg[f["segment"]].append(f)
    for seg, fs in by_seg.items():
        if seg in (None, "General") or len(fs) < K_ANON:
            continue
        cnt = Counter(f["intent"] for f in fs)
        for it, total in intents.items():
            if total < K_ANON or it.startswith(SEGMENT_DEFINES.get(seg, ("@",))):
                continue                                  # skip definitional pairs (segment built from this intent's signals)
            x = cnt.get(it, 0)
            yield ("segment_mix", "intent", it, "segment", seg, "intent_share", x, len(fs), total - x, N - len(fs), {})
    # risk_rate by intent and by city (session-level outcomes)
    F = F_all; N = len(F)
    by_city = defaultdict(list)
    for f in F:
        if f["city"] and f["city"] != "UNKNOWN":
            by_city[f["city"]].append(f)
    known = [f for fs in by_city.values() for f in fs]; Nk = len(known)
    metrics = {"escalation_rate": lambda f: f["outcome"] == "escalated", "abandon_rate": lambda f: f["outcome"] == "abandoned",
               "repeat_contact_7d": lambda f: f["rep7"] == 1, "auth_failure_rate": lambda f: f["auth_fail"] == 1}
    for mname, fn in metrics.items():
        tot = sum(1 for f in F if fn(f))
        by_i = defaultdict(lambda: [0, 0])
        for f in F:
            b = by_i[f["intent"]]; b[0] += int(fn(f)); b[1] += 1
        for it, (x, n) in by_i.items():
            if it == UNKNOWN or n < K_ANON:
                continue
            yield ("risk_rate", "intent", it, "all", "all", mname, x, n, tot - x, N - n, {})
        for city, fs in by_city.items():
            if len(fs) < K_ANON:
                continue
            x = sum(1 for f in fs if fn(f))
            yield ("risk_rate", "city", city, "city", city, mname, x, len(fs), tot - x, N - len(fs), {})
    # opportunity density by city
    tot = sum(f["opp"] for f in known)
    for city, fs in by_city.items():
        x = sum(f["opp"] for f in fs)
        yield ("opportunity", "city", city, "city", city, "opportunity_density", x, len(fs), tot - x, Nk - len(fs),
               {"conversion_proxy": round(sum(f["willing"] for f in fs if f["opp"]) / max(1, x), 3)})
    # sequences (thread-linked)
    sid_int = {f["sid"]: f["intent"] for f in F}
    pairs = [(sid_int.get(f["prev"]), f["intent"]) for f in F if f["prev"] and f["prev"] in sid_int]
    pairs = [(a, b) for a, b in pairs if a not in (None, UNKNOWN) and b != UNKNOWN]
    nb = Counter(b for _, b in pairs); na = Counter(a for a, _ in pairs); nab = Counter(pairs); P = len(pairs)
    for (a, b), x in nab.items():
        if a == b or na[a] < K_ANON or x < 5:
            continue
        yield ("sequence", "intent_pair", f"{a}>{b}", "prior_intent", a, "next_intent_share", x, na[a], nb[b] - x, P - na[a], {"to": b})


def emerging(F, d0):
    """Max-over-windows two-proportion test of an intent's share in a city/region (recent 2 weeks vs prior 6)."""
    F = unique_units(F)
    weeks = max(f["week"] for f in F if f["week"] is not None)
    out = []
    for dim in ("city", "region"):
        cells = defaultdict(lambda: defaultdict(Counter))
        tot = defaultdict(Counter)
        for f in F:
            if f["week"] is None or not f[dim] or f[dim] in ("UNKNOWN", "Unmapped"):
                continue
            cells[f[dim]][f["intent"]][f["week"]] += 1
            tot[f[dim]][f["week"]] += 1
        n_windows = max(1, weeks - (RECENT_WEEKS + PRIOR_WEEKS) + 2)
        for place, by_int in cells.items():
            for it, wk in by_int.items():
                if it == UNKNOWN or sum(wk.values()) < K_ANON // 2:
                    continue
                best = None
                for w_end in range(RECENT_WEEKS + PRIOR_WEEKS - 1, weeks + 1):
                    rw = range(w_end - RECENT_WEEKS + 1, w_end + 1); pw = range(w_end - RECENT_WEEKS - PRIOR_WEEKS + 1, w_end - RECENT_WEEKS + 1)
                    x1 = sum(wk[w] for w in rw); n1 = sum(tot[place][w] for w in rw)
                    x2 = sum(wk[w] for w in pw); n2 = sum(tot[place][w] for w in pw)
                    if n1 < K_ANON or x1 < 5:
                        continue
                    r1, r2 = x1 / n1, (x2 + .5) / (n2 + 1)
                    p = ztest(x1, n1, x2, n2) if r1 > r2 else 1.0
                    if best is None or p < best[0]:
                        best = (p, w_end, x1, n1, x2, n2)
                if best:
                    p, w_end, x1, n1, x2, n2 = best
                    out.append(("emerging", "intent", it, dim, place, "share_recent_vs_prior", x1, n1, x2, n2,
                                {"peak_week_end": int(w_end), "recent_weeks": [int(w_end - RECENT_WEEKS + 1), int(w_end)], "p_raw": p,
                                 "bonferroni_windows": n_windows, "_p_override": min(1.0, p * n_windows)}))
    return out


def run(con, tax=None):
    tax = tax or Taxonomy()
    names = {n["intent_id"]: n["name"] for n in tax.nodes}
    with db.stage(con, "patterns", VERSIONS) as (run_id, stats):
        F, d0 = load_frame(con, tax)
        stats["aggregate_rows"] = build_aggregates(con, F, run_id)
        cells = list(candidates(F, tax, names)) + emerging(F, d0)
        recs = []
        for kind, st, subj, dt, dv, metric, x, n, x_rest, n_rest, extra in cells:
            if n_rest <= 0:
                continue
            rate = x / n; base = (x + x_rest) / (n + n_rest); rest = x_rest / n_rest
            p = extra.pop("_p_override", None)
            if p is None:
                p = ztest(x, n, x_rest, n_rest)
            if kind == "emerging":
                base = rest = (x_rest + .5) / (n_rest + 1)
            sr = shrunk(x, n, base)
            lo, hi = wilson(x, n)
            recs.append(dict(kind=kind, st=st, subj=subj, dt=dt, dv=dv, metric=metric, x=x, n=n, rate=rate, base=base,
                             lift=rate / base if base else None, lift_s=sr / base if base else None, lo=lo, hi=hi, p=p, extra=extra))
        qs = bh([r["p"] for r in recs])
        con.execute("DELETE FROM pattern_master")
        kept = Counter(); tested = Counter()
        for r, qv in zip(recs, qs):
            tested[r["kind"]] += 1
            up = r["lift_s"] and r["lift_s"] >= MIN_LIFT
            down = r["kind"] == "risk_rate" and r["lift_s"] and r["lift_s"] <= 1 / MIN_LIFT
            if r["kind"] == "emerging":
                up = r["rate"] / r["base"] >= EMERGING_MIN_RATIO
            # k-anonymity on the cell population; a minimum count of supporting sessions for evidence
            if r["n"] < K_ANON or (r["x"] < MIN_SUPPORT and not down) or qv > FDR_Q or not (up or down):
                continue
            kept[r["kind"]] += 1
            label = names.get(r["subj"], r["subj"]) if r["st"] == "intent" else r["subj"]
            if r["kind"] == "sequence":
                a, b = r["subj"].split(">"); label = f"{names.get(a, a)} → {names.get(b, b)}"
            fam = tax.family(r["subj"]) if r["st"] == "intent" else ("risk" if r["kind"] == "risk_rate" else "value" if r["kind"] == "opportunity" else "temporal")
            if r["kind"] == "risk_rate":
                fam = "risk" if r["metric"] in ("escalation_rate", "abandon_rate", "repeat_contact_7d") else "friction"
            if r["kind"] == "sequence":
                fam = "temporal"
            key = "|".join([r["kind"], r["st"], r["subj"], r["dt"], r["dv"], r["metric"]])
            period = "window" if r["kind"] != "emerging" else f"weeks {r['extra']['recent_weeks'][0]}-{r['extra']['recent_weeks'][1]} vs prior {PRIOR_WEEKS}"
            con.execute("""INSERT INTO pattern_master(pattern_key, kind, family, subject_type, subject, subject_label, dim_type, dim_value, metric,
                           period, support, denominator, rate, baseline, lift, lift_shrunk, ci_lo, ci_hi, pval, qval, trend, recent_rate, prior_rate,
                           coverage, extra, version, run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (key, r["kind"], fam, r["st"], r["subj"], label, r["dt"], r["dv"], r["metric"], period, r["x"], r["n"], r["rate"], r["base"],
                         r["lift"], r["lift_s"], r["lo"], r["hi"], r["p"], qv, (r["rate"] / r["base"]) if r["kind"] == "emerging" else None,
                         r["rate"] if r["kind"] == "emerging" else None, r["base"] if r["kind"] == "emerging" else None,
                         None, json.dumps(r["extra"]), VERSIONS["rules"], run_id))
        stats.update(tested=dict(tested), kept=dict(kept), total_tests=len(recs), window_start=str(d0))
    return stats
