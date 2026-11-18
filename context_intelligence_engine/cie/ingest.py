"""WP1 raw landing + ingestion, WP2 evaluation mapping.

Reads only redacted_* fields. Raw lines are landed (gzipped, immutable) and indexed by line number + sha256.
Idempotent: re-ingesting a session replaces its rows.
"""
import gzip, hashlib, json, re, shutil, datetime as dt
from pathlib import Path
from . import db
from .config import LANDING, LOCATION_PATHS, LOCATION_TYPE_DEFAULT, VERSIONS
from .lexicon import (MARKUP, PII_PATTERNS, EVENT_RE, DTMF_RE, NOINPUT_RE, FUNC_RE, LANG_MARKERS, CITY_INFO, STATE_REGION,
                      CITY_LOOKUP, AUTH_ROLES, UNAUTH_ROLE)

TURN_RE = re.compile(r"turn\s+(\d+)", re.I)
TRACE_METRICS = {"context_adherence_luna", "VZ Helpfulness", "VZ PolicyAdherence", "VZ SkillAdherence", "instruction_adherence",
                 "factuality", "tool_selection_quality", "input_toxicity", "prompt_injection", "input_pii", "VZ GracefulEscalation"}
CANONICAL = {  # raw metric -> (canonical name, scale)
    "conversation_quality": ("quality", "0-1"), "Conversation Quality Voice Agent": ("quality_voice", "0-1"),
    "agentic_session_success": ("task_success", "0-1"), "Action_Completion_Voice_Agent": ("task_success_voice", "0-1"),
    "agent_efficiency": ("efficiency", "0-1"), "agent_flow": ("flow", "0-1"), "VZ ContextRecall": ("context_recall", "0-1"),
    "VZ TamperBypassProtection": ("tamper_protection", "0-1"), "cm_session_avg_turn_latency_sec": ("avg_turn_latency", "seconds"),
    "cm_session_p90_turn_latency_sec": ("p90_turn_latency", "seconds"), "VZ Helpfulness": ("helpfulness", "0-1"),
    "VZ PolicyAdherence": ("policy_adherence", "0-1"), "context_adherence_luna": ("context_adherence", "0-1"),
    "instruction_adherence": ("instruction_adherence", "0-1"), "factuality": ("factuality", "0-1"),
    "tool_selection_quality": ("tool_selection", "0-1"), "VZ GracefulEscalation": ("graceful_escalation", "0-1"),
}
SKIP_SUFFIX = ("_tokens", "_cost", "_num_judges", "_ems_error_code", "_scorer_version_id", "_model_alias", "_multijudge_average")


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _jl(s):
    if s is None or s == "":
        return []
    if isinstance(s, (list, dict)):
        return s if isinstance(s, list) else [s]
    try:
        v = json.loads(s)
        return v if isinstance(v, list) else [v]
    except Exception:
        return [{"role": "?", "content": str(s)}]


def scrub(text, counter):
    if not text:
        return text
    for ph, rx in PII_PATTERNS:
        text, n = rx.subn(ph, text)
        counter[0] += n
    return text


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        return content.get("content") if isinstance(content.get("content"), str) else ""
    return ""


def detect_lang(text):
    for lang, rx in LANG_MARKERS.items():
        if text and len(rx.findall(text)) >= 1 and not re.search(r"\b(the|and|my|is|i)\b", text, re.I):
            return lang
    return "en"


def parse_location(rec):
    """AGENTS.md §2.7 lookup order. Returns dict(city,state,zip3,market,region,geo_source) or None."""
    um = rec.get("user_metadata") or {}
    for mode, _path, prefix in LOCATION_PATHS:
        raw = None
        if mode == "flat" and isinstance(um, dict) and any(k.startswith(prefix) for k in um):
            raw = {k[len(prefix):]: v for k, v in um.items() if k.startswith(prefix)}
        elif mode == "nested" and isinstance(um.get("location"), dict):
            raw = um["location"]
        elif mode == "trace_flat":
            tr = (rec.get("traces") or [{}])[0] or {}
            tum = tr.get("user_metadata") or {}
            if any(k.startswith(prefix) for k in tum):
                raw = {k[len(prefix):]: v for k, v in tum.items() if k.startswith(prefix)}
        elif mode == "tags":
            kv = dict(t.split(":", 1) for t in (rec.get("tags") or []) if isinstance(t, str) and t.startswith(prefix) and ":" in t)
            if kv:
                raw = {k[len(prefix):]: v for k, v in kv.items()}
        if raw:
            city = CITY_LOOKUP.get(str(raw.get("city", "")).strip().lower(), str(raw.get("city", "")).strip().title() or None)
            info = CITY_INFO.get(city, {})
            state = (raw.get("state") or info.get("state") or "").upper()[:2] or None
            z = re.sub(r"\D", "", str(raw.get("zip3") or raw.get("zip") or ""))[:3] or None   # ZIP5 never stored
            return {"city": city or "UNKNOWN", "state": state, "zip3": z, "market": raw.get("market") or info.get("market"),
                    "region": raw.get("region") or info.get("region") or STATE_REGION.get(state, "Unmapped"),
                    "geo_source": f"structured:{mode}"}
    return None


