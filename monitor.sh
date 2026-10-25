#!/bin/bash

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cf_access.sh"

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHANNELS_FILE="$SCRIPT_DIR/channels.txt"
PROCESSED_FILE="$SCRIPT_DIR/.processed_videos"
TMPDIR="$(mktemp -d /tmp/chromescribe.XXXXXX)"
DASHBOARD_URL="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"

export PATH="$HOME/.local/bin:$HOME/.deno/bin:$HOME/.npm-global/bin:$PATH"
export DISPLAY=:0

TG_TOKEN="${TELEGRAM_TINYDICTATION_BOT_TOKEN:-}"
TG_CHAT="${TELEGRAM_TINYDICTATION_CHAT_ID:-2068947468}"

cleanup() {
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

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
        "${DASHBOARD_URL}${path}"
}

send_telegram() {
    [ -n "$TG_TOKEN" ] || return 0
    local msg="$1"
    local photo="${2:-}"
    if [ -n "$photo" ]; then
        curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendPhoto" \
            -d chat_id="$TG_CHAT" \
            -d parse_mode="HTML" \
            --data-urlencode photo="$photo" \
            --data-urlencode caption="$msg" > /dev/null 2>&1
    else
        curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
            -d chat_id="$TG_CHAT" \
            -d parse_mode="HTML" \
            --data-urlencode text="$msg" > /dev/null 2>&1
    fi
}

get_todays_videos() {
    local channel_id="$1"
    python3 "$SCRIPT_DIR/lib/youtube_feed.py" "$channel_id"
}

is_youtube_short() {
    local code
    code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://www.youtube.com/shorts/$1")
    [ "$code" = "200" ]
}

get_tiktok_videos() {
    local handle="$1"
    local ids
    ids=$(yt-dlp --proxy "" --no-check-certificate --flat-playlist --print "%(id)s" \
        "https://www.tiktok.com/@${handle}" 2>/dev/null | grep -E '^[0-9]{15,21}$')
    if [ -n "$ids" ]; then
        echo "$ids"
        return 0
    fi
    echo "  yt-dlp listing failed, scraping profile page..." >&2
    python3 - "$handle" <<'PYEOF'
import re, sys, urllib.request
handle = sys.argv[1]
req = urllib.request.Request(
    f"https://www.tiktok.com/@{handle}",
    headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    })
try:
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
except Exception as e:
    print(f"Profile scrape error: {e}", file=sys.stderr)
    sys.exit(1)
seen, out = set(), []
for vid in re.findall(r'"id":"(\d{15,21})"', html):
    if vid not in seen:
        seen.add(vid)
        out.append(vid)
print("\n".join(out))
PYEOF
}

tiktok_meta() {
    curl -s --max-time 20 "https://www.tiktok.com/oembed?url=$1" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print((d.get('title') or '').replace('\t', ' ').strip())
    print(d.get('thumbnail_url') or '')
except Exception:
    print('')
    print('')
"
}

process_tiktok_video() {
    local video_id="$1"
    local handle="$2"
    local url="https://www.tiktok.com/@${handle}/video/${video_id}"
    local meta title thumb
    meta=$(tiktok_meta "$url")
    title=$(echo "$meta" | sed -n '1p')
    thumb=$(echo "$meta" | sed -n '2p')
    [ -z "$title" ] && title="TikTok @${handle} (${video_id})"
    process_video "$video_id" "$title" "$url" "$thumb"
}

