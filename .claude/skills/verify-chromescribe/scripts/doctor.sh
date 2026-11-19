#!/usr/bin/env bash
RUN=${CS_VERIFY_DIR:-/tmp/cs-verify}
[ -f "$RUN/dev.pid" ] || { echo "FAIL no instance started by launch.sh"; exit 1; }
PID=$(cat "$RUN/dev.pid"); PORT=$(cat "$RUN/port")
kill -0 "$PID" 2>/dev/null || { echo "FAIL pid $PID is gone"; exit 1; }
grep -q '^\[ai\]' "$RUN/wrangler.toml" && { echo "FAIL AI binding present"; exit 1; }
N=$(curl -sf "http://127.0.0.1:$PORT/api/transcripts" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['data']))") || { echo "FAIL API not answering on $PORT"; exit 1; }
curl -sf -o /dev/null "http://127.0.0.1:$PORT/" || { echo "FAIL home page"; exit 1; }
echo "OK pid $PID port $PORT transcripts $N commit $(git rev-parse --short HEAD)"
