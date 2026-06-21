#!/bin/bash
# Append a YouTube channel to channels.txt for the monitor, deduped.
# Usage: add_channel.sh <UC_CHANNEL_ID> [@handle] [Channel Name]
cd "$(dirname "$0")"
CID="$1"; HANDLE="${2:-}"; NAME="${3:-}"
if [ -z "$CID" ]; then echo "Usage: add_channel.sh <UC_CHANNEL_ID> [@handle] [name]"; exit 1; fi
case "$CID" in UC*) ;; *) echo "Not a channel id (expected UC...): $CID"; exit 1;; esac
if grep -qiF "$CID" channels.txt 2>/dev/null; then
  echo "Already watching: $CID ($HANDLE)"; exit 0
fi
LABEL="$HANDLE"; [ -n "$NAME" ] && LABEL="$HANDLE ($NAME)"
echo "$CID # $LABEL" >> channels.txt
echo "Added: $CID # $LABEL"