def _num(v):
    if isinstance(v, list):
        xs = [x for x in v if isinstance(x, (int, float))]
        return sum(xs) / len(xs) if xs else None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


def explode_metrics(metrics, entity_type, entity_id, session_id, only=None):
    rows, verdicts = [], []
    if not isinstance(metrics, dict):
        return rows, verdicts
    bases = {k for k in metrics if not k.endswith(SKIP_SUFFIX) and "@" not in k
             and not re.search(r"_(status|rationale|explanation|error_message)$", k)}
    for b in sorted(bases):
        if only and b not in only:
            continue
        v = metrics[b]
        if b == "cm_policy_metric":
            try:
                pm = json.loads(v) if isinstance(v, str) else v
                m = pm.get("metrics", {})
                rows.append((entity_type, entity_id, session_id, b, "policy_compliance", _num(m.get("overall_compliance_rate")),
                             m.get("journey"), "0-1", "ok", (pm.get("_routing") or {}).get("model"), None, None))
                for vd in m.get("verdicts") or []:
                    verdicts.append((session_id, m.get("journey"), vd.get("policy_id"), vd.get("verdict"), vd.get("severity"),
                                     vd.get("policy_type"), vd.get("evidence"), vd.get("reason")))
            except Exception:
                rows.append((entity_type, entity_id, session_id, b, "policy_compliance", None, str(v)[:200], "0-1", "unparseable", None, None, None))
            continue
        if b == "duration_ns":
            continue
        status = metrics.get(f"{b}_status") or ("error" if metrics.get(f"{b}_error_message") or v == "error" else "ok")
        val = _num(v) if status not in ("not_applicable", "error") else None
        if val is None and status == "ok" and not isinstance(v, (int, float, list)):
            status = "non_numeric"
        rationale = metrics.get(f"{b}_rationale") or metrics.get(f"{b}_explanation") or metrics.get(f"{b}_error_message")
        canon, scale = CANONICAL.get(b, (None, None))
        rows.append((entity_type, entity_id, session_id, b, canon, val, None if val is not None else (str(v)[:200] if v is not None else None),
                     scale, status, metrics.get(f"{b}_model_alias"), (rationale or "")[:2000] or None, metrics.get(f"{b}_scorer_version_id")))
    return rows, verdicts


def _walk_spans(spans, trace_id, sid, parent, depth, out_spans, out_tools, seq):
    for i, s in enumerate(spans or []):
        if not isinstance(s, dict):
            continue
        span_id = s.get("id") or f"{trace_id}/{depth}.{i}"
        out_spans.append((span_id, trace_id, sid, s.get("parent_id") or parent, depth, s.get("type"), s.get("name"), str(s.get("step_number") or "")))
        if s.get("type") == "tool":
            msgs = _jl(s.get("redacted_input") if s.get("redacted_input") is not None else s.get("input"))
            role = msgs[0].get("role") if msgs and isinstance(msgs[0], dict) else None
            args = msgs[0].get("content") if msgs and isinstance(msgs[0], dict) else {}
            args = args if isinstance(args, dict) else {}
            outs = json.dumps(s.get("output"))[:4000] if s.get("output") is not None else ""
            failed = int(str(s.get("status_code", "0")) not in ("0", "200", "None", "") or bool(re.search(r'\\?"status\\?":\s*\\?"(error|failed)', outs)))
            out_tools.append((sid, seq, trace_id, s.get("name"), (role or "").lower(), args.get("intent_name") or (args.get("topic") if s.get("name") == "handle_out_of_scope" else None),
                              args.get("query") or args.get("user_intent") or args.get("user_utterance"),
                              int(bool(args.get("requested_operator"))) if "requested_operator" in args else None, failed,
                              json.dumps(args)[:1000]))
        kids = s.get("spans")
        if isinstance(kids, str):            # nested spans sometimes arrive as a repr string; skip safely
            kids = None
        _walk_spans(kids, trace_id, sid, span_id, depth + 1, out_spans, out_tools, seq)


