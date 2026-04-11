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
export PATH="$HOME/.deno/bin:$HOME/.npm-global/bin:$PATH"
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
    local today="$2"
    python3 -c "
import urllib.request, re, sys
try:
    rss = urllib.request.urlopen('https://www.youtube.com/feeds/videos.xml?channel_id=$channel_id').read().decode()
except Exception as e:
    print(f'RSS fetch error: {e}', file=sys.stderr)
    sys.exit(1)
entries = re.findall(r'<entry>(.*?)</entry>', rss, re.DOTALL)
for e in entries:
    vid = re.search(r'<yt:videoId>([^<]+)', e)
    title = re.search(r'<title>([^<]+)', e)
    pub = re.search(r'<published>([^<]+)', e)
    if vid and pub and pub.group(1).startswith('$today'):
        print(f'{vid.group(1)}\t{title.group(1) if title else \"Unknown\"}')
"
}

process_video() {
    local video_id="$1"
    local title="$2"
    local url="https://www.youtube.com/watch?v=$video_id"

    log "Processing: $title ($url)"

    # Skip Shorts (< 120 seconds) — only process longform videos
    local duration
    duration=$(yt-dlp --cookies-from-browser chrome --no-check-certificate \
        --remote-components ejs:github --print duration "$url" 2>/dev/null | head -1)
    if [ -n "$duration" ] && [ "$duration" -lt 120 ] 2>/dev/null; then
        log "  Skipping Short (${duration}s < 120s)"
        return 0
    fi

    # Step 1: Download audio
    local audio_file="$TMPDIR/${video_id}.mp3"
    log "  Downloading audio..."
    if ! yt-dlp --cookies-from-browser chrome --no-check-certificate \
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

    # Compress if >2MB (CF AI Whisper has strict size limit) — mono 24kbps 16kHz is fine for speech
    local file_size
    file_size=$(stat -c%s "$audio_file")
    if [ "$file_size" -gt 2000000 ]; then
        log "  Compressing audio ($(du -h "$audio_file" | cut -f1) > 2MB limit)..."
        local compressed="$TMPDIR/${video_id}_compressed.mp3"
        ffmpeg -i "$audio_file" -ac 1 -ab 24k -ar 16000 "$compressed" -y -loglevel error
        rm -f "$audio_file"
        mv "$compressed" "$audio_file"
        log "  Compressed to: $(du -h "$audio_file" | cut -f1)"
    fi

    # Step 2: Transcribe audio
    local file_size_after
    file_size_after=$(stat -c%s "$audio_file")
    local transcript_id

    if [ "$file_size_after" -gt 4000000 ]; then
        # Large file: split into 1-min chunks, transcribe each via /api/whisper, combine
        # (CF Workers have 30s timeout — 1 min of audio transcribes in ~10-15s)
        log "  Large file ($(du -h "$audio_file" | cut -f1)) — chunked transcription..."
        local chunk_dir="$TMPDIR/chunks_${video_id}"
        mkdir -p "$chunk_dir"
        ffmpeg -i "$audio_file" -f segment -segment_time 60 -ac 1 -ab 24k -ar 16000 \
            "$chunk_dir/chunk_%03d.mp3" -y -loglevel error

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
        rm -f "$audio_file"

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

    # Step 3: Fetch transcript text for pi to summarize
    log "  Fetching transcript content..."
    local transcript_file="$TMPDIR/transcript_${transcript_id}.txt"
    api_call GET "/api/transcript/$transcript_id/content" > "$transcript_file"

    if [ ! -s "$transcript_file" ]; then
        log "  WARNING: Could not fetch transcript content"
    else
        log "  Transcript fetched: $(wc -c < "$transcript_file") bytes"
    fi

    # Step 4: Generate AI summary with pi (non-interactive, auto-exits)
    log "  Generating summary with pi..."
    local summary_file="$TMPDIR/summary_${transcript_id}.md"

    # Write the update helper script (uses curl, avoids Python urllib CF Access issue)
    local update_helper="$TMPDIR/update.sh"
    cat > "$update_helper" << 'UPDATEEOF'
#!/bin/bash
# Usage: ./update.sh <summary_file> <title>
SUMMARY_FILE="$1"
TITLE="$2"
UPDATEEOF
    cat >> "$update_helper" << UPDATEEOF
PAYLOAD=\$(python3 -c "import json; print(json.dumps({'markdown_content': open('\$SUMMARY_FILE').read(), 'title': '\$TITLE'}))")
curl -s -L -X PUT \\
    -H "CF-Access-Client-Id: $CF_ACCESS_ID" \\
    -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET" \\
    -H "Content-Type: application/json" \\
    -c /tmp/cf-cookies-chromescribe.txt \\
    -b /tmp/cf-cookies-chromescribe.txt \\
    -d "\$PAYLOAD" \\
    "${DASHBOARD_URL}/api/transcripts/${transcript_id}"
UPDATEEOF
    chmod +x "$update_helper"

    pi --provider minimax --model MiniMax-M2.7-highspeed --no-session \
      "You are a content summarizer. Read the transcript file '$transcript_file' and create a structured markdown document.

Write the output to '$summary_file' with this EXACT format:

# $title

**Source:** $url
**Date:** $(date +%Y-%m-%d)
**Type:** Video Transcription

---

## TL;DR

<3-5 bullet points with key takeaways. Be specific — names, numbers, claims.>

---

## The Article

<800-1500 word web article using pyramid principle. Lead with the most important insight. Short paragraphs, bold key phrases, subheadings every 2-3 paragraphs.>

---

## Full Transcript

<details>
<summary>Click to expand full transcript</summary>

<Clean transcript text from the file. Remove any markdown headers or metadata — just the spoken words.>

</details>

IMPORTANT STEPS — do them in order, then exit:
1. Read '$transcript_file' using cat
2. Write the structured markdown to '$summary_file'
3. Upload by running: bash $update_helper '$summary_file' '$title'
4. Exit immediately. No questions. No further actions." 2>&1 | tail -5

    log "  Pi agent finished"

    # Step 5: Send Telegram notification with ChromeScribe URL + thumbnail
    local cs_url="$DASHBOARD_URL/transcript.html?id=$transcript_id"
    local thumb_url="https://img.youtube.com/vi/${video_id}/mqdefault.jpg"
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
    process_video "$FORCE_VIDEO" "$FORCE_TITLE"
    echo "$FORCE_VIDEO" >> "$PROCESSED_FILE"
    exit 0
fi

log "Checking channels for new videos ($TODAY)..."

NEW_COUNT=0
while IFS= read -r line; do
    # Skip comments and empty lines
    line=$(echo "$line" | sed 's/#.*//' | xargs)
    [ -z "$line" ] && continue

    channel_id="$line"
    log "Checking channel: $channel_id"

    while IFS=$'\t' read -r video_id title; do
        [ -z "$video_id" ] && continue

        # Skip already processed
        if grep -qF "$video_id" "$PROCESSED_FILE"; then
            log "  Already processed: $video_id ($title)"
            continue
        fi

        process_video "$video_id" "$title" || log "  FAILED: $video_id — continuing with next"
        echo "$video_id" >> "$PROCESSED_FILE"
        NEW_COUNT=$((NEW_COUNT + 1))

    done < <(get_todays_videos "$channel_id" "$TODAY")

done < "$CHANNELS_FILE"

log "Done. Processed $NEW_COUNT new video(s) today."
