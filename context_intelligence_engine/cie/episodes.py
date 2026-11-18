"""WP5 episodes (AGENTS.md §2.5), need journeys and session features.

Episode = one distinct customer need inside a session. The leading login/IVR span is kind='access'.
Boundary rules (priority order), applied to customer turns that carry an intent:
  1. a platform intent label whose L2 differs from the open episode's L2;
  2. a substantive turn intent (conf >= .70) with a different L2 that holds for INTENT_HOLD_TURNS customer turns
     (a domain-agent role change is recorded as supporting evidence, never a boundary on its own);
  3. an explicit new-need cue ("also", "one more thing") with a different L2.
A keyword-only intent change on a turn that carries a value signal (price, comparison, ...) does NOT open an episode:
it is evidence about the current need (kept as a secondary intent + value signal).
ESCALATION.REP.REQUEST never opens a new goal episode once one is open (it is friction, not a need).
"""
import re
from collections import defaultdict, Counter
from datetime import datetime
from . import db
from .config import (VERSIONS, INTENT_HOLD_TURNS, JOURNEY_WINDOW_DAYS, SEGMENT_RULES, SEGMENT_MIN_SCORE, FRICTION_WEIGHTS,
                     FRICTION_SCALE, NEW_NEED_CUE)
from .lexicon import GENERIC_ROLES, TRANSFER_TOOL, AGENT_HANDOFF_TEXT
from .taxonomy import Taxonomy, REP_INTENT, UNKNOWN

NEW_NEED = re.compile(NEW_NEED_CUE, re.I)
SUBSTANTIVE = 0.70


