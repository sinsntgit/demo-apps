"""WP3 signals + WP4 rule-tier intent classification.

Per session: classify customer turns (taxonomy rules) -> turn_intent / session_intent, then extract signals from
text (lexicon), platform labels, tools, events, metadata and derived logic. Every signal row carries its evidence
turn (seq, turn_no, trace_id), method and rule version.
"""
from collections import defaultdict
from . import db
from .config import VERSIONS, AGENT_LOOP_JACCARD, CUSTOMER_REPEAT_JACCARD, NO_INPUT_ABANDON
from .lexicon import (TEXT_SIGNALS, INTENT_NEED_SIGNAL, TRANSFER_TOOL, AGENT_AUTH_FAIL, CITY_RE, CITY_LOOKUP, LOCATION_PH,
                      DEST_CUE, CURRENT_CUE, RESIDENCE_CUE, TOKEN, FAMILY_CATEGORY, INTENT_TOOLS, AUTH_ROLES)
from .taxonomy import Taxonomy, FAMILY_RANK

RV = VERSIONS["rules"]


TRIVIAL = {"yes", "no", "okay", "ok", "sure", "mhm", "mm-hm", "thank you", "thanks", "yeah", "right", "uh", "um"}


def _norm(x):
    return " ".join(TOKEN.findall((x or "").lower()))


def _is_repeat(a, b, thr):
    na, nb = _norm(a), _norm(b)
    if na and na == nb and na not in TRIVIAL:
        return True
    return _jacc(a, b) >= thr


def _jacc(a, b):
    A, B = set(TOKEN.findall((a or "").lower())), set(TOKEN.findall((b or "").lower()))
    if len(A) < 3 or len(B) < 3:
        return 0.0
    return len(A & B) / len(A | B)


def _city_type(prefix):
    if DEST_CUE.search(prefix): return "destination"
    if CURRENT_CUE.search(prefix): return "current"
    if RESIDENCE_CUE.search(prefix): return "residence"
    return "unknown"


