#!/bin/bash
# ChromeScribe queue drainer.
# The Android app POSTs shared URLs to /api/queue; the phone can't run yt-dlp,
# so this box does. Runs from cron every minute, one at a time via flock.
# Usage: ./queue.sh   (add to cron: * * * * * . $HOME/.bashrc && .../queue.sh >> .../queue.log 2>&1)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DASHBOARD_URL="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"

# shellcheck disable=SC1090
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cf_access.sh"

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

# Only one drainer at a time - a transcription run takes minutes, cron fires every minute.
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

    if ! api_call PUT "/api/queue/$qid" -H "Content-Type: application/json" -d '{"status":"processing"}'; then
        log "ERROR: Queue #$qid: could not mark processing; skipping row"
        overall_rc=1
        continue
    fi
    output_file="$TMPDIR_Q/process.log"
    case "$video_id" in
        article:*|tiktok:*|tiktok-short:*)
            log "Queue #$qid: $url"
            (cd "$SCRIPT_DIR" && CHROMESCRIBE_NO_OPEN=1 REQUIRE_ANALYZE=1 bash ./process.sh "$url" < /dev/null) 2>&1 | tee "$output_file"
            process_rc=${PIPESTATUS[0]}
            ;;
        *)
            # Real title, so the dashboard entry isn't called "Manual run".
            title=$( { curl -sS -f --max-time 10 --proto '=https' \
                "https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${video_id}" \
                | "$PYTHON" -c 'import sys,json; print(json.load(sys.stdin)["title"])'; } 2>/dev/null )
            [ -n "$title" ] || title="Shared from Android"
            log "Queue #$qid: $title ($url)"
            REQUIRE_ANALYZE=1 "$MONITOR_SH" --force "$video_id" "$title" < /dev/null 2>&1 | tee "$output_file"
            process_rc=${PIPESTATUS[0]}
            ;;
    esac
    if [ "$process_rc" -eq 0 ]; then
        # Transcription succeeded; the row is only "done" once the API agrees.
        if api_call PUT "/api/queue/$qid" -H "Content-Type: application/json" -d '{"status":"done"}'; then
            log "Queue #$qid: done"
        else
            log "ERROR: Queue #$qid: transcription finished but marking done failed; row remains processing, check the queue"
            overall_rc=1
        fi
    else
        log "Queue #$qid: FAILED (downloader/transcription), marking failed and continuing"
        failure_payload=$("$PYTHON" - "$output_file" "$process_rc" <<'PYERROR'
import json, os, re, sys
with open(sys.argv[1], errors='replace') as fh:
    output = fh.read()
output = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', output)
lines = [line.strip() for line in output.splitlines() if line.strip()]
errors = [line for line in lines if re.search(r'\bERROR\b', line, re.I)]
message = (errors or lines or ['Processing failed (exit %s)' % sys.argv[2]])[-1]
# Never persist service credentials or token-bearing downloader URLs.
for name, value in os.environ.items():
    if value and any(word in name.upper() for word in ('SECRET', 'TOKEN', 'PASSWORD', 'API_KEY', 'CLIENT_ID')):
        message = message.replace(value, '[redacted]')
message = re.sub(r'https?://\S+', '[URL]', message)
message = re.sub(r'(?i)((?:authorization|cookie|password|token|secret|api[_-]?key)\s*[:=]\s*).*', r'\1[redacted]', message)
message = re.sub(r'[\x00-\x1f\x7f]', '', message)
print(json.dumps({'status': 'failed', 'error': message[:500]}, separators=(',', ':')))
PYERROR
)
        if ! api_call PUT "/api/queue/$qid" -H "Content-Type: application/json" -d "$failure_payload"; then
            log "ERROR: Queue #$qid: could not mark failed"
        fi
        overall_rc=1
    fi
done < "$rows_file"

exit "$overall_rc"