def normalise(rec, source, counter):
    sid = rec.get("session_id") or rec.get("id")
    traces = rec.get("traces") or []
    if not sid or not isinstance(traces, list):
        raise ValueError("missing session_id or traces")

    def key(t):
        m = TURN_RE.search(t.get("name") or "")
        return (int(m.group(1)) if m else 10 ** 6, t.get("created_at") or "")
    traces = sorted(traces, key=key)
    turns, ctraces, spans, tools = [], [], [], []
    roles_seen, n_user = set(), 0
    for seq, t in enumerate(traces):
        m = TURN_RE.search(t.get("name") or "")
        turn_no = int(m.group(1)) if m else None
        tid = t.get("trace_id") or t.get("id") or f"{sid}/{seq}"
        uin = _jl(t.get("redacted_input"))
        utext = " ".join(_text(x.get("content")) for x in uin if isinstance(x, dict) and x.get("role") == "user").strip()
        kind, etype, evalue = "utterance", None, None
        em = EVENT_RE.match(utext or "")
        if em:
            kind, body = "event", em.group(2).strip()
            if em.group(1) == "event":
                etype, evalue = ("session_start" if "session start" in body else "disconnect" if "disconnect" in body else "event"), body[:120]
            elif DTMF_RE.search(body):
                etype, evalue = "dtmf", DTMF_RE.search(body).group(1)
            elif NOINPUT_RE.search(body):
                etype, evalue = "no_input", re.sub(r"\D", "", body)[:4]
            elif FUNC_RE.search(body):
                etype, evalue = "function_result", FUNC_RE.search(body).group(1)
            else:
                etype, evalue = "context", body[:120]
            utext = None
        else:
            n_user += 1 if utext else 0
            utext = scrub(utext, counter)
        outs = [x for x in _jl(t.get("redacted_output")) if isinstance(x, dict)]
        roles = [str(x.get("role") or "").lower() for x in outs]
        roles_seen.update(roles)
        atext = " ".join(MARKUP.sub("", _text(x.get("content"))) for x in outs if x.get("role") != "tool").strip()
        atext = re.sub(r"\s{2,}", " ", scrub(atext, counter)) or None
        primary = next((r for r in roles if r and r != "tool"), roles[0] if roles else None)
        turns.append((sid, turn_no, seq, tid, t.get("created_at"), kind, etype, evalue, utext, atext, primary, ",".join(roles),
                      detect_lang(utext) if utext else None))
        n_sp_before = len(spans)
        _walk_spans(t.get("spans"), tid, sid, tid, 0, spans, tools, seq)
        ctraces.append((tid, sid, turn_no, seq, t.get("created_at"), str(t.get("status_code")), str(t.get("is_complete")), len(spans) - n_sp_before))
    created = rec.get("created_at") or (traces[0].get("created_at") if traces else None)
    d = (created or "")[:10]
    try:
        iso = dt.date.fromisoformat(d).isocalendar(); week = f"{iso[0]}-W{iso[1]:02d}"
    except ValueError:
        week = None
    tool_names = {x[3] for x in tools}
    if any(UNAUTH_ROLE.search(r or "") for r in roles_seen) or "invalid_auth" in tool_names:
        auth = "unauthenticated"
    elif roles_seen - AUTH_ROLES - {"bootstrap_agent", "root_agent", "tool", "", "smart_greeting"} or "set_mdn_confirmation" in tool_names:
        auth = "authenticated"
    else:
        auth = "unknown"
    journey = None
    try:
        journey = json.loads(rec.get("metrics", {}).get("cm_policy_metric") or "{}").get("metrics", {}).get("journey")
    except Exception:
        pass
    langs = [x[12] for x in turns if x[12]]
    lang = max(set(langs), key=langs.count) if langs else None
    if langs and any(l != "en" for l in langs) and lang == "en":
        lang = "en+" + ",".join(sorted({l for l in langs if l != "en"}))
    loc = parse_location(rec) or {"city": "UNKNOWN", "state": None, "zip3": None, "market": None, "region": None, "geo_source": "none"}
    meta = rec.get("dataset_metadata") or {}
    is_syn = int(bool(meta.get("is_synthetic")) or source != "verizon_sample")
    prov_id = f"{source}:{meta.get('batch', 'sample')}:{meta.get('scenario_id', '')}"
    session = dict(session_id=sid, external_id=rec.get("external_id"), source=source, is_synthetic=is_syn, provenance_id=prov_id,
                   created_at=created, day=d or None, week=week, previous_session_id=rec.get("previous_session_id"),
                   customer_key=None, lang=lang, n_traces=len(traces), n_turns=len(turns), n_user_utterances=n_user,
                   first_turn_no=turns[0][1] if turns else None, auth_state=auth, journey_label=journey,
                   city=loc["city"], state=loc["state"], region=loc["region"], market=loc["market"], zip3=loc["zip3"],
                   geo_source=loc["geo_source"], location_type=LOCATION_TYPE_DEFAULT if loc["geo_source"] != "none" else None,
                   split=meta.get("split"))
    evals, verdicts = explode_metrics(rec.get("metrics"), "session", sid, sid)
    for t in traces:
        tid = t.get("trace_id") or t.get("id")
        e2, _ = explode_metrics(t.get("metrics"), "trace", tid, sid, only=TRACE_METRICS)
        evals += e2
    prov = (prov_id, source, is_syn, meta.get("batch"), meta.get("scenario_id"), meta.get("template_id"), meta.get("generator_version"), meta.get("seed"))
    return session, turns, ctraces, spans, tools, evals, verdicts, prov


