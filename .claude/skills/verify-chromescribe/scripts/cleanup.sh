#!/usr/bin/env bash
RUN=${CS_VERIFY_DIR:-/tmp/cs-verify}
if [ -f "$RUN/dev.pid" ]; then
  PID=$(cat "$RUN/dev.pid")
  pkill -P "$PID" 2>/dev/null; kill "$PID" 2>/dev/null
  rm -f "$RUN/dev.pid"
fi
rm -rf "$RUN/state" "$RUN/wrangler.toml" "$RUN"/seedvideo*.md
echo "stopped; proof kept in $RUN/proof"; ls "$RUN/proof" 2>/dev/null
