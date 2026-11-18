"""WP8 scoring: six separate dimensions in [0,1] + a PROVISIONAL composite (weights not yet customer-approved).

prevalence          0.5*log-scaled support (10 -> 0, 10k -> 1) + 0.5*cell rate relative to the max rate of the same kind
recurrence          share of the subject's sessions followed by a thread-linked repeat within 7 days, scaled x2.5
trend               emerging: (ratio-1)/4; others: share in the last 4 weeks vs the earlier weeks of the same cell, (ratio-1)/2
evidence_strength   mean of: significance (-log10 q / 10), CI tightness (1 - CI width / rate), mean intent confidence of
                    supporting sessions, quote availability (min(1, supporting sessions / 3))
business_relevance  config.FAMILY_RELEVANCE[family]
geo_concentration   normalised Herfindahl index of the subject's sessions across service-location cities
"""
import json, math
from collections import Counter, defaultdict
from . import db
from .config import VERSIONS, FAMILY_RELEVANCE, SCORE_WEIGHTS, SCORING_VERSION, FDR_Q

clip = lambda x: max(0.0, min(1.0, x))


def run(con):
    with db.stage(con, "scoring", {**VERSIONS, "scoring": SCORING_VERSION}) as (run_id, stats):
        con.execute("DELETE FROM pattern_score")
        P = [dict(r) for r in con.execute("SELECT * FROM pattern_master")]
        if not P:
            return stats
        # subject-level helpers from aggregates
        rows = con.execute("SELECT intent_id, city, week, SUM(sessions), SUM(repeat7) FROM agg_daily_intent GROUP BY 1,2,3").fetchall()
        inten_city, inten_rep, inten_n, cell_week = defaultdict(Counter), Counter(), Counter(), defaultdict(Counter)
        for it, city, wk, n, rep in rows:
            inten_city[it][city] += n; inten_rep[it] += rep; inten_n[it] += n; cell_week[(it, city)][int(wk)] += n
        maxw = max((int(r[2]) for r in rows), default=11)
        conf = dict(con.execute("SELECT intent_id, AVG(confidence) FROM session_intent WHERE role='primary' GROUP BY 1").fetchall())
        max_rate = defaultdict(float)
        for p in P:
            max_rate[p["kind"]] = max(max_rate[p["kind"]], p["rate"] or 0)
        out = []
        for p in P:
            subj = p["subject"].split(">")[0] if p["kind"] == "sequence" else p["subject"]
            prev = .5 * clip(math.log10(max(p["support"], 1)) / 4 - .25) + .5 * clip((p["rate"] or 0) / (max_rate[p["kind"]] or 1))
            rec = clip(2.5 * inten_rep[subj] / inten_n[subj]) if inten_n.get(subj) else 0.0
            if p["kind"] == "emerging":
                tr = clip(((p["trend"] or 1) - 1) / 4)
            elif p["subject_type"] == "intent" and p["dim_type"] == "city":
                cw = cell_week[(subj, p["dim_value"])]
                recent = sum(cw[w] for w in range(maxw - 3, maxw + 1)) / 4; early = sum(cw[w] for w in range(0, maxw - 3)) / max(1, maxw - 3)
                tr = clip((recent / early - 1) / 2) if early else 0.0
            else:
                tr = 0.0
            sig = clip(-math.log10(max(p["qval"], 1e-300)) / 10)
            ciw = clip(1 - (p["ci_hi"] - p["ci_lo"]) / max(p["rate"] or 1e-6, 1e-6)) if p["rate"] else 0.0
            ev = (sig + ciw + clip(conf.get(subj, .7)) + clip(p["support"] / 3)) / 4
            rel = FAMILY_RELEVANCE.get(p["family"], .5)
            if p["subject_type"] == "intent" and inten_city.get(subj):
                c = inten_city[subj]; tot = sum(c.values()); k = len(c)
                hhi = sum((v / tot) ** 2 for v in c.values())
                geo = clip((hhi - 1 / k) / (1 - 1 / k)) * 4 if k > 1 else 0.0
                geo = clip(geo)
                if p["dim_type"] == "city":
                    geo = clip(max(geo, ((p["lift_shrunk"] or 1) - 1) / 3))
            else:
                geo = clip(((p["lift_shrunk"] or 1) - 1) / 3) if p["dim_type"] in ("city", "region") else 0.0
            dims = {"prevalence": prev, "recurrence": rec, "trend": tr, "evidence_strength": ev, "business_relevance": rel, "geo_concentration": geo}
            comp = sum(SCORE_WEIGHTS[k] * v for k, v in dims.items()) / sum(SCORE_WEIGHTS.values())
            for k, v in dims.items():
                out.append((p["pattern_id"], k, round(v, 4), "formula v1 (see scoring.py docstring)", SCORING_VERSION))
            out.append((p["pattern_id"], "composite_provisional", round(comp, 4), "weighted mean, config.SCORE_WEIGHTS (not approved)", SCORING_VERSION))
        con.executemany("INSERT INTO pattern_score VALUES(?,?,?,?,?)", out)
        stats.update(patterns=len(P), scores=len(out))
    return stats


def scores_for(con, pattern_id):
    return {r[0]: r[1] for r in con.execute("SELECT dimension, value FROM pattern_score WHERE pattern_id=?", (pattern_id,))}
