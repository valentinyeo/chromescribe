#!/bin/bash

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cf_access.sh"

set -uo pipefail
cd "$(dirname "$0")"

BASE="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"
CURL_HDR=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" -H "User-Agent: ChromeScribe/1.0")

log() { printf "[%s] %s\n" "$(date +%H:%M:%S)" "$*"; }

if [ $# -gt 0 ]; then
  IDS=("$@")
else
  log "Auto-discovering transcripts missing TL;DR…"
  MISSING_IDS=$(python3 <<'PY'
import urllib.request, json, os
headers = {'CF-Access-Client-Id':os.environ['CF_ACCESS_CLIENT_ID'],'CF-Access-Client-Secret':os.environ['CF_ACCESS_CLIENT_SECRET'],'User-Agent':'ChromeScribe/1.0'}
base="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"
data = json.load(urllib.request.urlopen(urllib.request.Request(f'{base}/api/transcripts', headers=headers), timeout=20))['data']
missing = []
for transcript in data:
    try:
        request = urllib.request.Request(f"{base}/api/transcript/{transcript['id']}/content", headers=headers)
        content = urllib.request.urlopen(request, timeout=15).read().decode('utf-8', 'replace')
        if '## TL;DR' not in content:
            missing.append(transcript['id'])
    except Exception:
        pass
print(' '.join(str(i) for i in missing))
PY
)
  read -ra IDS <<< "$MISSING_IDS"
fi

log "Backfilling ${#IDS[@]} transcripts: ${IDS[*]}"
failed=0

for ID in "${IDS[@]}"; do
  log "Summarizing #$ID on Cloudflare..."
  RESPONSE=$(curl -sL -X POST "${CURL_HDR[@]}" --max-time 240 "$BASE/api/transcripts/$ID/summarize")
  if echo "$RESPONSE" | grep -q '"summarized":true'; then
    log "  OK"
  else
    log "  FAILED: $RESPONSE"
    failed=$((failed + 1))
  fi
done

log "Done. Failed: $failed"
