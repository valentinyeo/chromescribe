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
    local classify_file="$TMPDIR/classify_${transcript_id}.json"

    # Fetch existing categories to encourage reuse (avoids drift)
    local existing_cats
    existing_cats=$(api_call GET /api/categories 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin).get('data', [])
    cats = [c['category'] for c in data if c.get('category')]
    print(', '.join(cats) if cats else '(none yet)')
except: print('(none yet)')
" 2>/dev/null)
    log "  Existing categories: $existing_cats"

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

    pi --provider minimax --model MiniMax-M2.7-highspeed --no-session < /dev/null \
      "You are a content summarizer and classifier. Read the transcript file '$transcript_file' and produce TWO output files.

=== FILE 1: '$summary_file' ===

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

=== FILE 2: '$classify_file' ===

Classify the content. Write EXACTLY this JSON (and nothing else) to the file:

{\"category\": \"<ONE short category, 1-3 words>\", \"tags\": [\"<tag1>\", \"<tag2>\", \"<tag3>\", \"<tag4>\", \"<tag5>\"]}

Category rules:
- PREFER reusing an existing category from this list if it fits: $existing_cats
- Only invent a new one if none fit. Keep it short (1-3 words), use Title Case (e.g. \"AI Marketing\", \"AI Tutorials\", \"AI News\", \"AI Tools\", \"Programming\").
- Categories should be broad enough to group multiple videos — not specific to one video.

Tag rules:
- 3-5 specific topical tags (people, tools, techniques, products mentioned)
- Lowercase, short (1-3 words each), no hashtags
- Examples: \"claude code\", \"prompt caching\", \"cursor\", \"agents\", \"rag\"

IMPORTANT STEPS — do them in order, then exit:
1. Read '$transcript_file' using cat
2. Write the structured markdown to '$summary_file'
3. Write the classification JSON to '$classify_file'
4. Upload summary by running: bash $update_helper '$summary_file' '$title'
5. Exit immediately. No questions. No further actions." 2>&1 | tail -5

    log "  Pi agent finished"

    # Step 4b: Upload classification if pi produced it
    if [ -f "$classify_file" ]; then
        log "  Uploading classification..."
        local classify_payload
        classify_payload=$(python3 -c "
import json, sys
try:
    with open('$classify_file') as f: c = json.load(f)
    out = {}
    if c.get('category'): out['category'] = c['category']
    if isinstance(c.get('tags'), list): out['tags'] = c['tags']
    print(json.dumps(out))
except Exception as e:
    print('', file=sys.stderr)
    sys.exit(1)
" 2>/dev/null)
        if [ -n "$classify_payload" ] && [ "$classify_payload" != "{}" ]; then
            api_call PUT "/api/transcripts/$transcript_id" -H "Content-Type: application/json" -d "$classify_payload" > /dev/null
            log "  Classification uploaded: $classify_payload"
        else
            log "  WARNING: classify.json invalid or empty"
        fi
    else
        log "  WARNING: pi did not produce classify.json"
    fi

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
