#!/usr/bin/env bash
set -euo pipefail
SELF=$(cd "$(dirname "$0")" && pwd)
ROOT=$(git -C "$SELF" rev-parse --show-toplevel)
RUN=${CS_VERIFY_DIR:-/tmp/cs-verify}
PORT=${CS_VERIFY_PORT:-8799}
W=$(npm root -g)/wrangler/bin/wrangler.js
[ -f "$W" ] || { echo "wrangler not installed globally: npm i -g wrangler"; exit 1; }
if [ -f "$RUN/dev.pid" ] && kill -0 "$(cat "$RUN/dev.pid")" 2>/dev/null; then echo "already running: pid $(cat "$RUN/dev.pid") on $(cat "$RUN/port")"; exit 1; fi
if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then echo "port $PORT is taken by someone else; set CS_VERIFY_PORT"; exit 1; fi
rm -rf "$RUN/state" "$RUN/wrangler.toml"
mkdir -p "$RUN/state" "$RUN/proof"
awk '/^\[ai\]/{skip=1;next} /^\[/{skip=0} !skip' "$ROOT/dashboard/wrangler.toml" \
  | sed "s|^main = .*|main = \"$ROOT/dashboard/src/index.ts\"|" > "$RUN/wrangler.toml"
grep -q '^\[ai\]' "$RUN/wrangler.toml" && { echo "AI binding still present; refusing"; exit 1; }
cd "$ROOT/dashboard"
node "$W" d1 execute chromescribe --local --config "$RUN/wrangler.toml" --persist-to "$RUN/state" --file schema.sql > "$RUN/seed.log" 2>&1
for f in public/*.html; do
  node "$W" r2 object put "chromescribe-transcripts/$(basename "$f")" --file "$f" --local --config "$RUN/wrangler.toml" --persist-to "$RUN/state" --content-type "text/html; charset=utf-8" >> "$RUN/seed.log" 2>&1
done
bash "$SELF/seed.sh"
nohup node "$W" dev --local --config "$RUN/wrangler.toml" --port "$PORT" --ip 127.0.0.1 --persist-to "$RUN/state" --var CHRO10_API_GATE:0 --var ENVIRONMENT:local > "$RUN/dev.log" 2>&1 &
echo $! > "$RUN/dev.pid"; echo "$PORT" > "$RUN/port"
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/api/transcripts" | grep -q '"success":true'; then echo "ready http://127.0.0.1:$PORT pid $(cat "$RUN/dev.pid")"; exit 0; fi
  sleep 1
done
echo "not ready after 60 s; see $RUN/dev.log"; exit 1
