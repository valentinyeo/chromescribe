#!/bin/bash
# ChromeScribe Channel Monitor
# Checks subscribed YouTube channels for today's new videos,
# transcribes them via pi agent, uploads to dashboard, notifies via Telegram.
# Usage: ./monitor.sh [--force VIDEO_ID [TITLE]]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHANNELS_FILE="$SCRIPT_DIR/channels.txt"
PROCESSED_FILE="$SCRIPT_DIR/.processed_videos"
TMPDIR="$(mktemp -d /tmp/chromescribe.XXXXXX)"
DASHBOARD_URL="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"

# Ensure deno is in PATH for yt-dlp
export PATH="$HOME/.local/bin:$HOME/.deno/bin:$HOME/.npm-global/bin:$PATH"
export DISPLAY=:0

# Telegram config (hardcoded — cron can't source .bashrc interactive-only exports)
TG_TOKEN="${TELEGRAM_TINYDICTATION_BOT_TOKEN:-8399292716:AAHKCpQAiX5GiePED-yggWz-NgdaelJRRKQ}"
TG_CHAT="${TELEGRAM_TINYDICTATION_CHAT_ID:-2068947468}"

# CF Access credentials
CF_ACCESS_ID="${CF_ACCESS_CLIENT_ID:-REMOVED_OLD_KEY}"
CF_ACCESS_SECRET="${CF_ACCESS_CLIENT_SECRET:-REMOVED_OLD_KEY}"