process_video() {
    local video_id="$1"
    local title="$2"
    local url="${3:-https://www.youtube.com/watch?v=$video_id}"
    local thumb_url="${4:-https://img.youtube.com/vi/${video_id}/mqdefault.jpg}"

    log "Processing: $title ($url)"

    local audio_file="$TMPDIR/${video_id}.mp3"
    log "  Downloading audio..."
    local yt_extra=()
    case "$url" in
        *://tiktok.com/*|*://*.tiktok.com/*) yt_extra=(--proxy "") ;;
    esac
    if ! yt-dlp "${yt_extra[@]}" --no-check-certificate \
        --remote-components ejs:github -x --audio-format mp3 \
        -o "$audio_file" "$url" 2>&1 | tail -3; then
        log "  ERROR: yt-dlp download failed"
        return 1
    fi

    if [ ! -f "$audio_file" ]; then
        log "  ERROR: Audio file not found after download"
        return 1
    fi
    log "  Audio downloaded: $(du -h "$audio_file" | cut -f1)"

    local file_size
    file_size=$(stat -c%s "$audio_file")
    local transcript_id

    if [ "$file_size" -gt 500000 ]; then
        log "  Chunked transcription ($(du -h "$audio_file" | cut -f1))..."
        local chunk_dir="$TMPDIR/chunks_${video_id}"
        mkdir -p "$chunk_dir"
        ffmpeg -i "$audio_file" -f segment -segment_time 60 -ac 1 -ab 24k -ar 16000 \
            "$chunk_dir/chunk_%03d.mp3" -y -loglevel error
        rm -f "$audio_file"

        local combined_text=""
        local chunk_count=0
        for chunk in "$chunk_dir"/chunk_*.mp3; do
            [ -f "$chunk" ] || continue
            chunk_count=$((chunk_count + 1))
            log "    Transcribing chunk $chunk_count ($(du -h "$chunk" | cut -f1))..."
            local chunk_result
            chunk_result=$(api_call POST /api/whisper --max-time 45 -F "audio=@${chunk};type=audio/mpeg")
            local chunk_text
            chunk_text=$(echo "$chunk_result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('text',''))" 2>/dev/null)
            if [ -z "$chunk_text" ]; then
                log "    WARNING: Chunk $chunk_count failed: $chunk_result"
                continue
            fi
            combined_text="${combined_text} ${chunk_text}"
        done
        rm -rf "$chunk_dir"

        if [ -z "$combined_text" ]; then
            log "  ERROR: All chunks failed"
            return 1
        fi
        log "  Transcribed $chunk_count chunks"

        local combined_file="$TMPDIR/combined_${video_id}.txt"
        echo "$combined_text" > "$combined_file"
        local title_file="$TMPDIR/title_${video_id}.txt"
        echo "$title" > "$title_file"
        local upload_result
        upload_result=$(COMBINED_FILE="$combined_file" TITLE_FILE="$title_file" VIDEO_URL="$url" TODAY_DATE="$TODAY" python3 -c '
import json, os
with open(os.environ["COMBINED_FILE"], encoding="utf-8") as f: text = f.read().strip()
with open(os.environ["TITLE_FILE"], encoding="utf-8") as f: title = f.read().strip()
url, date = os.environ["VIDEO_URL"], os.environ["TODAY_DATE"]
md = f"# {title}\n\n**Source:** {url}\n**Date:** {date}\n**Type:** Video Transcription\n\n---\n\n## Full Transcript\n\n{text}\n\n---\n\n*Transcribed with Cloudflare Workers AI (chunked)*\n"
print(json.dumps({"url": url, "title": title, "markdown_content": md}))
' | api_call POST /api/transcribe -H "Content-Type: application/json" -d @-)
        rm -f "$combined_file" "$title_file"

        transcript_id=$(echo "$upload_result" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
        if [ -z "$transcript_id" ]; then
            log "  ERROR: Combined upload failed. Response: $upload_result"
            return 1
        fi
    else
        log "  Uploading audio for transcription..."
        local upload_result
        upload_result=$(api_call POST /api/transcribe \
            -F "audio=@${audio_file};type=audio/mpeg" \
            -F "url=$url" \
            -F "title=$title")

        transcript_id=$(echo "$upload_result" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
        if [ -z "$transcript_id" ]; then
            log "  ERROR: Upload/transcription failed. Response: $upload_result"
            return 1
        fi
        rm -f "$audio_file"
    fi
    log "  Transcribed and uploaded as #$transcript_id"

    log "  Analyzing with Cloudflare Workers AI..."
    local analyze_result
    analyze_result=$(api_call POST "/api/transcripts/$transcript_id/analyze" --max-time 240)
    if echo "$analyze_result" | grep -q '"summarized":true'; then
        local sum_wc cs_cat
        sum_wc=$(echo "$analyze_result" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'].get('word_count','?'))" 2>/dev/null)
        cs_cat=$(echo "$analyze_result" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'].get('category','unclassified'))" 2>/dev/null)
        log "  Analysis complete (word_count=$sum_wc, category=$cs_cat)"
    else
        log "  WARNING: analysis failed - raw transcript stands, use the dashboard Summarize button. Response: $analyze_result"
        if [ "${REQUIRE_ANALYZE:-0}" = "1" ]; then
            log "  ERROR: analysis required (REQUIRE_ANALYZE=1) but failed"
            return 1
        fi
    fi

    local cs_url="https://chromescribe.yeoux.net/transcript.html?id=$transcript_id"
    send_telegram "$(printf '📝 <b>New transcript</b>\n<b>%s</b>\n<a href="%s">View in ChromeScribe</a>' "$title" "$cs_url")" "$thumb_url"

    log "  Telegram sent: $cs_url"
    log "  Done: $title"
}


TODAY=$(date +%Y-%m-%d)
FORCE_VIDEO=""
FORCE_TITLE=""

if [ "${1:-}" = "--force" ] && [ -n "${2:-}" ]; then
    FORCE_VIDEO="$2"
    FORCE_TITLE="${3:-Manual run}"
    log "Force mode: processing video $FORCE_VIDEO"
fi

touch "$PROCESSED_FILE"

if [ -n "$FORCE_VIDEO" ]; then
    if [[ "$FORCE_VIDEO" == *tiktok.com/@* ]]; then
        tt_vid=$(echo "$FORCE_VIDEO" | sed -n 's#.*/video/\([0-9]\+\).*#\1#p')
        tt_handle=$(echo "$FORCE_VIDEO" | sed -n 's#.*tiktok.com/@\([^/?]*\).*#\1#p')
        if [ -n "$tt_vid" ] && [ -n "$tt_handle" ]; then
            if process_tiktok_video "$tt_vid" "$tt_handle"; then
                echo "tiktok:${tt_vid}" >> "$PROCESSED_FILE"
            else
                log "  FAILED: $FORCE_VIDEO - not marking as processed"
                exit 1
            fi
            exit 0
        fi
        log "  ERROR: Could not parse TikTok URL: $FORCE_VIDEO"
        exit 1
    fi
    if process_video "$FORCE_VIDEO" "$FORCE_TITLE"; then
        echo "$FORCE_VIDEO" >> "$PROCESSED_FILE"
    else
        log "  FAILED: $FORCE_VIDEO - not marking as processed"
        exit 1
    fi
    exit 0
fi

if api_call GET "/api/channels?active=1" --fail --max-time 30 | python3 -c '
import json, re, sys
try:
    payload = json.load(sys.stdin)
    rows = payload["data"]
    if payload.get("success") is not True or not isinstance(rows, list):
        raise ValueError("Invalid channels response")
    lines = []
    for row in rows:
        platform, channel_id = row["platform"], row["id"]
        if not ((platform == "youtube" and re.fullmatch(r"UC[A-Za-z0-9_-]{22}", channel_id)) or
                (platform == "tiktok" and re.fullmatch(r"tiktok:@[A-Za-z0-9_.]{1,24}", channel_id))):
            raise ValueError("Invalid channel")
        if row.get("paused", 0):
            continue
        label = row["name"] if platform == "tiktok" else row["handle"]
        label = " ".join(label.splitlines())
        lines.append(f"{channel_id} # {label}")
    print("\n".join(lines), end="\n" if lines else "")
except (ValueError, KeyError, TypeError, AttributeError):
    sys.exit(1)
' > "$TMPDIR/channels.txt"; then
    CHANNELS_FILE="$TMPDIR/channels.txt"
else
    log "WARNING: channel API unavailable or invalid; using channels.txt"
fi

log "Checking channels for new videos ($TODAY)..."

NEW_COUNT=0
while IFS= read -r line; do
    line=$(echo "$line" | sed 's/#.*//' | xargs)
    [ -z "$line" ] && continue

    channel_id="$line"

    if [[ "$channel_id" == tiktok:* ]]; then
        handle="${channel_id#tiktok:}"
        handle="${handle#@}"
        log "Checking TikTok channel: @${handle}"

        SEED_FILE="$SCRIPT_DIR/.seeded_tiktok_${handle}"
        if [ ! -f "$SEED_FILE" ]; then
            TT_LIST=$(get_tiktok_videos "$handle")
            TT_COUNT=$(echo "$TT_LIST" | grep -cE '^[0-9]{15,21}$')
            if [ "$TT_COUNT" -lt 10 ]; then
                log "  WARNING: got only $TT_COUNT video(s) for @${handle} - waiting for a full listing before seeding (nothing processed yet)"
                continue
            fi
            while IFS= read -r video_id; do
                [ -n "$video_id" ] && echo "tiktok:${video_id}" >> "$PROCESSED_FILE"
            done <<< "$TT_LIST"
            touch "$SEED_FILE"
            log "  Seeded @${handle} ($TT_COUNT videos) - backlog marked processed, watching for new videos"
            continue
        fi

        tt_new=0
        while IFS= read -r video_id; do
            [ -z "$video_id" ] && continue

            if grep -qF "tiktok:${video_id}" "$PROCESSED_FILE"; then
                log "  Already processed: $video_id"
                continue
            fi

            if [ "$tt_new" -ge 5 ]; then
                log "  Cap reached (5/run) - $video_id deferred to next run"
                break
            fi

            if process_tiktok_video "$video_id" "$handle"; then
                echo "tiktok:${video_id}" >> "$PROCESSED_FILE"
                NEW_COUNT=$((NEW_COUNT + 1))
                tt_new=$((tt_new + 1))
            else
                log "  FAILED: $video_id - not marking as processed, will retry next run"
            fi
        done < <(get_tiktok_videos "$handle")
        continue
    fi

    log "Checking channel: $channel_id"

    while IFS=$'\t' read -r video_id title; do
        [ -z "$video_id" ] && continue

        if grep -qF "$video_id" "$PROCESSED_FILE"; then
            log "  Already processed: $video_id ($title)"
            continue
        fi

        if is_youtube_short "$video_id"; then
            log "  Skipping Short: $video_id ($title)"
            continue
        fi

        if process_video "$video_id" "$title"; then
            echo "$video_id" >> "$PROCESSED_FILE"
            NEW_COUNT=$((NEW_COUNT + 1))
        else
            log "  FAILED: $video_id - not marking as processed, will retry next run"
        fi

    done < <(get_todays_videos "$channel_id" "$TODAY")

done < "$CHANNELS_FILE"

log "Done. Processed $NEW_COUNT new video(s) today."
