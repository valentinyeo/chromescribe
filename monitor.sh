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

    # Step 2: Upload audio to dashboard (CF AI Whisper — free)
    log "  Uploading audio for transcription..."
    local upload_result
    upload_result=$(api_call POST /api/transcribe \
        -F "audio=@${audio_file};type=audio/mpeg" \
        -F "url=$url" \
        -F "title=$title")

    local transcript_id
    transcript_id=$(echo "$upload_result" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)

    if [ -z "$transcript_id" ]; then
        log "  ERROR: Upload/transcription failed. Response: $upload_result"
        return 1
    fi
    log "  Transcribed and uploaded as #$transcript_id"

    # Delete audio file immediately — no longer needed
    rm -f "$audio_file"

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
