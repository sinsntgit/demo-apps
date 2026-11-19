"""Central configuration. All thresholds, paths and versions live here (AGENTS.md §4)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
LANDING = ROOT / "landing"
REPORTS = ROOT / "reports"
DOCS = ROOT / "docs"
UI_DIR = ROOT / "ui"
TAXONOMY_DIR = ROOT / "taxonomy"
SAMPLE = ROOT / "sample" / "verizon_traces_example.jsonl"           # git-ignored real sample
SAMPLE_LOCATED = DATA / "verizon_sample_located.jsonl"                # git-ignored, assumed locations
FIXTURES = ROOT / "samples" / "scenario_fixtures.jsonl"               # small synthetic fixture set (committed)
FIXTURES_TRUTH = ROOT / "samples" / "scenario_fixtures_truth.json"    # truth for fixtures (pipeline never reads)
DB_PATH = DATA / "cie.sqlite"

# ---- versions (stamped on every derived row through processing_run) ------
VERSIONS = {
    "schema": "1.0.0",
    "rules": "0.3.0",            # lexicon + platform-intent map
    "taxonomy": "v0-draft",
    "episode_model": "1.0.0",
    "fixtures": "1.0.0",
}

# ---- location contract (AGENTS.md §2.7) ---------------------------------
# Tried in order; first hit wins. Dotted paths are relative to the session record.
LOCATION_PATHS = [
    ("flat", "user_metadata", "svc_"),            # user_metadata.svc_city / svc_state / svc_zip3 / svc_market / svc_region
    ("nested", "user_metadata.location", ""),     # user_metadata.location.{city,state,zip,market,region}
    ("trace_flat", "traces[0].user_metadata", "svc_"),
    ("tags", "tags", "svc_"),                     # ["svc_state:FL", ...]
]
LOCATION_TYPE_DEFAULT = "service"

# ---- governance ---------------------------------------------------------
K_ANON = 30           # minimum sessions in any published cell (population)
MIN_SUPPORT = 10      # minimum supporting sessions behind a pattern
FDR_Q = 0.01
MIN_LIFT = 1.30
MIN_STABILITY = 0.60
SHRINK_M = 40

# ---- signals / episodes --------------------------------------------------
AGENT_LOOP_JACCARD = 0.80
CUSTOMER_REPEAT_JACCARD = 0.70
NO_INPUT_ABANDON = 2
JOURNEY_WINDOW_DAYS = 30
INTENT_HOLD_TURNS = 2
MIN_INTENT_CONF = 0.45

# ---- LLM policy (AGENTS.md §2.6) -----------------------------------------
LLM_ENABLED = False                  # turned on once an API key is configured
LLM_MODELS = {"adjudicate": "claude-haiku-5-5", "discover": "claude-sonnet-5-5", "gold": "claude-sonnet-5-5"}
LLM_BAND = (0.35, 0.65)
LLM_MAX_SHARE = 0.05
LLM_MAX_USD_PER_RUN = 25.0

# ---- behavioural segments (rule-scored; ties broken by list order) --------
SEGMENT_RULES = [
    ("Churn-risk", {"churn_intent": 3, "repeat_same_issue": 1.5, "complaint": 1, "frustration": .5}),
    ("Deal-seeker", {"price_sensitivity": 2, "feature_comparison": .5}),
    ("Household expander", {"add_line": 2, "multi_line_expansion": 2}),
    ("Upgrade intender", {"upgrade_device": 2, "device_replacement": 1.5, "willingness": .5}),
    ("Traveler", {"travel_intl": 2}),
    ("Connectivity-dependent", {"hotspot_home_internet": 2, "coverage_availability": 1.5}),
    ("Billing-focused", {"billing_clarification": 1, "payment_issue": 1, "refund_credit": 1, "dispute": 1, "payment_difficulty": 1}),
    ("Access-blocked", {"auth_failure": 1.5, "account_access": 1}),
]
SEGMENT_MIN_SCORE = 1.0
FRICTION_WEIGHTS = {"escalation_request": 1.0, "auth_failure": 1.0, "dtmf_operator": .7, "agent_loop": .7, "customer_repeat": .7,
                    "tool_failure": .8, "no_input": .5, "confusion": .5, "frustration": .8, "out_of_scope": .3}
FRICTION_SCALE = 4.0
NEW_NEED_CUE = r"^\s*(also|and also|one more thing|another (question|thing)|while i have you|oh and)\b"

# ---- clustering / discovery (W3) -----------------------------------------
MODELS = DATA / "models"
NEED_EXTRA = (0, 2, 4, 6)          # need-cluster k = number of taxonomy intents with >= NEED_MIN_EPISODES episodes + one of these
NEED_MIN_EPISODES = 100
RISK_K = (4, 5, 6)
VALUE_K = (4, 5, 6)
GEO_K = (4, 5, 6)
NOVELTY_COS = 0.35
L4_MIN_EPISODES = 300
CLUSTER_SEED = 11
SVD_DIM = 96
N_BOOT = 4

# ---- patterns / scoring / cards (W3-W4) -----------------------------------
RECENT_WEEKS, PRIOR_WEEKS = 2, 6
EMERGING_MIN_RATIO = 1.8
REPEAT_WINDOW_DAYS = 7
FAMILY_RELEVANCE = {"risk": .9, "buying": .85, "value": .8, "friction": .7, "need": .55, "geo": .6, "temporal": .75}
SCORE_WEIGHTS = {"prevalence": .15, "recurrence": .10, "trend": .15, "evidence_strength": .25, "business_relevance": .20, "geo_concentration": .15}
SCORING_VERSION = "1.0.0-provisional"
MAX_CARDS = 60
MAX_CARDS_PER_SUBJECT = 3
# segments are built from these intents' own signals -> an intent x its defining segment is definitional, not an insight
SEGMENT_DEFINES = {"Household expander": ("ADDSVC.LINE.ADD",), "Upgrade intender": ("DEVICE.UPGRADE", "DEVICE.REPLACE"),
                   "Traveler": ("ADDSVC.TRAVEL",), "Connectivity-dependent": ("ADDSVC.CONNECT", "SERVICE.CONNECTIVITY"),
                   "Churn-risk": ("RETENTION.",), "Deal-seeker": ("PLAN.CHANGE", "PLAN.DISCOUNT"),
                   "Billing-focused": ("BILL.", "PAY.", "REFUND."), "Access-blocked": ("ACCT.",)}
CARD_KIND_CAPS = {"segment_mix": 5, "risk_rate:down": 2, "risk_rate:up": 8, "emerging": 6, "sequence": 6, "opportunity": 4}