def _delete_session(con, sid):
    for tb in ("conversation_turn", "conversation_trace", "trace_span", "tool_call", "agent_evaluation", "policy_verdict"):
        con.execute(f"DELETE FROM {tb} WHERE session_id=?", (sid,))


def ingest_file(con, path, source):
    path = Path(path)
    day = dt.date.today().isoformat()
    land_dir = LANDING / source / day
    land_dir.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for blk in iter(lambda: fh.read(1 << 20), b""):
            h.update(blk)
    # content-addressed: the same name with different content lands as a new file; landed files are never overwritten
    landed = land_dir / f"{h.hexdigest()[:16]}_{path.name if path.suffix == '.gz' else path.name + '.gz'}"
    if not landed.exists():
        with open(path, "rb") as src, gzip.open(landed, "wb") as dst:
            shutil.copyfileobj(src, dst)
    opener = gzip.open if path.suffix == ".gz" else open
    counter = [0]
    with db.stage(con, f"ingest:{source}", VERSIONS) as (run_id, stats):
        n_ok = n_bad = n_turns = 0
        offset = 0
        with opener(path, "rb") as f:
            for line_no, raw in enumerate(f, 1):
                blen = len(raw)
                if not raw.strip():
                    offset += blen; continue
                try:
                    rec = json.loads(raw)
                    s, turns, ctr, sp, tl, ev, vd, prov = normalise(rec, source, counter)
                except Exception as e:
                    con.execute("INSERT INTO ingest_reject VALUES(?,?,?,?,?)", (run_id, str(path), line_no, repr(e)[:300], raw[:200].decode("utf8", "replace")))
                    n_bad += 1; offset += blen; continue
                sid = s["session_id"]
                if con.execute("SELECT 1 FROM raw_trace_session WHERE session_id=?", (sid,)).fetchone():
                    _delete_session(con, sid)                      # re-ingest: replace this session's rows
                s["run_id"] = run_id
                con.execute(f"INSERT OR REPLACE INTO conversation_session({','.join(s)}) VALUES({','.join('?' * len(s))})", tuple(s.values()))
                con.executemany("INSERT INTO conversation_turn VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", turns)
                con.executemany("INSERT OR REPLACE INTO conversation_trace VALUES(?,?,?,?,?,?,?,?)", ctr)
                con.executemany("INSERT INTO trace_span VALUES(?,?,?,?,?,?,?,?)", sp)
                con.executemany("INSERT INTO tool_call VALUES(?,?,?,?,?,?,?,?,?,?)", tl)
                con.executemany("INSERT INTO agent_evaluation VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", ev)
                con.executemany("INSERT INTO policy_verdict VALUES(?,?,?,?,?,?,?,?)", vd)
                con.execute("INSERT OR REPLACE INTO data_provenance VALUES(?,?,?,?,?,?,?,?)", prov)
                con.execute("INSERT OR REPLACE INTO raw_trace_session VALUES(?,?,?,?,?,?,?,?,?)",
                            (sid, source, str(landed.relative_to(LANDING.parent)), line_no, offset, blen, hashlib.sha256(raw).hexdigest(), _now(), run_id))
                n_ok += 1; n_turns += len(turns); offset += blen
                if n_ok % 20000 == 0:
                    con.commit(); print(f"  ingested {n_ok:,} sessions", flush=True)
        stats.update(file=str(path.name), sessions=n_ok, turns=n_turns, rejected=n_bad, pii_scrubbed=counter[0])
    resolve_threads(con)
    return stats


def resolve_threads(con):
    """Union-find over previous_session_id; thread_id = root session id, thread_pos = order by created_at."""
    rows = con.execute("SELECT session_id, previous_session_id, created_at FROM conversation_session").fetchall()
    parent = {r[0]: r[1] for r in rows}
    root = {}

    def find(s, seen=()):
        chain = []
        while s in parent and parent[s] and parent[s] in parent and s not in chain:
            chain.append(s); s = parent[s]
        return s
    for sid in parent:
        root[sid] = find(sid)
    groups = {}
    for sid, prev, created in rows:
        groups.setdefault(root[sid], []).append((created or "", sid))
    for r, members in groups.items():
        for pos, (_, sid) in enumerate(sorted(members)):
            con.execute("UPDATE conversation_session SET thread_id=?, thread_pos=? WHERE session_id=?", (r, pos, sid))
    con.commit()
