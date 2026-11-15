#!/usr/bin/env bash
# Restore the seeded demo state (taken by prepare.sh) and restart the app. Takes a few seconds.
set -u
cd "$(dirname "$0")/.."
OUT="$PWD/demo/out"
pkill -f "uvicorn app.main:app --port 8010" 2>/dev/null; sleep 1
rm -rf "$OUT/data"; cp -a "$OUT/data.seed" "$OUT/data"; : > "$OUT/mail.jsonl"
T2S_DATA_DIR="$OUT/data" T2S_ADMIN_EMAIL=admin@acme.example T2S_ADMIN_PASSWORD='Demo-Passw0rd!' T2S_SCHEDULER=0 \
  nohup python3 -m uvicorn app.main:app --port 8010 > "$OUT/app.log" 2>&1 &
for _ in $(seq 60); do curl -sf localhost:8010/api/health >/dev/null && { echo "demo state restored"; exit 0; }; sleep 0.5; done
echo "app did not start"; exit 1
