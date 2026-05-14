#!/bin/bash
# One-off backfill: run Phase 2 (server-side summarize) on every raw-only transcript.
# Re-runnable — already-structured transcripts can be passed too (they just get re-summarized).
# Usage: ./backfill_summarize.sh "id1 id2 id3 ..."

BASE="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"
CF_ID="REMOVED_OLD_KEY"
CF_SECRET="REMOVED_OLD_KEY"

IDS="${1:-603 602 600 598 597 596 594 593 592 591 590 588 587 586 585 584 583 582 581 580 579 578 548 240}"

ok=0; fail=0; total=0
ts() { date '+%H:%M:%S'; }

for id in $IDS; do
  total=$((total+1))
  echo "[$(ts)] === #$id ($total) ==="
  resp=$(curl -s -X POST "$BASE/api/transcripts/$id/summarize" \
    -H "CF-Access-Client-Id: $CF_ID" \
    -H "CF-Access-Client-Secret: $CF_SECRET" \
    -L --max-time 240)
  if echo "$resp" | grep -q '"success":true'; then
    wc=$(echo "$resp" | grep -oE '"word_count":[0-9]+' | grep -oE '[0-9]+')
    echo "[$(ts)]   OK  word_count=$wc"
    ok=$((ok+1))
  else
    echo "[$(ts)]   FAIL  $resp"
    fail=$((fail+1))
  fi
done

echo "[$(ts)] Done. $ok ok, $fail failed, $total total."
