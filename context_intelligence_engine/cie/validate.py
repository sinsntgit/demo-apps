"""WP12 validation (Week-1 scope).  python -m cie.validate

Gates computed now: G1 (integrity), G2 (signals: fixtures truth + real gold draft), G3-lite (intent: fixtures + gold),
episode counts on fixtures, outcome agreement, governance checks. Later gates (G0, G4-G10) need the 100K dataset.
The pipeline never reads truth files; only this module does.
"""
import json, re, sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from .config import DB_PATH, FIXTURES_TRUTH, REPORTS, ROOT, VERSIONS
from .lexicon import PII_PATTERNS
from .taxonomy import Taxonomy

GOLD = ROOT / "tests" / "gold" / "real_gold.jsonl"
GOLD_SIGNALS = ["escalation_request", "auth_failure", "dispute", "price_sensitivity", "confusion", "frustration",
                "customer_repeat", "no_input", "dtmf_operator", "travel_intl", "abandoned"]


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else None
    r = tp / (tp + fn) if tp + fn else None
    f = 2 * p * r / (p + r) if p and r else None
    return {"precision": round(p, 3) if p is not None else None, "recall": round(r, 3) if r is not None else None,
            "f1": round(f, 3) if f is not None else None, "tp": tp, "fp": fp, "fn": fn}


def macro_f1(pairs):
    labels = sorted({g for g, _ in pairs} | {p for _, p in pairs})
    f1s = []
    for lab in labels:
        tp = sum(1 for g, p in pairs if g == lab and p == lab)
        fp = sum(1 for g, p in pairs if g != lab and p == lab)
        fn = sum(1 for g, p in pairs if g == lab and p != lab)
        if tp + fn:
            m = prf(tp, fp, fn)
            f1s.append(m["f1"] or 0.0)
    return round(sum(f1s) / len(f1s), 3) if f1s else None