def process_session(con, tax, sid):
    s = con.execute("SELECT * FROM conversation_session WHERE session_id=?", (sid,)).fetchone()
    turns = con.execute("SELECT * FROM conversation_turn WHERE session_id=? ORDER BY seq", (sid,)).fetchall()
    tools = con.execute("SELECT * FROM tool_call WHERE session_id=? ORDER BY seq", (sid,)).fetchall()
    by_seq = defaultdict(list)
    for t in tools:
        by_seq[t["seq"]].append(t)
    sigs, tintents = [], []
    syn = s["is_synthetic"]

    def add(t, fam, typ, value, text, conf, method):
        sigs.append((sid, t["seq"], t["turn_no"], t["trace_id"], fam, FAMILY_CATEGORY[fam], typ, value, (text or "")[:240], conf, method, RV, t["ts"], syn))

    # ---- intent classification (customer turn + platform labels/paraphrases set on that turn) ----
    turn_hits = []
    for t in turns:
        labels = [x["intent_name"] for x in by_seq[t["seq"]] if x["intent_name"]]
        paras = [x["query"] for x in by_seq[t["seq"]] if x["query"]]
        if t["kind"] != "utterance" and not labels and not paras:
            continue
        hits = tax.classify_turn(t["user_text"] or "", labels, paras)
        need_capture = any(x["tool"] in INTENT_TOOLS for x in by_seq[t["seq"]])
        in_auth = (t["agent_role"] or "") in AUTH_ROLES and not need_capture
        adj = []
        for code, conf, method, ev in hits:
            if need_capture and method in ("keyword", "weak_token", "paraphrase"):
                conf, method = min(.89, conf + .05), method + "@need_capture"     # platform's own need-capture turn
            if in_auth and code.startswith("ACCT.ACCESS"):
                conf, method = round(conf * .7, 2), method + "@auth_phase"         # auth friction, not the stated need
            adj.append((code, conf, method, ev))
        hits = sorted(adj, key=lambda x: (-x[1], x[0] == "ESCALATION.REP.REQUEST", FAMILY_RANK.get(tax.family(x[0]), 5), -len(x[3] or ""), x[0]))
        if hits:
            turn_hits.append((t["seq"], hits))
            code, conf, method, ev = hits[0]
            tintents.append((sid, t["seq"], code, conf, method, ev))
    # auth-phase account-access hits are friction, not needs: keep them out of session intents unless nothing else exists
    needs = [(q, [h for h in hs if "@auth_phase" not in h[2]]) for q, hs in turn_hits]
    needs = [(q, hs) for q, hs in needs if hs]
    sintents = tax.session_intents(needs or turn_hits)

    # ---- signals ---------------------------------------------------------
    prev_agent, prev_user = [], []
    for t in turns:
        u, a = t["user_text"], t["agent_text"]
        if t["kind"] == "utterance" and u:
            for fam, typ, conf, rx, _ in TEXT_SIGNALS:
                m = rx.search(u)
                if m:
                    add(t, fam, typ, m.group(0).lower(), u, conf, "lexicon")
            for m in CITY_RE.finditer(u):
                city = CITY_LOOKUP[m.group(1).lower()]
                ctype = _city_type(u[:m.start()])
                add(t, "geo", "city_mention", f"{city}|{ctype}", u, .85, "gazetteer")
                if s["city"] not in (None, "UNKNOWN") and city != s["city"]:
                    add(t, "geo", "location_mismatch", f"{city}|{ctype} vs service {s['city']}", u, .80, "derived")
            if LOCATION_PH.search(u):
                add(t, "geo", "location_unresolved", "[LOCATION]", u, .90, "placeholder")
            if any(_is_repeat(u, p, CUSTOMER_REPEAT_JACCARD) for p in prev_user):
                add(t, "friction", "customer_repeat", None, u, .80, "derived")
            prev_user.append(u)
        # need/buying/value lexicons also run on the agent's issue paraphrase (platform need-capture tools)
        for x in by_seq[t["seq"]]:
            if x["query"] and x["tool"] in INTENT_TOOLS:
                for fam, typ, conf, rx, _ in TEXT_SIGNALS:
                    if fam in ("need", "buying", "value", "risk") and rx.search(x["query"]):
                        add(t, fam, typ, rx.search(x["query"]).group(0).lower(), x["query"], round(conf * .9, 2), "lexicon@paraphrase")
        if t["kind"] == "event":
            if t["event_type"] == "no_input":
                add(t, "friction", "no_input", t["event_value"], "no user activity", .95, "event")
            if t["event_type"] == "dtmf" and (t["event_value"] or "").strip() == "0":
                add(t, "friction", "dtmf_operator", "0", "pressed 0", .95, "event")
        if a:
            if any(_jacc(a, p) >= AGENT_LOOP_JACCARD for p in prev_agent):
                add(t, "friction", "agent_loop", None, a, .80, "derived")
            prev_agent.append(a)
            if AGENT_AUTH_FAIL.search(a) and not any(x["tool"] == "invalid_auth" for x in by_seq[t["seq"]]):
                add(t, "friction", "auth_failure", AGENT_AUTH_FAIL.search(a).group(0), a, .80, "agent_text")
        for x in by_seq[t["seq"]]:
            name = x["tool"] or ""
            if TRANSFER_TOOL.search(name):
                add(t, "friction", "agent_handoff", name, name, .95, "tool")
            if name == "invalid_auth":
                add(t, "friction", "auth_failure", name, name, .95, "tool")
            if name == "handle_out_of_scope":
                add(t, "friction", "out_of_scope", x["intent_name"], x["query"], .90, "tool")
            if x["failed"]:
                add(t, "friction", "tool_failure", name, name, .90, "tool")
            if x["requested_operator"]:
                add(t, "friction", "escalation_request", "requested_operator", x["intent_name"], .95, "platform_intent")
    # intent-derived need / buying signals (one per turn)
    seq_turn = {t["seq"]: t for t in turns}
    for _, seq, code, conf, method, ev in tintents:
        t = seq_turn[seq]
        fam = tax.family(code)
        for prefix, typ in INTENT_NEED_SIGNAL:
            if code.startswith(prefix):
                add(t, "need", typ, code, ev, round(conf * .95, 2), "intent")
                break
        if fam == "buying" and code.startswith(("PLAN.ENQUIRY.OPTIONS",)):
            add(t, "buying", "plan_question", code, ev, round(conf * .95, 2), "intent")
    # session-level
    if turns:
        last = turns[-1]
        handoff = any(TRANSFER_TOOL.search(x["tool"] or "") for x in tools)
        tail_noinput = sum(1 for t in turns[-3:] if t["event_type"] == "no_input")
        if not handoff and (last["event_type"] == "disconnect" or tail_noinput >= NO_INPUT_ABANDON):
            add(last, "friction", "abandoned", last["event_type"], "session ended without handoff", .85, "derived")
        if s["previous_session_id"]:
            add(turns[0], "temporal", "repeat_contact", s["previous_session_id"], "thread-linked via previous_session_id", .99, "metadata")
    return sigs, tintents, sintents


