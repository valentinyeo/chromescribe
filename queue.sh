#!/bin/bash
# ChromeScribe queue drainer.
# The Android app POSTs shared URLs to /api/queue; the phone can't run yt-dlp,
# so this box does. Runs from cron every minute, one at a time via flock.
# Usage: ./queue.sh   (add to cron: * * * * * . $HOME/.bashrc && .../queue.sh >> .../queue.log 2>&1)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DASHBOARD_URL="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"
CF_ACCESS_ID="${CF_ACCESS_CLIENT_ID:-REMOVED_OLD_KEY}"
CF_ACCESS_SECRET="${CF_ACCESS_CLIENT_SECRET:-REMOVED_OLD_KEY}"

export PATH="$HOME/.local/bin:$HOME/.deno/bin:$HOME/.npm-global/bin:$PATH"

# Only one drainer at a time — a transcription run takes minutes, cron fires every minute.
exec 9>/tmp/chromescribe-queue.lock
flock -n 9 || exit 0

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

api_call() {
    local method="$1" path="$2"
    shift 2
    curl -s -L -X "$method" \
        -H "CF-Access-Client-Id: $CF_ACCESS_ID" \
        -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET" \
        -c /tmp/cf-cookies-chromescribe.txt \
        -b /tmp/cf-cookies-chromescribe.txt \
        "$@" \
        "${DASHBOARD_URL}${path}"
}

pending=$(api_call GET /api/queue)
rows=$(echo "$pending" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for r in d.get("data", []):
    print("%s\t%s\t%s" % (r["id"], r["video_id"], r["url"]))
' 2>/dev/null)

[ -z "$rows" ] && exit 0

while IFS=$'\t' read -r qid video_id url; do
    [ -n "$qid" ] || continue
    # Real title, so the dashboard entry isn't called "Manual run". Non-fatal.
    title=$(curl -s --max-time 10 "https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${video_id}" \
        | python3 -c 'import sys,json; print(json.load(sys.stdin)["title"])' 2>/dev/null)
    [ -n "$title" ] || title="Shared from Android"

    log "Queue #$qid: $title ($url)"
    if "$SCRIPT_DIR/monitor.sh" --force "$video_id" "$title" < /dev/null; then
        api_call PUT "/api/queue/$qid" -H "Content-Type: application/json" -d '{"status":"done"}' > /dev/null
        log "Queue #$qid: done"
    else
        api_call PUT "/api/queue/$qid" -H "Content-Type: application/json" -d '{"status":"failed"}' > /dev/null
        log "Queue #$qid: FAILED"
    fi
done <<< "$rows"
