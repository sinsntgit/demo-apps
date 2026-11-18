"""One-command launcher (macOS, Linux, Windows):  python run_all.py [--sessions 100000] [--port 8080] [--skip-build]

First run: generates the synthetic population (once), builds every stage, validates, starts the UI.
Later runs: start the UI straight away on the existing database (reviews are kept).

  python run_all.py                    # first time: build + validate + UI; afterwards: UI only
  python run_all.py --rebuild          # rebuild the database (keeps card/cluster reviews)
  python run_all.py --rebuild --reset  # rebuild from scratch, dropping review history
  python run_all.py --regenerate       # also regenerate the synthetic file (same seed = same data)
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
    ap.add_argument("--skip-build", action="store_true", help="only start the UI (default once a database exists)")
    ap.add_argument("--rebuild", action="store_true", help="rebuild the database even if one exists")
    ap.add_argument("--reset", action="store_true", help="with --rebuild: also drop card/cluster review history")
    ap.add_argument("--regenerate", action="store_true", help="regenerate the synthetic file even if it exists")
    a = ap.parse_args()
    if sys.version_info < (3, 11):
        sys.exit("Python 3.11 or newer is required")
    db_exists = (ROOT / "data" / "cie.sqlite").exists()
    build = not a.skip_build and (a.rebuild or a.regenerate or not db_exists)
    if not build and db_exists:
        print("Database found: starting the UI on the existing build (use --rebuild to rebuild).", flush=True)
    if build:
        synth = ROOT / "data" / "synthetic_traces.jsonl.gz"
        if a.regenerate or not synth.exists():
            step(f"Generating {a.sessions:,} synthetic sessions", ["cie.synth", "--sessions", str(a.sessions)])
        else:
            print(f"Synthetic file found ({synth.name}): reusing it.", flush=True)
        args = ["cie.run_pipeline", "--rebuild"] + (["--reset-cards"] if a.reset or not db_exists else [])
        step("Building the pipeline (about 5 minutes for 100K sessions; longer on Windows)", args)
        step("Validating", ["cie.validate"])
    print(f"\n=== Starting the UI: open http://127.0.0.1:{a.port}  (Ctrl+C to stop) ===", flush=True)
    subprocess.run([sys.executable, "-m", "cie.server", "--port", str(a.port)], cwd=ROOT)


if __name__ == "__main__":
    main()
