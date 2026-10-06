#!/usr/bin/env bash
# Remote-LATAM scan: free remote-job boards (feeds/APIs) -> data/pipeline.md. Zero LLM tokens;
# it only fills the queue and never runs /career-ops pipeline. Catalog: remote-latam.yml
# (copy templates/remote-latam.example.yml); audit of each source: docs/REMOTE-LATAM-SOURCES.md.
#
# Standalone on purpose: it does not call the Gupy import or scan.mjs. Cron runs it at 07:20
# (own crontab line, log logs/remote-latam-cron.log; see docs/RUNBOOK-pipeline-diario.md section 4).
#
#   scripts/run-remote-latam-scan.sh --dry-run         # funnel per source, nothing written
#   scripts/run-remote-latam-scan.sh                    # write new rows (window: $JOBAGE, default 3)
#   JOBAGE=7 scripts/run-remote-latam-scan.sh           # widen the window for one run
#   scripts/run-remote-latam-scan.sh --source getonbrd  # one source (even a disabled one)
#   DRY_RUN=1 scripts/run-remote-latam-scan.sh          # same as --dry-run
# Other flags (--verify, --limit N, --json, --catalog FILE) go straight to the scanner.
# The window is JOBAGE, not --since: passing --since here is rejected as a duplicate flag.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
mkdir -p logs

# One run at a time (a slow --verify must not overlap the next start).
exec 9>logs/.remote-latam-scan.lock
flock -n 9 || { echo "$(date -Is) remote-latam-scan already running, skipping"; exit 0; }

. scripts/import-config.sh

DRY=()
[ "${DRY_RUN:-0}" = 1 ] && DRY=(--dry-run)

echo "=== $(date -Is) remote-latam-scan start${DRY[*]:+ (dry run)} ==="
node scripts/scan-remote-latam.mjs --since "$JOBAGE" ${DRY[@]+"${DRY[@]}"} "$@"
rc=$?
echo "=== $(date -Is) remote-latam-scan done (exit=$rc) ==="
exit "$rc"
