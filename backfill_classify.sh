#!/bin/bash
# Backfill category + tags through Cloudflare Workers AI + AI Gateway.
# Safe to re-run; skips classified rows unless --force is supplied.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cf_access.sh"

set -uo pipefail
cd "$(dirname "$0")"

DASHBOARD_URL="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"
FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; fi
TMPDIR="$(mktemp -d /tmp/chromescribe-classify.XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

log() { echo "[$(date '+%H:%M:%S')] $*"; }

api_call() {
    local method="$1" path="$2"
    shift 2
    curl -s -L -X "$method" \
        -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
        -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
        "$@" "${DASHBOARD_URL}${path}"
}

log "Fetching transcripts..."
ALL_JSON="$TMPDIR/all.json"
api_call GET /api/transcripts > "$ALL_JSON"
mapfile -t IDS < <(FORCE="$FORCE" python3 -c '
import json, os, sys
force = os.environ["FORCE"] == "1"
for transcript in json.load(open(sys.argv[1], encoding="utf-8"))["data"]:
    if force or not (transcript.get("category") or "").strip():
        print(transcript["id"])
' "$ALL_JSON")

log "Classifying ${#IDS[@]} transcripts"
failed=0
for ID in "${IDS[@]}"; do
    log "Classifying #$ID on Cloudflare..."
    RESPONSE=$(api_call POST "/api/transcripts/$ID/classify" --max-time 150)
    if echo "$RESPONSE" | grep -q '"classified":true'; then
        CATEGORY=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['category'])" 2>/dev/null)
        log "  OK: $CATEGORY"
    else
        log "  FAILED: $RESPONSE"
        failed=$((failed + 1))
    fi
done

log "Done. Failed: $failed"
