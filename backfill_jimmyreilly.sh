#!/bin/bash

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cf_access.sh"

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHANNEL="https://www.youtube.com/@thejimmyreilly/videos"
LIST="$SCRIPT_DIR/.jr_videos.tsv"
LOG="$SCRIPT_DIR/backfill_jimmyreilly.log"
PROCESSED="$SCRIPT_DIR/.processed_videos"
DASHBOARD="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"

export PATH="$HOME/.local/bin:$HOME/.deno/bin:$HOME/.npm-global/bin:$PATH"
export TELEGRAM_TINYDICTATION_BOT_TOKEN="disabled"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== backfill start: @thejimmyreilly ==="

if [ ! -s "$LIST" ]; then
  yt-dlp --flat-playlist --print $'%(id)s\t%(title)s' "$CHANNEL" 2>/dev/null > "$LIST"
fi
TOTAL=$(wc -l < "$LIST")
log "Enumerated $TOTAL videos"

CF_HDR=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID"
        -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")

EXISTING=$(curl -sL "${CF_HDR[@]}" "$DASHBOARD/api/transcripts" \
  | python3 -c "import sys,json; print('\n'.join(t['video_id'] for t in json.load(sys.stdin).get('data',[])))" 2>/dev/null)

OK=0; SKIP=0; FAIL=0; I=0
while IFS=$'\t' read -r VID TITLE; do
  I=$((I+1))
  [ -z "$VID" ] && continue

  if echo "$EXISTING" | grep -qFx "$VID"; then
    log "[$I/$TOTAL] SKIP (already in dashboard): $VID  $TITLE"
    SKIP=$((SKIP+1))
    grep -qF "$VID" "$PROCESSED" 2>/dev/null || echo "$VID" >> "$PROCESSED"
    continue
  fi

  log "[$I/$TOTAL] PROCESS: $VID  $TITLE"
  if "$SCRIPT_DIR/monitor.sh" --force "$VID" "$TITLE" < /dev/null >> "$LOG" 2>&1; then
    OK=$((OK+1))
    log "[$I/$TOTAL] OK"
  else
    FAIL=$((FAIL+1))
    log "[$I/$TOTAL] FAIL"
  fi
done < "$LIST"

log "=== backfill end: $OK ok, $SKIP skip, $FAIL fail of $TOTAL ==="
