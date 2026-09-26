#!/usr/bin/env bash
# Manual scan: LinkedIn + Vagas.com, queued into data/pipeline.md. Run it by hand, do not
# schedule it. LinkedIn's ToS forbids automated access and Vagas.com's robots.txt blocks
# Anthropic crawlers; both skills are for personal use at low volume (~30 requests here).
#
# Only postings from the last $JOBAGE days (default 3, scripts/import-config.sh) are queued;
# older ones are discarded and counted in logs/import-age.tsv.
#   scripts/run-manual-scan.sh --dry-run      # funnel only, nothing written
#   JOBAGE=7 scripts/run-manual-scan.sh       # widen the window for one run
# (Other flags go to both imports; --jobage itself is rejected as a duplicate, use JOBAGE.)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
. scripts/import-config.sh

echo "=== $(date -Is) manual-scan start ==="
echo "Personal use only: LinkedIn ToS / Vagas.com robots.txt. Keep volume low."

echo; echo "--- linkedin"
node scripts/import-jobs.mjs --source linkedin --pages 1 --remote remote,hybrid \
  --city "$CITY" --keep-anywhere "$KEEP_ANYWHERE" --include "$INCLUDE" --exclude "$EXCLUDE" \
  --jobage "$JOBAGE" "$@" "${QUERIES[@]}"
li_rc=$?

echo; echo "--- vagas.com"
node scripts/import-jobs.mjs --source vagas --pages 1 \
  --city "$CITY" --keep-anywhere "$KEEP_ANYWHERE" --include "$INCLUDE" --exclude "$EXCLUDE" \
  --jobage "$JOBAGE" "$@" "${QUERIES[@]}"
vg_rc=$?

echo; echo "=== $(date -Is) manual-scan done (linkedin=$li_rc vagas=$vg_rc) ==="
echo "Queue only: run /career-ops pipeline yourself."
[ "$li_rc" -eq 0 ] && [ "$vg_rc" -eq 0 ]
