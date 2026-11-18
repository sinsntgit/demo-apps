"""SQLite schema + connection helpers.

SQLite is a sound fit for Phase-1 scale: 100K sessions x ~7 traces = ~700K turn rows (we store one
normalised row per trace, not the raw 19 MB-per-36-session JSON), ~200K episodes, a few million
signal rows. All hot paths are indexed; FTS5 provides BM25. Single-writer batch pipeline + many
concurrent readers (WAL) is exactly SQLite's sweet spot.
"""
import sqlite3
from contextlib import contextmanager
from .config import DB_PATH, DATA

SCHEMA = """
CREATE TABLE IF NOT EXISTS ingest_runs(
  run_id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, file TEXT, started_at TEXT, finished_at TEXT,
  sessions INTEGER, turns INTEGER, rejected INTEGER, pii_scrubbed INTEGER, notes TEXT);
CREATE TABLE IF NOT EXISTS rejects(run_id INTEGER, line_no INTEGER, reason TEXT, snippet TEXT);

CREATE TABLE IF NOT EXISTS sessions(
  session_id TEXT PRIMARY KEY, external_id TEXT, source TEXT, created_at TEXT, day TEXT, week TEXT,
  previous_session_id TEXT, thread_id TEXT, thread_pos INTEGER DEFAULT 0,
  n_turns INTEGER, n_user_turns INTEGER, journey TEXT, auth_state TEXT,
  quality REAL, success REAL, efficiency REAL, flow REAL, avg_latency REAL, compliance REAL,
  -- derived downstream
  segment TEXT, style TEXT, city TEXT, state TEXT, region TEXT, geo_conf REAL,
  outcome TEXT, friction REAL, primary_intent TEXT, opp_flag INTEGER DEFAULT 0, need_flag INTEGER DEFAULT 0,
  value_flag INTEGER DEFAULT 0, risk_flag INTEGER DEFAULT 0, escalated INTEGER DEFAULT 0,
  repeat_flag INTEGER DEFAULT 0, followup_7d INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_s_thread ON sessions(thread_id, created_at);
CREATE INDEX IF NOT EXISTS ix_s_prev ON sessions(previous_session_id);
CREATE INDEX IF NOT EXISTS ix_s_week ON sessions(week);
CREATE INDEX IF NOT EXISTS ix_s_city ON sessions(city);
CREATE INDEX IF NOT EXISTS ix_s_seg ON sessions(segment);

CREATE TABLE IF NOT EXISTS turns(
  session_id TEXT, turn_no INTEGER, ts TEXT, kind TEXT, event_type TEXT, event_value TEXT,
  user_text TEXT, agent_text TEXT, agent_role TEXT, roles TEXT, n_tools INTEGER,
  PRIMARY KEY(session_id, turn_no)) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tool_calls(
  session_id TEXT, turn_no INTEGER, tool TEXT, intent_name TEXT, query TEXT, requested_operator INTEGER);
CREATE INDEX IF NOT EXISTS ix_t_sess ON tool_calls(session_id, turn_no);

CREATE TABLE IF NOT EXISTS signals(
  session_id TEXT, turn_no INTEGER, family TEXT, type TEXT, value TEXT, evidence TEXT, conf REAL, source TEXT);
CREATE INDEX IF NOT EXISTS ix_sig_sess ON signals(session_id, turn_no);
CREATE INDEX IF NOT EXISTS ix_sig_type ON signals(type);

CREATE TABLE IF NOT EXISTS episodes(
  episode_id INTEGER PRIMARY KEY, session_id TEXT, ep_no INTEGER, kind TEXT, start_turn INTEGER, end_turn INTEGER,
  domain_agent TEXT, platform_intent TEXT, text TEXT, n_user_turns INTEGER, outcome TEXT, friction REAL,
  signal_types TEXT, family_mask TEXT, tools TEXT, week TEXT, day TEXT, city TEXT, region TEXT, segment TEXT,
  auth_state TEXT, cluster_id INTEGER, source TEXT);
CREATE INDEX IF NOT EXISTS ix_e_sess ON episodes(session_id);
CREATE INDEX IF NOT EXISTS ix_e_cluster ON episodes(cluster_id);
CREATE INDEX IF NOT EXISTS ix_e_city ON episodes(city, cluster_id);

CREATE TABLE IF NOT EXISTS clusters(
  cluster_id INTEGER PRIMARY KEY, run_id INTEGER, label TEXT, family TEXT, size INTEGER, top_terms TEXT,
  top_signals TEXT, stability REAL, published INTEGER, silhouette REAL, esc_rate REAL, resolve_rate REAL,
  centroid BLOB);

CREATE TABLE IF NOT EXISTS patterns(
  pattern_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, kind TEXT, family TEXT, cluster_id INTEGER,
  cluster_label TEXT, dim_type TEXT, dim_value TEXT, metric TEXT, support INTEGER, n_cell INTEGER,
  rate REAL, baseline REAL, lift REAL, lift_shrunk REAL, ci_lo REAL, ci_hi REAL, pval REAL, qval REAL,
  trend REAL, recent_rate REAL, prior_rate REAL, score REAL, tier TEXT, kpi TEXT, extra TEXT);
CREATE INDEX IF NOT EXISTS ix_p_score ON patterns(score DESC);

CREATE TABLE IF NOT EXISTS evidence_cards(
  card_id INTEGER PRIMARY KEY AUTOINCREMENT, pattern_id INTEGER, run_id INTEGER, version INTEGER DEFAULT 1,
  family TEXT, kind TEXT, title TEXT, headline TEXT, kpi TEXT, hypothesis TEXT, action TEXT, caveats TEXT,
  scope_city TEXT, scope_segment TEXT, scope_region TEXT, cluster_id INTEGER,
  score REAL, tier TEXT, metrics_json TEXT, evidence_json TEXT, data_origin TEXT,
  status TEXT DEFAULT 'draft', reviewer TEXT, review_note TEXT, reviewed_at TEXT,
  valid_from TEXT, valid_to TEXT, superseded_by INTEGER, created_at TEXT);
CREATE INDEX IF NOT EXISTS ix_c_status ON evidence_cards(status, score DESC);

-- persistent context: facts keep the date they were true; superseded facts stay on record
CREATE TABLE IF NOT EXISTS facts(
  fact_id INTEGER PRIMARY KEY AUTOINCREMENT, scope_type TEXT, scope_id TEXT, attribute TEXT, value TEXT,
  valid_from TEXT, valid_to TEXT, recorded_at TEXT, superseded_by INTEGER, source_session TEXT, source_turn INTEGER);
CREATE INDEX IF NOT EXISTS ix_f_scope ON facts(scope_type, scope_id, attribute, valid_from);

CREATE TABLE IF NOT EXISTS pipeline_runs(
  run_id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, finished_at TEXT, stage TEXT, seconds REAL, detail TEXT);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(text, content='', tokenize='porter unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(title, headline, content='', tokenize='porter unicode61');
"""


def connect(path=None, readonly=False, bulk=False):
    path = path or DB_PATH
    DATA.mkdir(parents=True, exist_ok=True)
    if readonly:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    else:
        con = sqlite3.connect(path, check_same_thread=False)
        con.execute("PRAGMA journal_mode=WAL")
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA cache_size=-262144")
    con.execute("PRAGMA temp_store=MEMORY")
    if bulk:
        con.execute("PRAGMA synchronous=OFF")
    return con


def init(con):
    con.executescript(SCHEMA)
    con.commit()


@contextmanager
def tx(con):
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise


def kv_set(con, k, v):
    con.execute("INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)", (k, v))


def kv_get(con, k, default=None):
    r = con.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
    return r[0] if r else default
