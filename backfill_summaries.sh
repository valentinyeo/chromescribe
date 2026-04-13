#!/bin/bash
# Regenerate TL;DR + "The Article" for transcripts missing them.
# Usage: ./backfill_summaries.sh [id1 id2 ...]     (defaults to auto-discovered list)

set -uo pipefail
cd "$(dirname "$0")"

CF_ID="${CF_ACCESS_CLIENT_ID:-REMOVED_OLD_KEY}"
CF_SECRET="${CF_ACCESS_CLIENT_SECRET:-REMOVED_OLD_KEY}"
BASE="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"
CURL_HDR=(-H "CF-Access-Client-Id: $CF_ID" -H "CF-Access-Client-Secret: $CF_SECRET" -H "User-Agent: ChromeScribe/1.0")
TMPDIR="${TMPDIR:-/tmp}/chromescribe_backfill"
mkdir -p "$TMPDIR"

log() { printf "[%s] %s\n" "$(date +%H:%M:%S)" "$*"; }

if [ -z "${MINIMAX_API_KEY:-}" ]; then
  echo "ERROR: MINIMAX_API_KEY not set in environment. Run from an interactive shell or export it first." >&2
  exit 1
fi

# Determine target IDs
if [ $# -gt 0 ]; then
  IDS=("$@")
else
  log "Auto-discovering transcripts missing TL;DR…"
  MISSING_JSON=$(python3 <<PY
import urllib.request, json
H = {'CF-Access-Client-Id':'$CF_ID','CF-Access-Client-Secret':'$CF_SECRET','User-Agent':'ChromeScribe/1.0'}
base='$BASE'
data = json.load(urllib.request.urlopen(urllib.request.Request(f'{base}/api/transcripts', headers=H), timeout=20))['data']
missing = []
for t in data:
    try:
        c = urllib.request.urlopen(urllib.request.Request(f"{base}/api/transcript/{t['id']}/content", headers=H), timeout=15).read().decode('utf-8','replace')
        if '## TL;DR' not in c:
            missing.append(t['id'])
    except Exception:
        pass
print(' '.join(str(i) for i in missing))
PY
)
  read -ra IDS <<< "$MISSING_JSON"
fi

log "Backfilling ${#IDS[@]} transcripts: ${IDS[*]}"

for ID in "${IDS[@]}"; do
  log "=== #$ID ==="

  META_JSON=$(curl -sL "${CURL_HDR[@]}" "$BASE/api/transcripts/$ID")
  TITLE=$(python3 -c "import sys,json; print(json.loads(sys.argv[1])['data']['title'])" "$META_JSON" 2>/dev/null || echo "")
  VIDEO_ID=$(python3 -c "import sys,json; print(json.loads(sys.argv[1])['data']['video_id'])" "$META_JSON" 2>/dev/null || echo "")
  if [ -z "$TITLE" ]; then
    log "  skip — no metadata"
    continue
  fi
  log "  title: $TITLE"

  TRANSCRIPT_FILE="$TMPDIR/transcript_${ID}.txt"
  curl -sL "${CURL_HDR[@]}" "$BASE/api/transcript/$ID/content" > "$TRANSCRIPT_FILE"
  BYTES=$(wc -c < "$TRANSCRIPT_FILE")
  if [ "$BYTES" -lt 200 ]; then
    log "  skip — content too short ($BYTES bytes)"
    continue
  fi

  # Detect source URL + content type from existing markdown
  URL=$(grep -m1 '^\*\*Source:\*\*' "$TRANSCRIPT_FILE" | sed -E 's/^\*\*Source:\*\* *//' | tr -d ' ')
  TYPE=$(grep -m1 '^\*\*Type:\*\*' "$TRANSCRIPT_FILE" | sed -E 's/^\*\*Type:\*\* *//')
  [ -z "$TYPE" ] && TYPE="Video Transcription"
  [ -z "$URL" ] && URL="(unknown)"

  SUMMARY_FILE="$TMPDIR/summary_${ID}.md"
  rm -f "$SUMMARY_FILE"

  if [[ "$TYPE" == *Article* ]]; then
    BODY_HEADER="Full Article"
    KIND="article"
  else
    BODY_HEADER="Full Transcript"
    KIND="video transcript"
  fi

  pi --provider minimax --model MiniMax-M2.7-highspeed --no-session < /dev/null \
    "You are a content summarizer. Read the $KIND file '$TRANSCRIPT_FILE' (it contains the raw $KIND body) and write ONE file to '$SUMMARY_FILE' with EXACTLY this structure:

# $TITLE

**Source:** $URL
**Date:** $(date +%Y-%m-%d)
**Type:** $TYPE

---

## TL;DR

<3-5 bullet points with key takeaways. Be specific — names, numbers, claims, quotes.>

---

## The Article

<800-1500 word web summary using pyramid principle. Lead with the most important insight. Short paragraphs, **bold key phrases**, subheadings every 2-3 paragraphs. Synthesize — do not copy verbatim.>

---

## $BODY_HEADER

<The full cleaned body from '$TRANSCRIPT_FILE'. Preserve paragraph breaks. For transcripts, remove timestamps and sequence numbers.>

IMPORTANT: Only write the single file '$SUMMARY_FILE'. Do NOT run any other commands, do not make any API calls." >/dev/null 2>&1

  if [ ! -s "$SUMMARY_FILE" ]; then
    log "  FAILED — pi produced no summary"
    continue
  fi
  SUMMARY_BYTES=$(wc -c < "$SUMMARY_FILE")
  log "  summary written: $SUMMARY_BYTES bytes"

  if ! grep -q '^## TL;DR' "$SUMMARY_FILE"; then
    log "  FAILED — summary missing TL;DR section; skipping upload"
    continue
  fi

  PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'markdown_content': open(sys.argv[1]).read()}))" "$SUMMARY_FILE")
  RESP=$(curl -sL -X PUT "${CURL_HDR[@]}" -H "Content-Type: application/json" -d "$PAYLOAD" "$BASE/api/transcripts/$ID")
  if echo "$RESP" | grep -q '"updated":true'; then
    log "  ✅ uploaded"
  else
    log "  ❌ upload failed: $RESP"
  fi
done

log "Done."