def _ts(x):
    try:
        return datetime.fromisoformat((x or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def segment_session(sid, turns, ti, tools, sigs, tax):
    """Return list of episode dicts."""
    tint = {r["seq"]: r for r in ti}
    platform_at = defaultdict(list)
    for x in tools:
        if x["intent_name"]:
            platform_at[x["seq"]].append(x["intent_name"])
    value_at = defaultdict(bool)
    for s in sigs:
        if s["family"] == "value":
            value_at[s["seq"]] = True
    eps, cur = [], None
    utter_seqs = [t["seq"] for t in turns if t["kind"] == "utterance"]

    def holds(seq, l2):
        nxt = [s for s in utter_seqs if s > seq][: INTENT_HOLD_TURNS - 1]
        if not nxt:
            return True
        return all((tint.get(s) is None) or tax.l2(tint[s]["intent_id"]) == l2 or tint[s]["intent_id"] == REP_INTENT for s in nxt)

    for t in turns:
        role = t["agent_role"] or ""
        it = tint.get(t["seq"])
        start_reason = None
        if it and "@auth_phase" in (it["method"] or "") and (cur is None or cur["kind"] == "access"):
            it = None                                # auth-phase friction stays in the access episode
        if it and it["intent_id"] not in (UNKNOWN,):
            code, conf = it["intent_id"], it["confidence"]
            l2 = tax.l2(code)
            if cur is None or cur["kind"] == "access":
                if code != REP_INTENT or not any(e["kind"] == "goal" for e in eps):
                    start_reason = "first_intent"
            elif code != REP_INTENT and l2 != tax.l2(cur["intent_id"]):
                if platform_at.get(t["seq"]) and it["method"] == "platform_intent":
                    start_reason = "platform_label"
                elif t["user_text"] and NEW_NEED.search(t["user_text"]):
                    start_reason = "new_need_cue"
                elif conf >= SUBSTANTIVE and holds(t["seq"], l2) and not value_at.get(t["seq"]):
                    start_reason = "intent_change"   # a value statement inside a need is evidence, not a new need
                if start_reason and role and role not in GENERIC_ROLES and role != cur.get("domain_agent"):
                    start_reason += "+role_change"
            elif cur["intent_id"] == REP_INTENT and code != REP_INTENT:
                # representative-only episode turns into a real need: upgrade the episode's intent in place
                cur.update(intent_id=code, intent_conf=conf)
        if start_reason:
            cur = dict(kind="goal", start=t["seq"], end=t["seq"], intent_id=it["intent_id"], intent_conf=it["confidence"],
                       domain_agent=role if role not in GENERIC_ROLES else None, boundary=start_reason, seqs=[t["seq"]])
            eps.append(cur)
            continue
        if cur is None:
            cur = dict(kind="access", start=t["seq"], end=t["seq"], intent_id=None, intent_conf=None, domain_agent=None,
                       boundary="session_start", seqs=[])
            eps.append(cur)
        cur["end"] = t["seq"]; cur["seqs"].append(t["seq"])
        if cur["kind"] == "goal" and not cur["domain_agent"] and role and role not in GENERIC_ROLES:
            cur["domain_agent"] = role
    if not any(e["kind"] == "goal" for e in eps):  # no stated need: promote access episode if it carried an intent
        auth_it = [r for r in ti if r["intent_id"] not in (UNKNOWN,)]
        if auth_it and eps:
            eps[0].update(kind="goal", intent_id=auth_it[0]["intent_id"], intent_conf=auth_it[0]["confidence"], boundary="only_intent")
    # attach per-episode features
    by_seq_t = {t["seq"]: t for t in turns}
    sig_by_seq = defaultdict(list)
    for s in sigs:
        sig_by_seq[s["seq"]].append(s)
    goal_eps = [e for e in eps if e["kind"] == "goal"]
    for i, e in enumerate(eps):
        seqs = range(e["start"], e["end"] + 1)
        stypes = [s["type"] for q in seqs for s in sig_by_seq[q]]
        ttools = [x["tool"] for x in tools if x["seq"] in seqs]
        texts = [x["query"] for x in tools if x["seq"] in seqs and x["query"]]
        texts += [x["intent_name"] for x in tools if x["seq"] in seqs and x["intent_name"]]
        texts += [by_seq_t[q]["user_text"] for q in seqs if by_seq_t[q]["user_text"]]
        handoff = any(TRANSFER_TOOL.search(n or "") for n in ttools) or any(AGENT_HANDOFF_TEXT.search(by_seq_t[q]["agent_text"] or "") for q in seqs)
        is_last = e is eps[-1]
        if handoff:
            outcome, basis = "escalated", "tool:transfer" if any(TRANSFER_TOOL.search(n or "") for n in ttools) else "agent_text:handoff"
        elif "abandoned" in stypes:
            outcome, basis = "abandoned", "event:disconnect/no_input"
        elif e["kind"] == "goal" and not is_last:
            outcome, basis = "moved_on", "next_episode_started"
        else:
            outcome, basis = "resolved_proxy", "no handoff, no abandonment"
        fr = sum(FRICTION_WEIGHTS.get(x, 0) for x in stypes)
        e.update(text=" | ".join(texts)[:4000], n_user=sum(1 for q in seqs if by_seq_t[q]["kind"] == "utterance"),
                 outcome=outcome, basis=basis, friction=round(min(1.0, fr / FRICTION_SCALE), 3), stypes=sorted(set(stypes)),
                 platform=next((x["intent_name"] for x in tools if x["seq"] in seqs and x["intent_name"]), None))
    return eps


def _segment(types_count):
    best, best_score = "General", 0.0
    for name, w in SEGMENT_RULES:
        sc = sum(w.get(t, 0) * min(c, 2) for t, c in types_count.items())
        if sc > best_score:
            best, best_score = name, sc
    return best if best_score >= SEGMENT_MIN_SCORE else "General"


def run(con, tax=None):
    tax = tax or Taxonomy()
    with db.stage(con, "episodes+features", VERSIONS) as (run_id, stats):
        for tb in ("session_episode", "need_journey", "session_feature"):
            con.execute(f"DELETE FROM {tb}")
        sids = [r[0] for r in con.execute("SELECT session_id FROM conversation_session ORDER BY created_at")]
        n_ep = 0
        for k, sid in enumerate(sids, 1):
            if k % 20000 == 0:
                print(f"  episodes: {k:,} of {len(sids):,} sessions", flush=True)
            turns = con.execute("SELECT * FROM conversation_turn WHERE session_id=? ORDER BY seq", (sid,)).fetchall()
            ti = con.execute("SELECT * FROM turn_intent WHERE session_id=?", (sid,)).fetchall()
            tools = con.execute("SELECT * FROM tool_call WHERE session_id=? ORDER BY seq", (sid,)).fetchall()
            sigs = con.execute("SELECT * FROM session_signal WHERE session_id=?", (sid,)).fetchall()
            eps = segment_session(sid, turns, ti, tools, sigs, tax)
            for k, e in enumerate(eps):
                con.execute("INSERT INTO session_episode VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (f"{sid}#{k}", sid, k, e["kind"], e["start"], e["end"], e["intent_id"], e["intent_conf"], e["domain_agent"],
                             e["platform"], e["text"], e["n_user"], e["outcome"], e["basis"], e["friction"], ",".join(e["stypes"]), e["boundary"]))
            n_ep += len(eps)
            # session outcome + features
            types = Counter(s["type"] for s in sigs)
            fams = {s["family"] for s in sigs}
            if types["agent_handoff"]:
                outcome, basis = "escalated", "tool:transfer"
            elif types["abandoned"]:
                outcome, basis = "abandoned", "event:disconnect/no_input"
            else:
                outcome, basis = "resolved_proxy", "no handoff, no abandonment (proxy; not a verified resolution)"
            con.execute("UPDATE conversation_session SET outcome=?, outcome_basis=? WHERE session_id=?", (outcome, basis, sid))
            s = con.execute("SELECT previous_session_id, created_at FROM conversation_session WHERE session_id=?", (sid,)).fetchone()
            dsp = None
            if s["previous_session_id"]:
                p = con.execute("SELECT created_at FROM conversation_session WHERE session_id=?", (s["previous_session_id"],)).fetchone()
                if p and _ts(p[0]) and _ts(s["created_at"]):
                    dsp = round((_ts(s["created_at"]) - _ts(p[0])).total_seconds() / 86400, 2)
            fr = min(1.0, sum(FRICTION_WEIGHTS.get(t, 0) * c for t, c in types.items()) / FRICTION_SCALE)
            buying = int("buying" in fams); value = int("value" in fams)
            risk = int(bool(types["churn_intent"] or types["dispute"] or types["complaint"] or types["repeat_same_issue"]))
            style = "agent-seeking" if types["escalation_request"] or types["dtmf_operator"] else "self-serve"
            con.execute("INSERT INTO session_feature VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (sid, round(fr, 3), types["escalation_request"], types["auth_failure"], types["no_input"], types["agent_handoff"],
                         int(bool(s["previous_session_id"])), dsp, int("need" in fams), buying, value, risk,
                         int((buying or value) and not types["churn_intent"]), _segment(types), style))
        # need journeys: goal episodes with the same L2 across a thread within the window
        rows = con.execute("""SELECT e.*, s.thread_id, s.created_at FROM session_episode e JOIN conversation_session s USING(session_id)
                              WHERE e.kind='goal' AND e.intent_id IS NOT NULL AND e.intent_id NOT IN ('UNKNOWN', ?)
                              ORDER BY s.thread_id, s.created_at, e.ep_no""", (REP_INTENT,)).fetchall()
        groups = defaultdict(list)
        for r in rows:
            groups[(r["thread_id"], tax.l2(r["intent_id"]))].append(r)
        nj = 0
        for (thread, l2), eps in groups.items():
            chunk = [eps[0]]
            for e in eps[1:] + [None]:
                if e is not None and _ts(e["created_at"]) and _ts(chunk[-1]["created_at"]) and \
                        (_ts(e["created_at"]) - _ts(chunk[-1]["created_at"])).days <= JOURNEY_WINDOW_DAYS:
                    chunk.append(e); continue
                sess = list(dict.fromkeys(c["session_id"] for c in chunk))
                nj += 1
                con.execute("INSERT INTO need_journey VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            (f"J:{thread}:{l2}:{nj}", thread, l2, sess[0], sess[-1], chunk[0]["created_at"], chunk[-1]["created_at"],
                             len(sess), len(chunk), int(chunk[-1]["outcome"] == "resolved_proxy"), chunk[-1]["outcome"]))
                if e is not None:
                    chunk = [e]
        stats.update(sessions=len(sids), episodes=n_ep, journeys=nj)
    return stats