def run(db=DB_PATH):
    con = sqlite3.connect(db); con.row_factory = sqlite3.Row
    tax = Taxonomy()
    R = {"versions": VERSIONS, "gates": {}}
    one = lambda sql, a=(): con.execute(sql, a).fetchone()[0]

    # ---- G1 integrity
    orphan_traces = one("SELECT COUNT(*) FROM conversation_trace t LEFT JOIN conversation_session s USING(session_id) WHERE s.session_id IS NULL")
    dup = one("SELECT COUNT(*) FROM (SELECT session_id, seq FROM conversation_turn GROUP BY 1,2 HAVING COUNT(*)>1)")
    no_prov = one("SELECT COUNT(*) FROM conversation_session WHERE is_synthetic=1 AND (provenance_id IS NULL OR provenance_id NOT IN (SELECT provenance_id FROM data_provenance))")
    no_raw = one("SELECT COUNT(*) FROM conversation_session s LEFT JOIN raw_trace_session r USING(session_id) WHERE r.sha256 IS NULL")
    pii = 0
    for (txt,) in con.execute("SELECT coalesce(user_text,'')||' '||coalesce(agent_text,'') FROM conversation_turn"):
        pii += sum(len(rx.findall(txt)) for _, rx in PII_PATTERNS)
    real = con.execute("SELECT COUNT(*) AS s, SUM(n_traces) AS t FROM conversation_session WHERE source='verizon_sample'").fetchone()
    order = [r[0] for r in con.execute("SELECT turn_no FROM conversation_turn WHERE session_id LIKE 'd9b52d90%' ORDER BY seq")]
    g1 = {"real_sessions": real["s"], "real_traces": real["t"], "orphan_traces": orphan_traces, "duplicate_turn_keys": dup,
          "synthetic_without_provenance": no_prov, "sessions_without_raw_lineage": no_raw, "pii_hits_after_scrub": pii,
          "real_turn_order_d9b52d90": order, "rejects": one("SELECT COUNT(*) FROM ingest_reject")}
    g1["pass"] = (real["s"] in (0, 36) and (real["t"] or 241) == 241 and orphan_traces == dup == no_prov == no_raw == pii == 0
                  and (not order or order == sorted(order)))
    R["gates"]["G1_integrity"] = g1

    # ---- fixtures vs truth (G2/G3 on synthetic, bank-A style scripted text)
    truth = json.load(open(FIXTURES_TRUTH))["sessions"] if Path(FIXTURES_TRUTH).exists() else []
    pairs, ep_ok, out_ok, sig = [], 0, 0, defaultdict(lambda: [0, 0, 0])
    omap = {"resolved": "resolved_proxy", "escalated": "escalated", "abandoned": "abandoned"}
    for t in truth:
        sid = t["session_id"]
        p = one("SELECT intent_id FROM session_intent WHERE session_id=? AND role='primary'", (sid,))
        pairs.append((t["primary_intent"], p))
        ep_ok += one("SELECT COUNT(*) FROM session_episode WHERE session_id=? AND kind='goal'", (sid,)) == t["n_goal_episodes"]
        out_ok += one("SELECT outcome FROM conversation_session WHERE session_id=?", (sid,)) == omap[t["outcome"]]
        got = {r[0] for r in con.execute("SELECT type FROM session_signal WHERE session_id=?", (sid,))}
        planted = set(t["planted_signals"])
        for typ in planted | (got & {x for tt in truth for x in tt["planted_signals"]}):
            sig[typ][0] += typ in planted and typ in got
            sig[typ][1] += typ not in planted and typ in got
            sig[typ][2] += typ in planted and typ not in got
    if truth:
        n = len(truth)
        fx = {"sessions": n, "primary_intent_accuracy_L3": round(sum(g == p for g, p in pairs) / n, 3),
              "macro_f1_L3": macro_f1(pairs), "macro_f1_L2": macro_f1([(tax.l2(g), tax.l2(p)) for g, p in pairs]),
              "goal_episode_count_accuracy": round(ep_ok / n, 3), "outcome_accuracy": round(out_ok / n, 3),
              "signal_recall_planted": round(sum(v[0] for v in sig.values()) / max(1, sum(v[0] + v[2] for v in sig.values())), 3),
              "per_signal": {k: prf(*v) for k, v in sorted(sig.items())},
              "note": "Planted-signal precision counts a detection in a session where the type was not deliberately planted as FP; fixtures contain incidental mentions, so precision here is a lower bound."}
        fx["pass"] = fx["primary_intent_accuracy_L3"] >= .95 and fx["goal_episode_count_accuracy"] >= .85 and fx["signal_recall_planted"] >= .95
        R["gates"]["fixtures_truth"] = fx

    # ---- real gold (draft, unreviewed)
    gold = [json.loads(l) for l in open(GOLD)] if GOLD.exists() else []
    gold = [g for g in gold if g.get("session_id")]
    if gold:
        gp, l2p, l1p = [], [], []
        flags = {k: [0, 0, 0] for k in ("handoff", "auth_failure", "abandoned", "asked_human")}
        gsig = {k: [0, 0, 0] for k in GOLD_SIGNALS}
        disagree = []
        for g in gold:
            sid = g["session_id"]
            p = one("SELECT intent_id FROM session_intent WHERE session_id=? AND role='primary'", (sid,))
            gp.append((g["primary"], p)); l2p.append((tax.l2(g["primary"]), tax.l2(p))); l1p.append((tax.l1(g["primary"]), tax.l1(p)))
            if p != g["primary"]:
                disagree.append({"session": g["external_id_prefix"], "gold": g["primary"], "pipeline": p, "ambiguous": g["ambiguous"], "note": g["note"]})
            types = {r[0] for r in con.execute("SELECT type FROM session_signal WHERE session_id=?", (sid,))}
            pred = {"handoff": "agent_handoff" in types, "auth_failure": "auth_failure" in types, "abandoned": "abandoned" in types,
                    "asked_human": "escalation_request" in types}
            for k, v in pred.items():
                flags[k][0] += v and g[k]; flags[k][1] += v and not g[k]; flags[k][2] += (not v) and g[k]
            for k in GOLD_SIGNALS:
                gs = k in g["signals"]; ps = k in types
                gsig[k][0] += gs and ps; gsig[k][1] += ps and not gs; gsig[k][2] += gs and not ps
        n = len(gold)
        R["gates"]["real_gold_draft"] = {
            "sessions": n, "reviewed": sum(1 for g in gold if g.get("reviewed")),
            "primary_accuracy_L3": round(sum(a == b for a, b in gp) / n, 3), "primary_accuracy_L2": round(sum(a == b for a, b in l2p) / n, 3),
            "primary_accuracy_L1": round(sum(a == b for a, b in l1p) / n, 3), "macro_f1_L3": macro_f1(gp), "macro_f1_L2": macro_f1(l2p),
            "unambiguous_primary_accuracy_L3": round(sum(a == b for (a, b), g in zip(gp, gold) if not g["ambiguous"]) / max(1, sum(not g["ambiguous"] for g in gold)), 3),
            "flags": {k: prf(*v) for k, v in flags.items()}, "signals": {k: prf(*v) for k, v in gsig.items()},
            "disagreements": disagree,
            "caveat": "Draft labels (pre-labelled by Claude, reviewed=false). n=36 is too small for stable estimates. Rules were adjusted after reviewing disagreements on this same set, so these agreement figures are optimistic; G3 needs a fresh SME-reviewed held-out set.",
        }

    # ---- governance / misc
    R["gates"]["governance"] = {
        "ground_truth_read_by_pipeline": [str(p.name) for p in (ROOT / "cie").glob("*.py")
                                          if p.name not in ("validate.py", "fixtures.py", "synth.py", "config.py") and re.search(r"FIXTURES_TRUTH|ground_truth|real_gold", p.read_text())],
        "unknown_primary_share": round(one("SELECT AVG(intent_id='UNKNOWN') FROM session_intent WHERE role='primary'") or 0, 3),
        "llm_calls": 0,
    }
    R["gates"]["governance"]["pass"] = not R["gates"]["governance"]["ground_truth_read_by_pipeline"]
    R["not_yet_computed"] = ["G0 calibration (needs 100K synthetic)", "G4 clusters", "G5 patterns", "G6 cards/facts", "G7 retrieval",
                             "G8 performance", "G9 volume shape", "G10 LLM correctness"]
    REPORTS.mkdir(exist_ok=True)
    json.dump(R, open(REPORTS / "validation.json", "w"), indent=1)
    (REPORTS / "validation.md").write_text(render_md(R))
    return R


