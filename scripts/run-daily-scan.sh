#!/usr/bin/env bash
# Daily unattended scan, meant for cron (see docs/AUTOMATION.md). Zero LLM tokens; it only
# fills data/pipeline.md and never runs /career-ops pipeline.
#
#   1. Gupy: cards posted in the last $JOBAGE days (default 3, scripts/import-config.sh),
#      dead links dropped, new ones appended. Age discards are logged in logs/import-age.tsv.
#   2. node scan.mjs --verify --since $JOBAGE: the portals.yml boards (this is the only
#      thing --verify covers; step 1 does its own liveness check).
#   3. Pending sorted newest-first by `posted:` (import-jobs.mjs --sort-only).
#
# LinkedIn and Vagas.com are NOT here (ToS / robots.txt): run scripts/run-manual-scan.sh.
# DRY_RUN=1 scripts/run-daily-scan.sh   → same run, nothing written.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
mkdir -p logs

# One run at a time: a slow verify must not overlap tomorrow's start.
exec 9>logs/.daily-scan.lock
flock -n 9 || { echo "$(date -Is) daily-scan already running, skipping"; exit 0; }

. scripts/import-config.sh

DRY=()
[ "${DRY_RUN:-0}" = 1 ] && DRY=(--dry-run)

echo "=== $(date -Is) daily-scan start${DRY[*]:+ (dry run)} ==="

node scripts/import-jobs.mjs --source gupy --pages 3 --remote remote,hybrid,onsite \
  --jobage "$JOBAGE" --verify --city "$CITY" --keep-anywhere "$KEEP_ANYWHERE" --exclude "$EXCLUDE" \
  ${DRY[@]+"${DRY[@]}"} "${QUERIES[@]}"
import_rc=$?
echo "--- gupy import exit=$import_rc"

# --since: same freshness window as the import (scan.mjs counts what it drops in
# data/scan-runs.tsv). No --headed-fallback: cron has no display.
node scan.mjs --verify --throttle --since "$JOBAGE" ${DRY[@]+"${DRY[@]}"}
scan_rc=$?

# scan.mjs appends its rows at the end of Pending: sort last so the newest posting is
# always on top (the import sorts too, but it ran before the scan).
node scripts/import-jobs.mjs --sort-only ${DRY[@]+"${DRY[@]}"}
sort_rc=$?

echo "=== $(date -Is) daily-scan done (import=$import_rc scan=$scan_rc sort=$sort_rc) ==="
[ "$import_rc" -eq 0 ] && [ "$scan_rc" -eq 0 ] && [ "$sort_rc" -eq 0 ]
