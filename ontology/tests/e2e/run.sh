#!/usr/bin/env bash
# Browser check. Runs against a brand-new, empty instance on port 8020 with a stand-in AI model
# (tests/fake_llm.py, port 8765).
#
#   tests/e2e/run.sh            run the suite
#
# Needs Node with Playwright + Chromium, and the Python dev requirements.
# Screenshots land in $OUT (default: a temp dir, printed at the end). The Help page's images in
# static/help/img are these screenshots, copied across by name when a screen changes.
set -u
cd "$(dirname "$0")/../.."
OUT="${OUT:-$(mktemp -d)}"; WORK="$(mktemp -d)"; mkdir -p "$OUT"
cleanup() { pkill -f "uvicorn app.main:app --port 8020" 2>/dev/null; pkill -f "tests.fake_llm" 2>/dev/null; }
trap cleanup EXIT
cleanup; sleep 1
python3 -m tests.fake_llm > "$WORK/fake.log" 2>&1 &
ONTO_DATA_DIR="$WORK/data" ONTO_ADMIN_EMAIL=admin@example.com ONTO_ADMIN_PASSWORD='Admin-Passw0rd!' \
  python3 -m uvicorn app.main:app --port 8020 > "$WORK/app.log" 2>&1 &
for _ in $(seq 60); do curl -sf localhost:8020/api/health > /dev/null && break; sleep 0.25; done
curl -sf localhost:8020/api/health > /dev/null || { echo "app did not start - see $WORK/app.log"; cat "$WORK/app.log"; exit 1; }

fail=0
log="$(timeout 280 node tests/e2e/features.js "$OUT" 2>&1)"; echo "$log"
echo "$log" | grep -q "^FAIL" && fail=1
echo "$log" | grep -q "^console errors: none" || fail=1
grep -q Traceback "$WORK/app.log" && { echo "server traceback:"; grep -B2 -A12 Traceback "$WORK/app.log" | head -60; fail=1; }
echo; echo "screenshots: $OUT"
[ $fail = 0 ] && echo "ALL BROWSER CHECKS PASSED" || { echo "SOME BROWSER CHECKS FAILED"; exit 1; }