def render_md(R):
    g = R["gates"]; L = ["# Validation report: Week 1", "", f"Versions: `{json.dumps(R['versions'])}`", ""]
    g1 = g["G1_integrity"]
    L += ["## G1 Data integrity: " + ("PASS" if g1["pass"] else "FAIL"), "",
          f"- Real sample: {g1['real_sessions']} sessions, {g1['real_traces']} traces (expected 36 / 241)",
          f"- Orphan traces {g1['orphan_traces']}, duplicate turn keys {g1['duplicate_turn_keys']}, synthetic rows without provenance {g1['synthetic_without_provenance']}, sessions without raw lineage {g1['sessions_without_raw_lineage']}, ingest rejects {g1['rejects']}",
          f"- PII patterns remaining after scrub: {g1['pii_hits_after_scrub']}",
          f"- Turn order restored for d9b52d90 (arrives shuffled): {g1['real_turn_order_d9b52d90']}", ""]
    if "fixtures_truth" in g:
        f = g["fixtures_truth"]
        L += ["## Scenario fixtures vs truth: " + ("PASS" if f["pass"] else "FAIL"), "",
              f"{f['sessions']} scripted synthetic sessions (every L3 intent x 2 + 12 special scenarios).", "",
              "| Check | Result |", "|---|---|",
              f"| Primary intent accuracy (L3) | {f['primary_intent_accuracy_L3']:.0%} |", f"| Macro-F1 L3 / L2 | {f['macro_f1_L3']} / {f['macro_f1_L2']} |",
              f"| Goal-episode count accuracy | {f['goal_episode_count_accuracy']:.0%} |", f"| Session outcome accuracy | {f['outcome_accuracy']:.0%} |",
              f"| Planted-signal recall | {f['signal_recall_planted']:.0%} |", "",
              "These are scripted fixtures whose wording the rules were tuned against: they prove the pipeline end to end, **not** real-world accuracy.", ""]
    if "real_gold_draft" in g:
        r = g["real_gold_draft"]
        L += ["## Real sample vs draft gold labels (directional)", "", f"> {r['caveat']}", "",
              "| Measure | Value |", "|---|---|",
              f"| Primary intent agreement L3 / L2 / L1 | {r['primary_accuracy_L3']:.0%} / {r['primary_accuracy_L2']:.0%} / {r['primary_accuracy_L1']:.0%} |",
              f"| L3 agreement on unambiguous sessions | {r['unambiguous_primary_accuracy_L3']:.0%} |",
              f"| Macro-F1 L3 / L2 | {r['macro_f1_L3']} / {r['macro_f1_L2']} |", "",
              "| Flag / signal | Precision | Recall | TP | FP | FN |", "|---|---|---|---|---|---|"]
        for k, v in [(f"{k} (session flag)", v) for k, v in r["flags"].items()] + list(r["signals"].items()):
            if v["tp"] + v["fp"] + v["fn"]:
                L.append(f"| {k} | {v['precision']} | {v['recall']} | {v['tp']} | {v['fp']} | {v['fn']} |")
        L += ["", "### Primary-intent disagreements", "", "| Session | Gold | Pipeline | Ambiguous | Note |", "|---|---|---|---|---|"]
        L += [f"| {d['session']} | {d['gold']} | {d['pipeline']} | {'yes' if d['ambiguous'] else ''} | {d['note']} |" for d in r["disagreements"]]
        L.append("")
    gv = g["governance"]
    L += ["## Governance", "", f"- Pipeline modules reading truth/gold files: {gv['ground_truth_read_by_pipeline'] or 'none'}",
          f"- UNKNOWN primary-intent share: {gv['unknown_primary_share']:.0%}", f"- LLM calls this run: {gv['llm_calls']}", "",
          "## Not yet computed", ""] + [f"- {x}" for x in R["not_yet_computed"]]
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    R = run()
    print(render_md(R))
