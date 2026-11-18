"""Central configuration: paths, governance thresholds, scoring weights."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
REPORTS = ROOT / "reports"
UI_DIR = ROOT / "ui"
SAMPLE = ROOT / "sample" / "verizon_traces_example.jsonl"
DB_PATH = DATA / "cie.sqlite"
SYNTH_PATH = DATA / "synthetic_traces.jsonl.gz"
GT_PATH = DATA / "synthetic_ground_truth.json.gz"   # never read by the pipeline, only by validate.py

# ---- governance ---------------------------------------------------------
K_ANON = 30            # minimum distinct sessions behind any published pattern / cell
FDR_Q = 0.01           # Benjamini-Hochberg q-value for pattern significance
MIN_LIFT = 1.30        # minimum (shrunk) lift for a segment/geo pattern
MIN_STABILITY = 0.60   # minimum bootstrap stability for a cluster to be published
SHRINK_M = 40          # Beta-binomial prior strength (pseudo-sessions) for rate shrinkage

# ---- clustering ---------------------------------------------------------
K_CANDIDATES = (14, 18, 22, 26)
SVD_DIM = 96
N_BOOT = 4

# ---- scoring (0-100) ----------------------------------------------------
W_EFFECT, W_SUPPORT, W_SIG, W_TREND = 0.35, 0.25, 0.25, 0.15
MAX_CARDS = 80

SIGNAL_FAMILIES = ("need", "risk", "value", "geo")
