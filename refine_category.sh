#!/bin/bash
# Re-classify a broad category through Cloudflare Workers AI + AI Gateway.
# Usage: ./refine_category.sh "AI Tools" [--dry-run]

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cf_access.sh"

set -uo pipefail
cd "$(dirname "$0")"

SOURCE_CATEGORY="${1:-}"
DRY_RUN=0
if [ "${2:-}" = "--dry-run" ]; then DRY_RUN=1; fi
if [ -z "$SOURCE_CATEGORY" ]; then
    echo "Usage: $0 \"Source Category\" [--dry-run]"
    exit 1
fi

DASHBOARD_URL="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"
TMPDIR="$(mktemp -d /tmp/chromescribe-refine.XXXXXX)"
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

ALL_JSON="$TMPDIR/all.json"
api_call GET /api/transcripts > "$ALL_JSON"
SOURCE_CATEGORY="$SOURCE_CATEGORY" python3 -c '
import json, os, sys
source = os.environ["SOURCE_CATEGORY"]
for transcript in json.load(open(sys.argv[1], encoding="utf-8"))["data"]:
    if (transcript.get("category") or "").strip() == source:
        print(transcript["id"])
' "$ALL_JSON" > "$TMPDIR/ids.txt"

mapfile -t IDS < "$TMPDIR/ids.txt"
log "Found ${#IDS[@]} transcripts in category '$SOURCE_CATEGORY'"
if [ "$DRY_RUN" = "1" ]; then
    exit 0
fi

PAYLOAD=$(SOURCE_CATEGORY="$SOURCE_CATEGORY" python3 -c 'import json,os; print(json.dumps({"exclude_category": os.environ["SOURCE_CATEGORY"]}))')
failed=0
for ID in "${IDS[@]}"; do
    log "Refining #$ID on Cloudflare..."
    RESPONSE=$(api_call POST "/api/transcripts/$ID/classify" \
        --max-time 150 -H "Content-Type: application/json" -d "$PAYLOAD")
    if echo "$RESPONSE" | grep -q '"classified":true'; then
        CATEGORY=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['category'])" 2>/dev/null)
        log "  OK: $CATEGORY"
    else
        log "  FAILED: $RESPONSE"
        failed=$((failed + 1))
    fi
done

log "Done. Failed: $failed"
