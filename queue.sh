#!/bin/bash
# ChromeScribe queue drainer.
# The Android app POSTs shared URLs to /api/queue; the phone can't run yt-dlp,
# so this box does. Runs from cron every minute, one at a time via flock.
# Usage: ./queue.sh   (add to cron: * * * * * . $HOME/.bashrc && .../queue.sh >> .../queue.log 2>&1)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DASHBOARD_URL="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"

# Credentials: prefer the environment, else a gitignored local file that uses
# normal shell `export KEY=value` syntax. No hardcoded fallback is kept here
# (the old shared secrets were removed); without creds the drainer refuses to
# run rather than silently calling the API as an anonymous client.
ENV_FILE="${CHROMESCRIBE_ENV_FILE:-$SCRIPT_DIR/.env.chromescribe}"
if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    . "$ENV_FILE"
fi
: "${CF_ACCESS_CLIENT_ID:?CF_ACCESS_CLIENT_ID is required (env or $ENV_FILE)}"
: "${CF_ACCESS_CLIENT_SECRET:?CF_ACCESS_CLIENT_SECRET is required (env or $ENV_FILE)}"
export CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET

export PATH="$HOME/.local/bin:$HOME/.deno/bin:$HOME/.npm-global/bin:$PATH"

MONITOR_SH="${MONITOR_SH:-$SCRIPT_DIR/monitor.sh}"
QUEUE_LOCK_FILE="${QUEUE_LOCK_FILE:-/tmp/chromescribe-queue.lock}"
API_MAX_TIME="${QUEUE_API_MAX_TIME:-30}"
QUEUE_PLATFORMS="${QUEUE_PLATFORMS:-youtube,article}"

if python3 -c 'import sys; sys.exit(0)' >/dev/null 2>&1; then
    PYTHON=python3
elif python -c 'import sys; sys.exit(0)' >/dev/null 2>&1; then
    PYTHON=python
else
    echo "ERROR: a working Python interpreter is required" >&2
    exit 1
fi

# Only one drainer at a time — a transcription run takes minutes, cron fires every minute.
# Git Bash on Windows has no flock; there Task Scheduler's default "do not start
# a new instance" policy prevents overlapping runs instead.
if command -v flock >/dev/null 2>&1; then
    exec 9>"$QUEUE_LOCK_FILE"
    flock -n 9 || exit 0
fi

TMPDIR_Q="$(mktemp -d /tmp/chromescribe-queue.XXXXXX)"
cleanup() { rm -rf "$TMPDIR_Q"; }
trap cleanup EXIT

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# api_call METHOD PATH [extra curl args...]
# On success ($? == 0) the raw `data` field is not needed by callers; the full
# response body is left at "$TMPDIR_Q/api.json" and we return 0 only when the
# request succeeded AND the {success:true,...} envelope validated.
#
# No -L: service-token headers must never follow a redirect to another host.
# No shared cookiejar: the service token is sent on every request instead.
api_call() {
    local method="$1" path="$2"
    shift 2
    local out="$TMPDIR_Q/api.json"
    local err="$TMPDIR_Q/curl.err"
    local code rc
    code=$(curl -sS -f --max-time "$API_MAX_TIME" --proto '=https' \
        -X "$method" \
        -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
        -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
        -H "Accept: application/json" \
        -o "$out" -w '%{http_code}' \
        "$@" \
        "${DASHBOARD_URL}${path}" 2>"$err")
    rc=$?
    if [ "$rc" -ne 0 ]; then
        log "ERROR: $method $path: curl failed (rc=$rc, HTTP ${code:-?}): $(tr '\n' ' ' < "$err" 2>/dev/null | cut -c1-200)"
        return 1
    fi
    if ! "$PYTHON" - "$out" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        body = json.load(fh)
except Exception as exc:  # noqa: BLE001
    print("invalid JSON:", exc, file=sys.stderr)
    sys.exit(1)
if not isinstance(body, dict) or body.get("success") is not True:
    print("API envelope missing success:true", file=sys.stderr)
    sys.exit(1)
PY
    then
        log "ERROR: $method $path: response was not a valid success envelope (HTTP ${code:-?})"
        return 1
    fi
    return 0
}

log "Polling queue..."
if ! api_call GET /api/queue --get --data-urlencode "platforms=$QUEUE_PLATFORMS"; then
    log "ERROR: could not fetch pending queue; aborting this run"
    exit 1
fi

rows_file="$TMPDIR_Q/rows.tsv"
if ! "$PYTHON" - "$TMPDIR_Q/api.json" "$rows_file" <<'PY'
import json, re, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as fh:
    body = json.load(fh)
data = body.get("data")
if not isinstance(data, list):
    print("queue data is not a list", file=sys.stderr)
    sys.exit(1)
lines = []
for i, row in enumerate(data):
    if not isinstance(row, dict):
        print(f"queue[{i}] is not an object", file=sys.stderr)
        sys.exit(1)
    qid = row.get("id")
    video_id = row.get("video_id")
    url = row.get("url")
    if qid is None or not re.fullmatch(r"\d+", str(qid)):
        print(f"queue[{i}] has invalid id", file=sys.stderr)
        sys.exit(1)
    if not isinstance(video_id, str) or not video_id.strip():
        print(f"queue[{i}] missing video_id", file=sys.stderr)
        sys.exit(1)
    if not isinstance(url, str) or not url.strip():
        print(f"queue[{i}] missing url", file=sys.stderr)
        sys.exit(1)
    lines.append("%s\t%s\t%s" % (qid, video_id, url))
with open(dst, "w") as fh:
    for line in lines:
        fh.write(line + "\n")
PY
then
    log "ERROR: /api/queue returned a malformed row payload; aborting this run"
    exit 1
fi

[ -s "$rows_file" ] || exit 0

overall_rc=0
while IFS=$'\t' read -r qid video_id url; do
    [ -n "$qid" ] || continue

    case "$video_id" in
        article:*|tiktok:*|tiktok-short:*)
            log "Queue #$qid: $url"
            (cd "$SCRIPT_DIR" && CHROMESCRIBE_NO_OPEN=1 REQUIRE_ANALYZE=1 bash ./process.sh "$url" < /dev/null)
            process_rc=$?
            ;;
        *)
            # Real title, so the dashboard entry isn't called "Manual run".
            title=$( { curl -sS -f --max-time 10 --proto '=https' \
                "https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${video_id}" \
                | "$PYTHON" -c 'import sys,json; print(json.load(sys.stdin)["title"])'; } 2>/dev/null )
            [ -n "$title" ] || title="Shared from Android"
            log "Queue #$qid: $title ($url)"
            REQUIRE_ANALYZE=1 "$MONITOR_SH" --force "$video_id" "$title" < /dev/null
            process_rc=$?
            ;;
    esac
    if [ "$process_rc" -eq 0 ]; then
        # Transcription succeeded; the row is only "done" once the API agrees.
        if api_call PUT "/api/queue/$qid" -H "Content-Type: application/json" -d '{"status":"done"}'; then
            log "Queue #$qid: done"
        else
            log "ERROR: Queue #$qid: transcription finished but marking done failed; will retry next run"
            overall_rc=1
        fi
    else
        log "Queue #$qid: FAILED (downloader/transcription), marking failed and continuing"
        if ! api_call PUT "/api/queue/$qid" -H "Content-Type: application/json" -d '{"status":"failed"}'; then
            log "ERROR: Queue #$qid: could not mark failed"
        fi
        overall_rc=1
    fi
done < "$rows_file"

exit "$overall_rc"
