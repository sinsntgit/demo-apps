"""One-command launcher (macOS, Linux, Windows):  python run_all.py [--sessions 100000] [--port 8080] [--skip-build]

1. generates the synthetic population if it is missing,
2. builds every pipeline stage,
3. runs validation,
4. starts the UI at http://127.0.0.1:<port>.
"""
import argparse, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def step(title, args):
    print(f"\n=== {title} ===", flush=True)
    r = subprocess.run([sys.executable, "-m", *args], cwd=ROOT)
    if r.returncode:
        sys.exit(f"step failed: {title} (exit {r.returncode})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", type=int, default=100_000, help="synthetic sessions to generate (100000 for the full POC)")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--skip-build", action="store_true", help="only start the UI on an existing database")
    a = ap.parse_args()
    if sys.version_info < (3, 11):
        sys.exit("Python 3.11 or newer is required")
    if not a.skip_build:
        synth = ROOT / "data" / "synthetic_traces.jsonl.gz"
        if not synth.exists():
            step(f"Generating {a.sessions:,} synthetic sessions", ["cie.synth", "--sessions", str(a.sessions)])
        step("Building the pipeline (about 5 minutes for 100K sessions)", ["cie.run_pipeline", "--rebuild", "--reset-cards"])
        step("Validating", ["cie.validate"])
    print(f"\n=== Starting the UI: open http://127.0.0.1:{a.port}  (Ctrl+C to stop) ===", flush=True)
    subprocess.run([sys.executable, "-m", "cie.server", "--port", str(a.port)], cwd=ROOT)


if __name__ == "__main__":
    main()
