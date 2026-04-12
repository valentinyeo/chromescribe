#!/bin/bash
# Backfill category + tags for all existing transcripts.
# Fetches each transcript, asks pi to classify (category + tags),
# then PUTs classification to the dashboard API.
# Safe to re-run — skips rows that already have a category unless --force.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMPDIR="$(mktemp -d /tmp/chromescribe-backfill.XXXXXX)"
DASHBOARD_URL="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"

export PATH="$HOME/.local/bin:$HOME/.deno/bin:$HOME/.npm-global/bin:$PATH"

CF_ACCESS_ID="${CF_ACCESS_CLIENT_ID:-REMOVED_OLD_KEY}"
CF_ACCESS_SECRET="${CF_ACCESS_CLIENT_SECRET:-REMOVED_OLD_KEY}"

FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; fi

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

log() { echo "[$(date '+%H:%M:%S')] $*"; }

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

log "Fetching all transcripts..."
all_json="$TMPDIR/all.json"
api_call GET /api/transcripts > "$all_json"
total=$(python3 -c "import json; print(len(json.load(open('$all_json'))['data']))")
log "Found $total transcripts"

count=0
failed=0

# Select only IDs that need processing, emit one per line
python3 -c "
import json
force = '$FORCE' == '1'
for t in json.load(open('$all_json'))['data']:
    if force or not (t.get('category') or '').strip():
        print(t['id'])
" > "$TMPDIR/ids.txt"

to_process=$(wc -l < "$TMPDIR/ids.txt")
skipped=$((total - to_process))
log "Will process $to_process, skipping $skipped (already classified)"

while IFS= read -r id; do
    count=$((count + 1))

    # Fetch title for logging
    title=$(python3 -c "
import json
for t in json.load(open('$all_json'))['data']:
    if t['id'] == $id:
        print(t['title'])
        break
")

    log "[$count/$to_process] Processing #$id: $title"

    # Fetch transcript content
    content_file="$TMPDIR/content_${id}.txt"
    api_call GET "/api/transcript/$id/content" > "$content_file"

    if [ ! -s "$content_file" ]; then
        log "  SKIP: empty content"
        failed=$((failed + 1))
        continue
    fi

    # Fetch existing categories for reuse hint
    existing_cats=$(api_call GET /api/categories 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin).get('data', [])
    cats = [c['category'] for c in data if c.get('category')]
    print(', '.join(cats) if cats else '(none yet)')
except: print('(none yet)')
")

    classify_file="$TMPDIR/classify_${id}.json"

    pi --provider minimax --model MiniMax-M2.7-highspeed --no-session < /dev/null \
      "Read the transcript at '$content_file' and classify it.

Write EXACTLY this JSON (and nothing else) to '$classify_file':

{\"category\": \"<ONE short category, 1-3 words>\", \"tags\": [\"<tag1>\", \"<tag2>\", \"<tag3>\", \"<tag4>\", \"<tag5>\"]}

Category rules:
- PREFER reusing an existing category from this list if it fits: $existing_cats
- Only invent a new one if none fit. Keep it short (1-3 words), Title Case.
- Categories should be broad enough to group multiple videos.

Tag rules:
- 3-5 specific topical tags (people, tools, techniques, products mentioned)
- Lowercase, short (1-3 words each), no hashtags

STEPS:
1. Read '$content_file' using cat
2. Write the JSON to '$classify_file'
3. Exit immediately." 2>&1 | tail -3

    if [ ! -f "$classify_file" ]; then
        log "  FAIL: pi did not produce classify.json"
        failed=$((failed + 1))
        continue
    fi

    payload=$(python3 -c "
import json, sys
try:
    with open('$classify_file') as f: c = json.load(f)
    out = {}
    if c.get('category'): out['category'] = c['category']
    if isinstance(c.get('tags'), list): out['tags'] = c['tags']
    print(json.dumps(out))
except: pass
" 2>/dev/null)

    if [ -z "$payload" ] || [ "$payload" = "{}" ]; then
        log "  FAIL: invalid classify JSON"
        failed=$((failed + 1))
        continue
    fi

    api_call PUT "/api/transcripts/$id" -H "Content-Type: application/json" -d "$payload" > /dev/null
    log "  OK: $payload"

done < "$TMPDIR/ids.txt"

log "Done. Attempted $count, skipped $skipped (already had category), failed $failed"
