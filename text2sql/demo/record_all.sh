#!/usr/bin/env bash
# Record every chapter from a freshly restored demo state (each chapter starts from the snapshot).
cd "$(dirname "$0")/.."
for c in demo/chapters/c*.js; do
  n=$(basename "$c" .js)
  demo/reset.sh >/dev/null 2>&1
  node demo/record.js "$n" 2>&1 | grep -v "^recording"
done
echo ALL DONE
