"""Canonical session-centric schema (AGENTS.md §5). This file is the physical source of truth.

Grain: one row per complete conversation in conversation_session; every child row carries session_id.
Raw payloads stay in immutable gzipped landing files; raw_trace_session holds the pointer + checksum.
"""
import sqlite3
from contextlib import contextmanager
from .config import DB_PATH, DATA

SCHEMA = """
-- governance -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processing_run(
  run_id INTEGER PRIMARY KEY AUTOINCREMENT, stage TEXT, started_at TEXT, finished_at TEXT, status TEXT,
  versions TEXT, stats TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS data_provenance(
  provenance_id TEXT PRIMARY KEY, source TEXT, is_synthetic INTEGER, batch TEXT, scenario_id TEXT,
  template_id TEXT, generator_version TEXT, seed INTEGER);
CREATE TABLE IF NOT EXISTS review_log(
  review_id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT, object_id TEXT, action TEXT, reviewer TEXT,
  note TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS ingest_reject(run_id INTEGER, file TEXT, line_no INTEGER, reason TEXT, snippet TEXT);

-- raw --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_trace_session(
  session_id TEXT PRIMARY KEY, source TEXT, landing_file TEXT, line_no INTEGER, byte_offset INTEGER,
  byte_len INTEGER, sha256 TEXT, landed_at TEXT, run_id INTEGER);

-- conversation -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_session(
  session_id TEXT PRIMARY KEY, external_id TEXT, source TEXT, is_synthetic INTEGER, provenance_id TEXT,
  created_at TEXT, day TEXT, week TEXT, previous_session_id TEXT, thread_id TEXT, thread_pos INTEGER,
  customer_key TEXT, lang TEXT, n_traces INTEGER, n_turns INTEGER, n_user_utterances INTEGER,
  first_turn_no INTEGER, auth_state TEXT, journey_label TEXT,
  city TEXT, state TEXT, region TEXT, market TEXT, zip3 TEXT, geo_source TEXT, location_type TEXT,
  outcome TEXT, outcome_basis TEXT, split TEXT, run_id INTEGER);
CREATE INDEX IF NOT EXISTS ix_cs_thread ON conversation_session(thread_id, created_at);
CREATE INDEX IF NOT EXISTS ix_cs_prev ON conversation_session(previous_session_id);
CREATE INDEX IF NOT EXISTS ix_cs_city ON conversation_session(city);

CREATE TABLE IF NOT EXISTS conversation_turn(
  session_id TEXT, turn_no INTEGER, seq INTEGER, trace_id TEXT, ts TEXT, kind TEXT, event_type TEXT,
  event_value TEXT, user_text TEXT, agent_text TEXT, agent_role TEXT, roles TEXT, lang TEXT,
  PRIMARY KEY(session_id, seq)) WITHOUT ROWID;

-- execution --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_trace(
  trace_id TEXT PRIMARY KEY, session_id TEXT, turn_no INTEGER, seq INTEGER, created_at TEXT, status_code TEXT,
  is_complete TEXT, n_spans INTEGER);
CREATE INDEX IF NOT EXISTS ix_ct_sess ON conversation_trace(session_id);
CREATE TABLE IF NOT EXISTS trace_span(
  span_id TEXT, trace_id TEXT, session_id TEXT, parent_id TEXT, depth INTEGER, type TEXT, name TEXT, step_number TEXT);
CREATE INDEX IF NOT EXISTS ix_sp_trace ON trace_span(trace_id);
CREATE INDEX IF NOT EXISTS ix_sp_sess ON trace_span(session_id);
CREATE TABLE IF NOT EXISTS tool_call(
  session_id TEXT, seq INTEGER, trace_id TEXT, tool TEXT, agent_role TEXT, intent_name TEXT, query TEXT,
  requested_operator INTEGER, failed INTEGER, args TEXT);
CREATE INDEX IF NOT EXISTS ix_tc_sess ON tool_call(session_id, seq);

-- evaluation -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_evaluation(
  entity_type TEXT, entity_id TEXT, session_id TEXT, metric TEXT, canonical_metric TEXT, value REAL,
  value_text TEXT, scale TEXT, status TEXT, evaluator TEXT, rationale TEXT, scorer_version TEXT);
CREATE INDEX IF NOT EXISTS ix_ev_sess ON agent_evaluation(session_id, canonical_metric);
CREATE TABLE IF NOT EXISTS policy_verdict(
  session_id TEXT, journey TEXT, policy_id TEXT, verdict TEXT, severity TEXT, policy_type TEXT, evidence TEXT, reason TEXT);
CREATE INDEX IF NOT EXISTS ix_pv_sess ON policy_verdict(session_id);

-- taxonomy ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_intent(
  intent_id TEXT PRIMARY KEY, level INTEGER, parent_id TEXT, code TEXT, name TEXT, family TEXT,
  taxonomy_version TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS intent_definition(
  intent_id TEXT PRIMARY KEY, definition TEXT, include_criteria TEXT, exclude_criteria TEXT, examples TEXT,
  platform_intent_patterns TEXT, keyword_rules TEXT);
CREATE TABLE IF NOT EXISTS session_intent(
  session_id TEXT, intent_id TEXT, role TEXT, confidence REAL, method TEXT, taxonomy_version TEXT, evidence TEXT);
CREATE INDEX IF NOT EXISTS ix_si ON session_intent(intent_id, role);
CREATE INDEX IF NOT EXISTS ix_si_s ON session_intent(session_id, role);
CREATE INDEX IF NOT EXISTS ix_cs_src ON conversation_session(source);
CREATE TABLE IF NOT EXISTS turn_intent(
  session_id TEXT, seq INTEGER, intent_id TEXT, confidence REAL, method TEXT, evidence TEXT);
CREATE INDEX IF NOT EXISTS ix_ti ON turn_intent(session_id, seq);

-- signals / episodes / features ------------------------------------------
CREATE TABLE IF NOT EXISTS session_signal(
  signal_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, seq INTEGER, turn_no INTEGER, trace_id TEXT,
  family TEXT, category TEXT, type TEXT, value TEXT, text TEXT, confidence REAL, method TEXT,
  rule_version TEXT, ts TEXT, is_synthetic INTEGER);
CREATE INDEX IF NOT EXISTS ix_sig_sess ON session_signal(session_id, seq);
CREATE INDEX IF NOT EXISTS ix_sig_type ON session_signal(type);

CREATE TABLE IF NOT EXISTS session_episode(
  episode_id TEXT PRIMARY KEY, session_id TEXT, ep_no INTEGER, kind TEXT, start_seq INTEGER, end_seq INTEGER,
  intent_id TEXT, intent_conf REAL, domain_agent TEXT, platform_intent TEXT, text TEXT, n_user_turns INTEGER,
  outcome TEXT, outcome_basis TEXT, friction REAL, signal_types TEXT, boundary_reason TEXT);
CREATE INDEX IF NOT EXISTS ix_ep_sess ON session_episode(session_id);

CREATE TABLE IF NOT EXISTS need_journey(
  journey_id TEXT PRIMARY KEY, thread_id TEXT, intent_l2 TEXT, first_session TEXT, last_session TEXT,
  first_at TEXT, last_at TEXT, n_sessions INTEGER, n_episodes INTEGER, resolved INTEGER, last_outcome TEXT);

CREATE TABLE IF NOT EXISTS session_feature(
  session_id TEXT PRIMARY KEY, friction REAL, n_escalation_requests INTEGER, n_auth_failures INTEGER,
  n_no_input INTEGER, n_handoffs INTEGER, repeat_contact INTEGER, days_since_prev REAL, need_flag INTEGER,
  buying_flag INTEGER, value_flag INTEGER, risk_flag INTEGER, opp_flag INTEGER, segment TEXT, style TEXT);

-- persistent context ------------------------------------------------------
CREATE TABLE IF NOT EXISTS fact(
  fact_id INTEGER PRIMARY KEY AUTOINCREMENT, scope_type TEXT, scope_id TEXT, attribute TEXT, value TEXT,
  valid_from TEXT, valid_to TEXT, recorded_at TEXT, superseded_by INTEGER, source_session TEXT, source_seq INTEGER);
CREATE INDEX IF NOT EXISTS ix_fact ON fact(scope_type, scope_id, attribute, valid_from);

-- geography --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_geography(city TEXT PRIMARY KEY, state TEXT, region TEXT, market TEXT, lat REAL, lon REAL);


-- clusters (W3) ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cluster_master(
  cluster_id INTEGER PRIMARY KEY, stable_id INTEGER, family TEXT, version INTEGER, label TEXT, status TEXT DEFAULT 'draft',
  size INTEGER, sessions INTEGER, top_terms TEXT, top_intents TEXT, top_signals TEXT, profile TEXT, stability REAL, silhouette REAL,
  esc_rate REAL, abandon_rate REAL, published INTEGER, centroid BLOB, run_id INTEGER);
CREATE TABLE IF NOT EXISTS session_cluster_membership(
  object_type TEXT, object_id TEXT, session_id TEXT, cluster_id INTEGER, family TEXT, similarity REAL, run_id INTEGER);
CREATE INDEX IF NOT EXISTS ix_scm_c ON session_cluster_membership(cluster_id);
CREATE INDEX IF NOT EXISTS ix_scm_s ON session_cluster_membership(session_id);
CREATE TABLE IF NOT EXISTS taxonomy_candidate(
  candidate_id TEXT PRIMARY KEY, parent_intent TEXT, kind TEXT, label TEXT, top_terms TEXT, size INTEGER, examples TEXT,
  proposed_by TEXT, status TEXT DEFAULT 'draft', run_id INTEGER);

-- patterns / scoring / cards / facts (W3-W4) -------------------------------
CREATE TABLE IF NOT EXISTS agg_daily_intent(
  day TEXT, week TEXT, intent_id TEXT, city TEXT, region TEXT, segment TEXT, outcome TEXT, source TEXT,
  sessions INTEGER, opp INTEGER, willing INTEGER, repeat7 INTEGER);
CREATE INDEX IF NOT EXISTS ix_adi ON agg_daily_intent(intent_id, city);
CREATE TABLE IF NOT EXISTS pattern_master(
  pattern_id INTEGER PRIMARY KEY AUTOINCREMENT, pattern_key TEXT, kind TEXT, family TEXT, subject_type TEXT, subject TEXT,
  subject_label TEXT, dim_type TEXT, dim_value TEXT, metric TEXT, period TEXT, support INTEGER, denominator INTEGER,
  rate REAL, baseline REAL, lift REAL, lift_shrunk REAL, ci_lo REAL, ci_hi REAL, pval REAL, qval REAL,
  trend REAL, recent_rate REAL, prior_rate REAL, coverage REAL, extra TEXT, version TEXT, run_id INTEGER);
CREATE INDEX IF NOT EXISTS ix_pm_key ON pattern_master(pattern_key);
CREATE TABLE IF NOT EXISTS pattern_score(pattern_id INTEGER, dimension TEXT, value REAL, method TEXT, scoring_version TEXT);
CREATE INDEX IF NOT EXISTS ix_ps ON pattern_score(pattern_id);
CREATE TABLE IF NOT EXISTS evidence_card(
  card_id INTEGER PRIMARY KEY AUTOINCREMENT, pattern_key TEXT, pattern_id INTEGER, version INTEGER, family TEXT, kind TEXT,
  title TEXT, observation TEXT, population TEXT, period TEXT, scope TEXT, trend TEXT, confidence TEXT, hypothesis TEXT,
  action TEXT, kpi TEXT, caveats TEXT, scores TEXT, composite REAL, metrics TEXT, data_origin TEXT, governance TEXT,
  status TEXT DEFAULT 'draft', reviewer TEXT, review_note TEXT, reviewed_at TEXT,
  valid_from TEXT, valid_to TEXT, superseded_by INTEGER, run_id INTEGER);
CREATE INDEX IF NOT EXISTS ix_ec_key ON evidence_card(pattern_key, valid_to);
CREATE TABLE IF NOT EXISTS evidence_ref(card_id INTEGER, session_id TEXT, seq INTEGER, turn_no INTEGER, trace_id TEXT, quote TEXT, source TEXT);
CREATE INDEX IF NOT EXISTS ix_er ON evidence_ref(card_id);
CREATE TABLE IF NOT EXISTS llm_cache(key TEXT PRIMARY KEY, use TEXT, model TEXT, prompt_version TEXT, request TEXT, response TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, at TEXT);
CREATE TABLE IF NOT EXISTS llm_label(object_type TEXT, object_id TEXT, use TEXT, label TEXT, evidence TEXT, grounded INTEGER,
  agrees_with_rules INTEGER, status TEXT, model TEXT, prompt_version TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS processed_day(source TEXT, day TEXT, file TEXT, sha256 TEXT, sessions INTEGER, finished_at TEXT, PRIMARY KEY(source, file));
CREATE TABLE IF NOT EXISTS search_doc(doc_id INTEGER PRIMARY KEY, doc_type TEXT, ref_id TEXT, session_id TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
"""

