#!/bin/bash
# One-shot backfill: run all @thejimmyreilly videos through the standard
# monitor.sh pipeline (yt-dlp → Whisper → summary → classify → D1/R2).
# Reuses monitor.sh --force per video. Sequential — no parallelism (avoids
# slamming YouTube + CF Worker; per-video state already isolated by mktemp).
# Per-video Telegram suppressed; final summary handled by the caller.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHANNEL="https://www.youtube.com/@thejimmyreilly/videos"
LIST="$SCRIPT_DIR/.jr_videos.tsv"
LOG="$SCRIPT_DIR/backfill_jimmyreilly.log"
PROCESSED="$SCRIPT_DIR/.processed_videos"
DASHBOARD="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"

export PATH="$HOME/.local/bin:$HOME/.deno/bin:$HOME/.npm-global/bin:$PATH"
# Suppress per-video Telegram notifications during the batch
export TELEGRAM_TINYDICTATION_BOT_TOKEN="disabled"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== backfill start: @thejimmyreilly ==="

# 1. Refresh the video list (tab-delimited to dodge titles with pipes)
yt-dlp --flat-playlist --print "%(id)s\t%(title)s" "$CHANNEL" 2>/dev/null > "$LIST"
TOTAL=$(wc -l < "$LIST")
log "Enumerated $TOTAL videos"

# 2. Process each video. Skip ones already in the dashboard (avoids re-Whisper cost).
CF_HDR=(-H "CF-Access-Client-Id: REMOVED_OLD_KEY"
        -H "CF-Access-Client-Secret: REMOVED_OLD_KEY")

# Pull existing transcript video_ids once
EXISTING=$(curl -sL "${CF_HDR[@]}" "$DASHBOARD/api/transcripts?limit=1000" \
  | python3 -c "import sys,json; print('\n'.join(t['video_id'] for t in json.load(sys.stdin).get('data',[])))" 2>/dev/null)

OK=0; SKIP=0; FAIL=0; I=0
while IFS=$'\t' read -r VID TITLE; do
  I=$((I+1))
  [ -z "$VID" ] && continue

  if echo "$EXISTING" | grep -qFx "$VID"; then
    log "[$I/$TOTAL] SKIP (already in dashboard): $VID  $TITLE"
    SKIP=$((SKIP+1))
    # Mark processed so monitor cron doesn't redo it
    grep -qF "$VID" "$PROCESSED" 2>/dev/null || echo "$VID" >> "$PROCESSED"
    continue
  fi

  log "[$I/$TOTAL] PROCESS: $VID  $TITLE"
  if "$SCRIPT_DIR/monitor.sh" --force "$VID" "$TITLE" >> "$LOG" 2>&1; then
    OK=$((OK+1))
    log "[$I/$TOTAL] OK"
  else
    FAIL=$((FAIL+1))
    log "[$I/$TOTAL] FAIL"
  fi
done < "$LIST"

log "=== backfill end: $OK ok, $SKIP skip, $FAIL fail of $TOTAL ==="
