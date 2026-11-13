#!/usr/bin/env bash
# Browser checks. Each suite runs against a brand-new, empty instance on port 8010 with a
# stand-in AI model (tests/fake_llm.py, port 8765) and a local mail sink (port 2525).
#
#   tests/e2e/run.sh              run every suite
#   tests/e2e/run.sh reports      run one suite (features | reports | groups | predictive | session)
#
# Needs Node with Playwright + Chromium, and the Python dev requirements.
# Screenshots land in $OUT (default: a temp dir, printed at the end). The Help page's images
# in static/help/img are these screenshots, copied across by name when a screen changes.
set -u
cd "$(dirname "$0")/../.."
OUT="${OUT:-$(mktemp -d)}"; WORK="$(mktemp -d)"; mkdir -p "$OUT/img"
cleanup() { pkill -f "uvicorn app.main:app --port 8010" 2>/dev/null; pkill -f "tests.fake_llm" 2>/dev/null; pkill -f "tests/e2e/smtp_sink.py" 2>/dev/null; }
trap cleanup EXIT
cleanup; sleep 1
python3 -m tests.fake_llm > "$WORK/fake.log" 2>&1 &
python3 tests/e2e/smtp_sink.py "$WORK/mail.jsonl" > "$WORK/smtp.log" 2>&1 &

fresh() {   # a new empty app instance
  pkill -f "uvicorn app.main:app --port 8010" 2>/dev/null; sleep 1
  rm -rf "$WORK/data"; : > "$WORK/mail.jsonl"
  T2S_DATA_DIR="$WORK/data" T2S_ADMIN_EMAIL=admin@example.com T2S_ADMIN_PASSWORD='Admin-Passw0rd!' \
    python3 -m uvicorn app.main:app --port 8010 > "$WORK/app.log" 2>&1 &
  for _ in $(seq 40); do curl -sf localhost:8010/api/health > /dev/null && return; sleep 0.25; done
  echo "app did not start - see $WORK/app.log"; exit 1
}

fail=0
suite() {
  echo "== $1"; fresh
  local log; log="$(timeout 150 node "tests/e2e/$1.js" "${@:2}" 2>&1)"; echo "$log"
  echo "$log" | grep -q "^FAIL" && fail=1
  echo "$log" | grep -q "^console errors: none" || { [ "$1" = session ] || fail=1; }
  grep -q Traceback "$WORK/app.log" && { echo "server traceback - see $WORK/app.log"; fail=1; }
}
want="${1:-all}"
[ "$want" = all ] || [ "$want" = features ] && suite features "$OUT/img" "$WORK/data/text2sql.db"
[ "$want" = all ] || [ "$want" = reports ]  && suite reports "$OUT" "$WORK/mail.jsonl"
[ "$want" = all ] || [ "$want" = groups ]   && suite groups "$OUT"
[ "$want" = all ] || [ "$want" = predictive ] && suite predictive "$OUT"
[ "$want" = all ] || [ "$want" = session ]  && suite session
echo; echo "screenshots: $OUT"
[ $fail = 0 ] && echo "ALL BROWSER CHECKS PASSED" || { echo "SOME BROWSER CHECKS FAILED"; exit 1; }
