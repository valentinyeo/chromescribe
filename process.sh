#!/bin/bash

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cf_access.sh"

URL="$1"
if [ -z "$URL" ]; then
    echo "Usage: ./process.sh <url>"
    exit 1
fi

cd "$(dirname "$0")"

if python3 -c 'import sys; sys.exit(0)' >/dev/null 2>&1; then
    PYTHON=python3
elif python -c 'import sys; sys.exit(0)' >/dev/null 2>&1; then
    PYTHON=python
else
    echo ">>> ERROR: Python is required"
    exit 1
fi

echo "=== ChromeScribe: Processing $URL ==="

is_video() {
    "$PYTHON" -c 'import json, re, sys, urllib.request
from urllib.parse import urlsplit
u = urlsplit(sys.argv[1])
host = u.hostname
is_x = False
m = re.search(r"/status/(\d+)", u.path)
if m and host in {"x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"}:
    # Only X posts with a video take the video path; text posts and X articles stay on the FXTwitter article path
    try:
        req = urllib.request.Request(f"https://api.fxtwitter.com/i/status/{m.group(1)}", headers={"User-Agent": "chromescribe"})
        tweet = json.load(urllib.request.urlopen(req, timeout=20)).get("tweet") or {}
        is_x = bool((tweet.get("media") or {}).get("videos"))
    except Exception:
        pass
sys.exit(0 if is_x or host in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be", "tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"} else 1)' "$1"
}

CHROMESCRIBE_API="${CHROMESCRIBE_API:-https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev}"
DASHBOARD_BASE="${CHROMESCRIBE_API%/}"

api_call() {
    local method="$1" path="$2"
    shift 2
    curl -s -L \
        -X "$method" \
        -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
        -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
        -c /tmp/cf-cookies-chromescribe.txt \
        -b /tmp/cf-cookies-chromescribe.txt \
        "$@" \
        "${DASHBOARD_BASE}${path}"
}

open_transcript() {
    if [ "${CHROMESCRIBE_NO_OPEN:-0}" != "1" ]; then
        echo ">>> Opening $DASHBOARD_URL"
        cmd.exe /c start "" msedge "$DASHBOARD_URL" 2>/dev/null &
    fi
}

upload_already_exists() {
    "$PYTHON" -c 'import json, sys
try:
    payload = json.load(sys.stdin)
    sys.exit(0 if payload.get("already_exists") or payload.get("data", {}).get("already_exists") else 1)
except (ValueError, AttributeError):
    sys.exit(1)' <<< "$UPLOAD_RESULT"
}

run_hosted_analysis() {
    local transcript_id="$1"
    local result summary_ok classify_ok warning
    echo ">>> Generating summary + classification on Cloudflare..."
    result=$(api_call POST "/api/transcripts/$transcript_id/analyze" --max-time 240)
    summary_ok=$(echo "$result" | "$PYTHON" -c "
import sys, json
try: print('yes' if json.load(sys.stdin).get('data', {}).get('summarized') else '')
except: print('')
" 2>/dev/null)
    classify_ok=$(echo "$result" | "$PYTHON" -c "
import sys, json
try: print('yes' if json.load(sys.stdin).get('data', {}).get('classified') else '')
except: print('')
" 2>/dev/null)
    if [ "$summary_ok" != "yes" ]; then
        echo ">>> WARNING: Cloudflare analysis failed; raw content was preserved: $result"
        return 1
    fi
    echo ">>> Cloudflare summary complete"
    if [ "$classify_ok" = "yes" ]; then
        echo ">>> Cloudflare classification complete"
    else
        warning=$(echo "$result" | "$PYTHON" -c "
import sys, json
try: print(json.load(sys.stdin).get('data', {}).get('warning', 'unknown error'))
except: print('unknown error')
" 2>/dev/null)
        echo ">>> WARNING: Classification failed: $warning"
    fi
    return 0
}

if is_video "$URL"; then
    echo ">>> Phase 1: Downloading audio + transcribing via Cloudflare..."

    TS=$(date +%s)
    TMPDIR="$(mktemp -d "/tmp/chromescribe.${TS}.XXXX")"
    trap 'rm -rf "$TMPDIR"' EXIT

    winpath() { cygpath -w "$1" 2>/dev/null || echo "$1"; }

    VIDEO_ID=$(URL="$URL" "$PYTHON" -c '
import os, re
from urllib.parse import urlparse, parse_qs
u = urlparse(os.environ["URL"])
host = u.hostname or ""
video_id = ""
if host == "youtu.be":
    video_id = u.path.strip("/").split("/")[0]
elif host.endswith("youtube.com"):
    video_id = parse_qs(u.query).get("v", [""])[0]
    if not video_id:
        match = re.match(r"/shorts/([A-Za-z0-9_-]{11})", u.path)
        video_id = match.group(1) if match else ""
elif host.endswith("tiktok.com"):
    match = re.search(r"/video/(\d+)", u.path)
    video_id = f"tiktok:{match.group(1)}" if match else ""
elif host in ("x.com", "twitter.com") or host.endswith((".x.com", ".twitter.com")):
    match = re.search(r"/status/(\d+)", u.path)
    video_id = f"x:{match.group(1)}" if match else ""
print(video_id)
' 2>/dev/null)

    if [ -n "$VIDEO_ID" ]; then
        LOOKUP_RESULT=$(api_call GET "/api/transcripts?video_id=$VIDEO_ID")
        EXISTING_TRANSCRIPT=$(VIDEO_ID="$VIDEO_ID" "$PYTHON" -c '
import json, os, sys
try:
    payload = json.load(sys.stdin)
    rows = payload.get("data", payload)
    if isinstance(rows, dict): rows = [rows]
    match = next((row for row in rows if row.get("video_id") == os.environ["VIDEO_ID"]), None)
    if match: print(f"{match.get('"'"'id'"'"', '"'"''"'"')}\t{match.get('"'"'title'"'"', '"'"''"'"')}")
except Exception:
    pass
' <<< "$LOOKUP_RESULT")
        if [ -n "$EXISTING_TRANSCRIPT" ]; then
            TRANSCRIPT_ID=${EXISTING_TRANSCRIPT%%$'\t'*}
            TRANSCRIPT_TITLE=${EXISTING_TRANSCRIPT#*$'\t'}
            DASHBOARD_URL="https://chromescribe.yeoux.net/transcript.html?id=${TRANSCRIPT_ID}"
            echo ">>> Already transcribed: #$TRANSCRIPT_ID — $TRANSCRIPT_TITLE"
            open_transcript
            exit 0
        fi
    fi

    DOWNLOAD_TEMPLATE="$TMPDIR/raw.%(ext)s"
    TITLE_FILE="$TMPDIR/title.txt"
    CANONICAL_URL_FILE="$TMPDIR/url.txt"
    DOWNLOAD_LOG="$TMPDIR/yt-dlp.log"
    DOWNLOAD_IPV6=()
    DOWNLOAD_PROXY=()
    case "$URL" in
        *://tiktok.com/*|*://*.tiktok.com/*) DOWNLOAD_PROXY=(--proxy "") ;;
    esac
    for DOWNLOAD_ATTEMPT in 1 2; do
        yt-dlp "${DOWNLOAD_IPV6[@]}" "${DOWNLOAD_PROXY[@]}" -S "vcodec:h264" -o "$DOWNLOAD_TEMPLATE" \
            --print-to-file "%(title)s" "$TITLE_FILE" \
            --print-to-file "%(webpage_url)s" "$CANONICAL_URL_FILE" "$URL" > "$DOWNLOAD_LOG" 2>&1
        DOWNLOAD_STATUS=$?
        tail -3 "$DOWNLOAD_LOG"
        RAW_FILE=$(ls "$TMPDIR"/raw.* 2>/dev/null | head -1)
        if [ "$DOWNLOAD_STATUS" -eq 0 ] && [ -n "$RAW_FILE" ] && [ -s "$RAW_FILE" ]; then
            break
        fi
        if "$PYTHON" -c 'import sys; from urllib.parse import urlsplit; sys.exit(0 if urlsplit(sys.argv[1]).hostname in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"} else 1)' "$URL" &&
            grep -q "Sign in to confirm" "$DOWNLOAD_LOG"; then
            if [ "$DOWNLOAD_ATTEMPT" -eq 1 ]; then
                echo ">>> YouTube asked for a bot check; retrying over IPv6..."
                DOWNLOAD_IPV6=(-6)
                continue
            fi
            echo ">>> ERROR: YouTube blocked this download with a bot check (\"Sign in to confirm you're not a bot\"). Try again later or from another network."
        else
            echo ">>> ERROR: yt-dlp failed"
        fi
        exit 1
    done
    case "$URL" in
        https://vm.tiktok.com/*|https://vt.tiktok.com/*)
            CANONICAL_URL=$(head -1 "$CANONICAL_URL_FILE" 2>/dev/null | tr -d '\r')
            if [[ ! "$CANONICAL_URL" =~ ^https://(www\.|m\.)?tiktok\.com/@[^/]+/video/[0-9]{15,21}([/?].*)?$ ]]; then
                echo ">>> ERROR: TikTok short link did not resolve to a video URL"
                exit 1
            fi
            URL="$CANONICAL_URL"
            ;;
    esac
    VIDEO_TITLE=$(head -1 "$TITLE_FILE" 2>/dev/null | tr -d '\r')
    [ -n "$VIDEO_TITLE" ] || VIDEO_TITLE="Video Transcript"
    echo ">>> Downloaded: $(du -h "$RAW_FILE" | cut -f1)"

    AUDIO_FILE="$TMPDIR/audio.mp3"
    if ! ffmpeg -i "$RAW_FILE" -vn -ac 1 -ab 64k -ar 16000 "$AUDIO_FILE" -y -loglevel error; then
        echo ">>> ERROR: ffmpeg audio extraction failed"
        exit 1
    fi
    rm -f "$RAW_FILE"
    echo ">>> Audio extracted: $(du -h "$AUDIO_FILE" | cut -f1)"

    FILE_SIZE=$(stat -c%s "$AUDIO_FILE")
    TRANSCRIPT_ID=""
    TRANSCRIPT_TITLE=""

    if [ "$FILE_SIZE" -le 500000 ]; then
        echo ">>> Small file — uploading directly for transcription..."
        UPLOAD_RESULT=$(api_call POST /api/transcribe \
            -F "audio=@$(winpath "$AUDIO_FILE");type=audio/mpeg" \
            -F "url=$URL" \
            --form-string "title=$VIDEO_TITLE")
        if upload_already_exists; then
            echo ">>> Already transcribed"
            exit 0
        fi
        TRANSCRIPT_ID=$(echo "$UPLOAD_RESULT" | "$PYTHON" -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('id') or d.get('id',''))" 2>/dev/null)
        TRANSCRIPT_TITLE=$(echo "$UPLOAD_RESULT" | "$PYTHON" -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('title') or d.get('title',''))" 2>/dev/null)
        if [ -z "$TRANSCRIPT_ID" ]; then
            echo ">>> ERROR: Upload failed. Response: $UPLOAD_RESULT"
            exit 1
        fi
    else
        echo ">>> Large file ($(du -h "$AUDIO_FILE" | cut -f1)) — chunking..."
        CHUNK_DIR="$TMPDIR/chunks"
        mkdir -p "$CHUNK_DIR"
        if ! ffmpeg -i "$AUDIO_FILE" -f segment -segment_time 60 -ac 1 -ab 24k -ar 16000 \
            "$CHUNK_DIR/chunk_%03d.mp3" -y -loglevel error; then
            echo ">>> ERROR: ffmpeg chunking failed"
            exit 1
        fi
        rm -f "$AUDIO_FILE"

        COMBINED_TEXT=""
        CHUNK_COUNT=0
        FAIL_COUNT=0
        for chunk in "$CHUNK_DIR"/chunk_*.mp3; do
            [ -f "$chunk" ] || continue
            CHUNK_COUNT=$((CHUNK_COUNT + 1))
            echo "    Transcribing chunk $CHUNK_COUNT ($(du -h "$chunk" | cut -f1))..."
            CHUNK_RESULT=$(api_call POST /api/whisper --max-time 60 -F "audio=@$(winpath "$chunk");type=audio/mpeg")
            CHUNK_TEXT=$(echo "$CHUNK_RESULT" | "$PYTHON" -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('text',''))" 2>/dev/null)
            if [ -z "$CHUNK_TEXT" ]; then
                FAIL_COUNT=$((FAIL_COUNT + 1))
                echo "    WARNING: Chunk $CHUNK_COUNT failed: $CHUNK_RESULT"
                continue
            fi
            COMBINED_TEXT="${COMBINED_TEXT} ${CHUNK_TEXT}"
        done
        rm -rf "$CHUNK_DIR"

        if [ -z "$COMBINED_TEXT" ]; then
            echo ">>> ERROR: All $CHUNK_COUNT chunks failed"
            exit 1
        fi
        echo ">>> Transcribed $((CHUNK_COUNT - FAIL_COUNT)) of $CHUNK_COUNT chunks"

        TODAY=$(date +%Y-%m-%d)
        MD_FILE="$TMPDIR/markdown.md"
        TEXT_FILE="$TMPDIR/text.txt"
        echo "$COMBINED_TEXT" > "$TEXT_FILE"
        TEXT_FILE="$TEXT_FILE" TITLE_FILE="$TITLE_FILE" URL="$URL" TODAY="$TODAY" "$PYTHON" -c '
import json, os, sys
sys.stdout.reconfigure(encoding="utf-8")
with open(os.environ["TEXT_FILE"], encoding="utf-8") as f: text = f.read().strip()
with open(os.environ["TITLE_FILE"], encoding="utf-8") as f: title = f.readline().strip() or "Video Transcript"
url, today = os.environ["URL"], os.environ["TODAY"]
md = f"# {title}\n\n**Source:** {url}\n**Date:** {today}\n**Type:** Video Transcription\n\n---\n\n## Full Transcript\n\n{text}\n\n---\n\n*Transcribed with Cloudflare Workers AI (chunked)*\n"
print(json.dumps({"url": url, "title": title, "markdown_content": md}, ensure_ascii=False))
' > "$MD_FILE"

        UPLOAD_RESULT=$(api_call POST /api/transcribe -H "Content-Type: application/json" -d @"$(winpath "$MD_FILE")")
        if upload_already_exists; then
            echo ">>> Already transcribed"
            exit 0
        fi
        TRANSCRIPT_ID=$(echo "$UPLOAD_RESULT" | "$PYTHON" -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('id') or d.get('id',''))" 2>/dev/null)
        TRANSCRIPT_TITLE=$(echo "$UPLOAD_RESULT" | "$PYTHON" -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('title') or d.get('title',''))" 2>/dev/null)
        if [ -z "$TRANSCRIPT_ID" ]; then
            echo ">>> ERROR: Combined upload failed. Response: $UPLOAD_RESULT"
            exit 1
        fi
    fi

    echo ">>> Phase 1 complete! Transcript #$TRANSCRIPT_ID — $TRANSCRIPT_TITLE"

    DASHBOARD_URL="https://chromescribe.yeoux.net/transcript.html?id=${TRANSCRIPT_ID}"
    open_transcript

    if ! run_hosted_analysis "$TRANSCRIPT_ID"; then
        if [ "${REQUIRE_ANALYZE:-0}" = "1" ]; then exit 1; fi
    fi
    echo "=== Done ==="
    exit 0
else
    ARTICLE_FILE="article_$(date +%s).md"
    trap 'rm -f "$ARTICLE_FILE"' EXIT
    STATUS_ID=$("$PYTHON" fxtwitter_article.py --status-id "$URL")
    if [ -n "$STATUS_ID" ]; then
        echo ">>> X/Twitter content detected, extracting via FXTwitter..."
        if ! curl -fsSL --max-time 45 "https://api.fxtwitter.com/i/status/$STATUS_ID" |
            "$PYTHON" fxtwitter_article.py > "$ARTICLE_FILE"; then
            echo ">>> ERROR: FXTwitter extraction failed"
            exit 1
        fi
    else
        echo ">>> Article detected, extracting via Jina Reader..."
        curl -sL --max-time 45 "https://r.jina.ai/$URL" > "$ARTICLE_FILE"
    fi

    if [ ! -s "$ARTICLE_FILE" ] || { [ -z "$STATUS_ID" ] && [ "$(wc -c < "$ARTICLE_FILE")" -lt 200 ]; }; then
        echo ">>> ERROR: Jina Reader returned no/minimal content. Site may block scraping."
        rm -f "$ARTICLE_FILE"
        exit 1
    fi
    WORDS=$(wc -w < "$ARTICLE_FILE")
    echo ">>> Extracted $WORDS words -> $ARTICLE_FILE"

    echo ">>> Uploading raw article to dashboard..."
    if ! UPLOAD_RESULT=$("$PYTHON" upload_article.py "$URL" "$ARTICLE_FILE"); then
        echo ">>> ERROR: Article upload failed: $UPLOAD_RESULT"
        exit 1
    fi
    echo "$UPLOAD_RESULT"

    if upload_already_exists; then
        echo ">>> Already transcribed"
        exit 0
    fi
    TRANSCRIPT_ID=$(echo "$UPLOAD_RESULT" | "$PYTHON" -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('id') or d.get('id',''))" 2>/dev/null)
    if [ -z "$TRANSCRIPT_ID" ]; then
        echo ">>> Upload failed. Skipping Phase 2."
        exit 1
    fi
    echo ">>> Phase 1 complete! Article #$TRANSCRIPT_ID on dashboard."

    DASHBOARD_URL="https://chromescribe.yeoux.net/transcript.html?id=${TRANSCRIPT_ID}"
    open_transcript

    if ! run_hosted_analysis "$TRANSCRIPT_ID"; then
        if [ "${REQUIRE_ANALYZE:-0}" = "1" ]; then exit 1; fi
    fi
    rm -f "$ARTICLE_FILE"
    echo "=== Done ==="
    exit 0
fi
