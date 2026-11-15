#!/usr/bin/env bash
# Fresh stack + seed + snapshot of the seeded state (about 2 minutes). Run once; then use reset.sh between takes.
set -eu
cd "$(dirname "$0")/.."
demo/stack.sh start
python3 demo/seed.py 2>&1 | grep -v Deprecat | grep -v "now = dt"
pkill -f "uvicorn app.main:app --port 8010"; sleep 2
rm -rf demo/out/data.seed; cp -a demo/out/data demo/out/data.seed
demo/reset.sh