def run(con, tax=None):
    tax = tax or Taxonomy()
    tax.load_db(con)
    with db.stage(con, "signals+intents", {**VERSIONS, "taxonomy": tax.version}) as (run_id, stats):
        for tb in ("session_signal", "turn_intent", "session_intent"):
            con.execute(f"DELETE FROM {tb}")
        n_sig = 0
        sids = [r[0] for r in con.execute("SELECT session_id FROM conversation_session")]
        for sid in sids:
            sigs, ti, si = process_session(con, tax, sid)
            con.executemany("INSERT INTO session_signal(session_id,seq,turn_no,trace_id,family,category,type,value,text,confidence,method,rule_version,ts,is_synthetic) "
                            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", sigs)
            con.executemany("INSERT INTO turn_intent VALUES(?,?,?,?,?,?)", ti)
            con.executemany("INSERT INTO session_intent VALUES(?,?,?,?,?,?,?)", [(sid, a, b, c, d, tax.version, e) for a, b, c, d, e in si])
            n_sig += len(sigs)
        # thread pass: repeat_same_issue = same L2 primary intent as the previous session in the thread
        rows = con.execute("""SELECT s.session_id, s.previous_session_id, si.intent_id, p.intent_id AS prev_intent
                              FROM conversation_session s
                              JOIN session_intent si ON si.session_id=s.session_id AND si.role='primary'
                              JOIN session_intent p ON p.session_id=s.previous_session_id AND p.role='primary'
                              WHERE s.previous_session_id IS NOT NULL""").fetchall()
        for r in rows:
            if r["intent_id"] != "UNKNOWN" and tax.l2(r["intent_id"]) == tax.l2(r["prev_intent"]):
                t = con.execute("SELECT seq,turn_no,trace_id,ts FROM conversation_turn WHERE session_id=? ORDER BY seq LIMIT 1", (r["session_id"],)).fetchone()
                con.execute("INSERT INTO session_signal(session_id,seq,turn_no,trace_id,family,category,type,value,text,confidence,method,rule_version,ts,is_synthetic) "
                            "SELECT ?,?,?,?, 'temporal', ?, 'repeat_same_issue', ?, 'same L2 intent as previous session', .9, 'derived', ?, ?, is_synthetic FROM conversation_session WHERE session_id=?",
                            (r["session_id"], t["seq"], t["turn_no"], t["trace_id"], FAMILY_CATEGORY["temporal"], tax.l2(r["intent_id"]), RV, t["ts"], r["session_id"]))
                n_sig += 1
        stats.update(sessions=len(sids), signals=n_sig)
    return stats