# Cleanup on exit — no leftovers
cleanup() {
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

# All dashboard API calls use curl (Python urllib breaks on CF Access redirects)
api_call() {
    local method="$1" path="$2"
    shift 2
    curl -s -L \
        -X "$method" \
        -H "CF-Access-Client-Id: $CF_ACCESS_ID" \
        -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET" \
        -c /tmp/cf-cookies-chromescribe.txt \
        -b /tmp/cf-cookies-chromescribe.txt \
        "$@" \
        "${DASHBOARD_URL}${path}"
}

send_telegram() {
    local msg="$1"
    local photo="${2:-}"
    if [ -n "$photo" ]; then
        # Send with thumbnail photo
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
    # `today` arg kept for backward compat but ignored — we now use a 36h window
    # so videos published shortly before midnight UTC aren't permanently skipped
    # (the .processed_videos file dedupes anything we've already handled).
    python3 -c "
import urllib.request, re, sys
from datetime import datetime, timedelta, timezone
try:
    rss = urllib.request.urlopen('https://www.youtube.com/feeds/videos.xml?channel_id=$channel_id').read().decode()
except Exception as e:
    print(f'RSS fetch error: {e}', file=sys.stderr)
    sys.exit(1)
cutoff = datetime.now(timezone.utc) - timedelta(hours=36)
entries = re.findall(r'<entry>(.*?)</entry>', rss, re.DOTALL)
for e in entries:
    vid = re.search(r'<yt:videoId>([^<]+)', e)
    title = re.search(r'<title>([^<]+)', e)
    pub = re.search(r'<published>([^<]+)', e)
    if not (vid and pub):
        continue
    try:
        pub_dt = datetime.fromisoformat(pub.group(1).replace('Z', '+00:00'))
    except ValueError:
        continue
    if pub_dt >= cutoff:
        print(f'{vid.group(1)}\t{title.group(1) if title else \"Unknown\"}')
"
}

# TikTok has no RSS. yt-dlp's profile extractor is frequently broken by TikTok
# API changes, so fall back to scraping the SSR payload of the profile page.
# Both paths return video IDs only (newest first); titles/thumbnails come from
# TikTok's oEmbed API at processing time.
get_tiktok_videos() {
    local handle="$1"
    local ids
    ids=$(yt-dlp --no-check-certificate --flat-playlist --print "%(id)s" \
        "https://www.tiktok.com/@${handle}" 2>/dev/null | grep -E '^[0-9]{15,21}$')
    if [ -n "$ids" ]; then
        echo "$ids"
        return 0
    fi
    # stderr: this function's stdout is the video-ID list
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

# Title + thumbnail for a TikTok video via public oEmbed. Prints "title\tthumb".
# TikTok blocks datacenter IPs — this only works from residential networks.
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

    # Step 1: Download audio
    local audio_file="$TMPDIR/${video_id}.mp3"
    log "  Downloading audio..."
    # Chrome cookies are only needed for YouTube (age-gated/consent); TikTok is public
    local yt_extra=()
    case "$url" in
        *tiktok.com*) ;;
        *) yt_extra=(--cookies-from-browser chrome) ;;
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

    # Step 2: Transcribe audio
    # CF AI Whisper has ~30s worker timeout — can only handle ~2 min of audio per request.
    # Files >500KB (roughly >3 min at any quality) get split into 1-min compressed chunks.
    local file_size
    file_size=$(stat -c%s "$audio_file")
    local transcript_id

    if [ "$file_size" -gt 500000 ]; then
        # Split into 1-min chunks (compressed mono 24kbps 16kHz — ~180KB/min, fine for speech)
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

        # Upload combined transcript as markdown via JSON mode
        local combined_file="$TMPDIR/combined_${video_id}.txt"
        echo "$combined_text" > "$combined_file"
        local title_file="$TMPDIR/title_${video_id}.txt"
        echo "$title" > "$title_file"
        local upload_result
        upload_result=$(COMBINED_FILE="$combined_file" TITLE_FILE="$title_file" VIDEO_URL="$url" TODAY_DATE="$TODAY" python3 -c '
import json, os
with open(os.environ["COMBINED_FILE"]) as f: text = f.read().strip()
with open(os.environ["TITLE_FILE"]) as f: title = f.read().strip()
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
        # Small file: direct upload
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

    # Step 3: Summarize and classify through Cloudflare Workers AI + AI Gateway.
    # Non-fatal on failure: the raw transcript is already uploaded and the
    # dashboard "Summarize" button is the recovery path, so we don't block.
    log "  Analyzing with Cloudflare Workers AI..."
    local analyze_result
    analyze_result=$(api_call POST "/api/transcripts/$transcript_id/analyze" --max-time 240)
    if echo "$analyze_result" | grep -q '"summarized":true'; then
        local sum_wc cs_cat
        sum_wc=$(echo "$analyze_result" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'].get('word_count','?'))" 2>/dev/null)
        cs_cat=$(echo "$analyze_result" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'].get('category','unclassified'))" 2>/dev/null)
        log "  Analysis complete (word_count=$sum_wc, category=$cs_cat)"
    else
        log "  WARNING: analysis failed — raw transcript stands, use the dashboard Summarize button. Response: $analyze_result"
        # The Android queue asks for a complete transcribe+summary, so it sets
        # REQUIRE_ANALYZE=1 and treats this as a failure. Ordinary cron monitor
        # runs leave it unset and keep the best-effort behavior above.
        if [ "${REQUIRE_ANALYZE:-0}" = "1" ]; then
            log "  ERROR: analysis required (REQUIRE_ANALYZE=1) but failed"
            return 1
        fi
    fi

    # Step 3b: Warm the read-aloud audio. Generating it on the first tap costs
    # about 90 seconds of staring at a loading button; doing it here means the
    # R2 copy is already there by the time the transcript is opened. Best
    # effort — a failure here must not fail the run, and the endpoint
    # regenerates on demand.
    log "  Warming read-aloud audio..."
    if api_call GET "/api/speak/$transcript_id" --max-time 300 --fail -o /dev/null; then
        log "  Read-aloud audio cached"
    else
        log "  WARNING: read-aloud warm-up failed — it will generate on first play"
    fi

    # Step 4: Send Telegram notification with ChromeScribe URL + thumbnail
    local cs_url="$DASHBOARD_URL/transcript.html?id=$transcript_id"
    send_telegram "$(printf '📝 <b>New transcript</b>\n<b>%s</b>\n<a href="%s">View in ChromeScribe</a>' "$title" "$cs_url")" "$thumb_url"

    log "  Telegram sent: $cs_url"
    log "  Done: $title"
}

# --- Main ---

TODAY=$(date +%Y-%m-%d)
FORCE_VIDEO=""
FORCE_TITLE=""

if [ "${1:-}" = "--force" ] && [ -n "${2:-}" ]; then
    FORCE_VIDEO="$2"
    FORCE_TITLE="${3:-Manual run}"
    log "Force mode: processing video $FORCE_VIDEO"
fi

# Ensure processed file exists
touch "$PROCESSED_FILE"

if [ -n "$FORCE_VIDEO" ]; then
    if [[ "$FORCE_VIDEO" == *tiktok.com/@* ]]; then
        tt_vid=$(echo "$FORCE_VIDEO" | sed -n 's#.*/video/\([0-9]\+\).*#\1#p')
        tt_handle=$(echo "$FORCE_VIDEO" | sed -n 's#.*tiktok.com/@\([^/?]*\).*#\1#p')
        if [ -n "$tt_vid" ] && [ -n "$tt_handle" ]; then
            if process_tiktok_video "$tt_vid" "$tt_handle"; then
                echo "tiktok:${tt_vid}" >> "$PROCESSED_FILE"
            else
                log "  FAILED: $FORCE_VIDEO — not marking as processed"
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
        log "  FAILED: $FORCE_VIDEO — not marking as processed"
        exit 1
    fi
    exit 0
fi

log "Checking channels for new videos ($TODAY)..."

NEW_COUNT=0
while IFS= read -r line; do
    # Skip comments and empty lines
    line=$(echo "$line" | sed 's/#.*//' | xargs)
    [ -z "$line" ] && continue

    channel_id="$line"

    if [[ "$channel_id" == tiktok:* ]]; then
        handle="${channel_id#tiktok:}"
        handle="${handle#@}"
        log "Checking TikTok channel: @${handle}"

        # First run: seed the current backlog as processed so we don't
        # transcribe the channel's entire history — only new videos from now on.
        # Only seed from a full listing (>= 10 ids): TikTok sometimes serves a
        # degraded page with a couple of ids, and seeding from that would later
        # treat the whole backlog as new.
        SEED_FILE="$SCRIPT_DIR/.seeded_tiktok_${handle}"
        if [ ! -f "$SEED_FILE" ]; then
            TT_LIST=$(get_tiktok_videos "$handle")
            TT_COUNT=$(echo "$TT_LIST" | grep -cE '^[0-9]{15,21}$')
            if [ "$TT_COUNT" -lt 10 ]; then
                log "  WARNING: got only $TT_COUNT video(s) for @${handle} — waiting for a full listing before seeding (nothing processed yet)"
                continue
            fi
            while IFS= read -r video_id; do
                [ -n "$video_id" ] && echo "tiktok:${video_id}" >> "$PROCESSED_FILE"
            done <<< "$TT_LIST"
            touch "$SEED_FILE"
            log "  Seeded @${handle} ($TT_COUNT videos) — backlog marked processed, watching for new videos"
            continue
        fi

        # Cap per run: a listing hiccup (e.g. a degraded page surfacing old
        # pinned videos as "new") must not trigger a transcription flood
        tt_new=0
        while IFS= read -r video_id; do
            [ -z "$video_id" ] && continue

            if grep -qF "tiktok:${video_id}" "$PROCESSED_FILE"; then
                log "  Already processed: $video_id"
                continue
            fi

            if [ "$tt_new" -ge 5 ]; then
                log "  Cap reached (5/run) — $video_id deferred to next run"
                break
            fi

            if process_tiktok_video "$video_id" "$handle"; then
                echo "tiktok:${video_id}" >> "$PROCESSED_FILE"
                NEW_COUNT=$((NEW_COUNT + 1))
                tt_new=$((tt_new + 1))
            else
                log "  FAILED: $video_id — not marking as processed, will retry next run"
            fi
        done < <(get_tiktok_videos "$handle")
        continue
    fi

    log "Checking channel: $channel_id"

    while IFS=$'\t' read -r video_id title; do
        [ -z "$video_id" ] && continue

        # Skip already processed
        if grep -qF "$video_id" "$PROCESSED_FILE"; then
            log "  Already processed: $video_id ($title)"
            continue
        fi

        if process_video "$video_id" "$title"; then
            echo "$video_id" >> "$PROCESSED_FILE"
            NEW_COUNT=$((NEW_COUNT + 1))
        else
            log "  FAILED: $video_id — not marking as processed, will retry next run"
        fi

    done < <(get_todays_videos "$channel_id" "$TODAY")

done < "$CHANNELS_FILE"

log "Done. Processed $NEW_COUNT new video(s) today."