# tables a full rebuild clears (dimension/governance tables are kept)
DERIVED = ["raw_trace_session", "conversation_session", "conversation_turn", "conversation_trace", "trace_span",
           "tool_call", "agent_evaluation", "policy_verdict", "session_intent", "turn_intent", "session_signal",
           "session_episode", "need_journey", "session_feature", "fact", "data_provenance", "ingest_reject",
           "session_cluster_membership", "taxonomy_candidate", "agg_daily_intent", "pattern_master", "pattern_score",
           "evidence_ref", "llm_label", "processed_day", "search_doc"]


def connect(path=None, readonly=False):
    path = path or DB_PATH
    DATA.mkdir(parents=True, exist_ok=True)
    if readonly:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    else:
        con = sqlite3.connect(path, check_same_thread=False)
        con.execute("PRAGMA journal_mode=WAL")
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA cache_size=-131072")
    return con


def init(con):
    con.executescript(SCHEMA)
    con.commit()


@contextmanager
def stage(con, name, versions):
    """Record a pipeline stage in processing_run; yields a dict the stage fills with stats."""
    import json, datetime as dt
    now = lambda: dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    cur = con.execute("INSERT INTO processing_run(stage,started_at,status,versions) VALUES(?,?,?,?)",
                      (name, now(), "running", json.dumps(versions)))
    run_id, stats = cur.lastrowid, {}
    con.commit()
    try:
        yield run_id, stats
        con.execute("UPDATE processing_run SET finished_at=?,status='ok',stats=? WHERE run_id=?", (now(), json.dumps(stats), run_id))
    except Exception as e:
        con.rollback()
        con.execute("UPDATE processing_run SET finished_at=?,status='failed',error=? WHERE run_id=?", (now(), repr(e)[:2000], run_id))
        raise
    finally:
        con.commit()
