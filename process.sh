#!/bin/bash
# ChromeScribe processor
# Handles both video (YouTube/TikTok) and article URLs.
# Phase 1: extract raw content + upload (reliable, no AI)
# Phase 2: Pi summarizes + updates dashboard entry (AI, best-effort)
# Usage: ./process.sh <url>

URL="$1"
if [ -z "$URL" ]; then
    echo "Usage: ./process.sh <url>"
    exit 1
fi

cd "$(dirname "$0")"

echo "=== ChromeScribe: Processing $URL ==="

is_video() {
    echo "$1" | grep -qiE "(youtube\.com|youtu\.be|tiktok\.com)"
}

DASHBOARD_BASE="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"

if is_video "$URL"; then
    # ---------- VIDEO FLOW (Cloudflare Workers AI Whisper) ----------
    echo ">>> Phase 1: Downloading audio + transcribing via Cloudflare..."

    CF_ACCESS_ID="${CF_ACCESS_CLIENT_ID:-REMOVED_OLD_KEY}"
    CF_ACCESS_SECRET="${CF_ACCESS_CLIENT_SECRET:-REMOVED_OLD_KEY}"

    TS=$(date +%s)
    TMPDIR="$(mktemp -d "/tmp/chromescribe.${TS}.XXXX")"
    trap 'rm -rf "$TMPDIR"' EXIT

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
            "${DASHBOARD_BASE}${path}"
    }

    AUDIO_FILE="$TMPDIR/audio.mp3"
    if ! yt-dlp -x --audio-format mp3 -o "$AUDIO_FILE" "$URL" 2>&1 | tail -3; then
        echo ">>> ERROR: yt-dlp failed"
        exit 1
    fi
    if [ ! -s "$AUDIO_FILE" ]; then
        echo ">>> ERROR: yt-dlp produced no audio at $AUDIO_FILE"
        exit 1
    fi
    echo ">>> Audio downloaded: $(du -h "$AUDIO_FILE" | cut -f1)"

    FILE_SIZE=$(stat -c%s "$AUDIO_FILE")
    TRANSCRIPT_ID=""
    TRANSCRIPT_TITLE=""

    if [ "$FILE_SIZE" -le 500000 ]; then
        echo ">>> Small file — uploading directly for transcription..."
        UPLOAD_RESULT=$(api_call POST /api/transcribe \
            -F "audio=@${AUDIO_FILE};type=audio/mpeg" \
            -F "url=$URL")
        TRANSCRIPT_ID=$(echo "$UPLOAD_RESULT" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
        TRANSCRIPT_TITLE=$(echo "$UPLOAD_RESULT" | python -c "import sys,json; print(json.load(sys.stdin).get('title',''))" 2>/dev/null)
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
            CHUNK_RESULT=$(api_call POST /api/whisper --max-time 60 -F "audio=@${chunk};type=audio/mpeg")
            CHUNK_TEXT=$(echo "$CHUNK_RESULT" | python -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('text',''))" 2>/dev/null)
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
        TEXT_FILE="$TEXT_FILE" URL="$URL" TODAY="$TODAY" python -c '
import json, os
with open(os.environ["TEXT_FILE"]) as f: text = f.read().strip()
url, today = os.environ["URL"], os.environ["TODAY"]
md = f"# Video Transcript\n\n**Source:** {url}\n**Date:** {today}\n**Type:** Video Transcription\n\n---\n\n## Full Transcript\n\n{text}\n\n---\n\n*Transcribed with Cloudflare Workers AI (chunked)*\n"
print(json.dumps({"url": url, "markdown_content": md}))
' > "$MD_FILE"

        UPLOAD_RESULT=$(api_call POST /api/transcribe -H "Content-Type: application/json" -d @"$MD_FILE")
        TRANSCRIPT_ID=$(echo "$UPLOAD_RESULT" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
        TRANSCRIPT_TITLE=$(echo "$UPLOAD_RESULT" | python -c "import sys,json; print(json.load(sys.stdin).get('title',''))" 2>/dev/null)
        if [ -z "$TRANSCRIPT_ID" ]; then
            echo ">>> ERROR: Combined upload failed. Response: $UPLOAD_RESULT"
            exit 1
        fi
    fi

    echo ">>> Phase 1 complete! Transcript #$TRANSCRIPT_ID — $TRANSCRIPT_TITLE"

    DASHBOARD_URL="$DASHBOARD_BASE/transcript.html?id=${TRANSCRIPT_ID}"
    echo ">>> Opening $DASHBOARD_URL"
    cmd.exe /c start msedge "$DASHBOARD_URL" 2>/dev/null &

    echo ">>> Phase 2: Generating AI summary + classification with pi..."

    TRANSCRIPT_FILE="$TMPDIR/transcript_${TRANSCRIPT_ID}.txt"
    api_call GET "/api/transcript/$TRANSCRIPT_ID/content" > "$TRANSCRIPT_FILE"
    if [ ! -s "$TRANSCRIPT_FILE" ]; then
        echo ">>> WARNING: Could not fetch transcript content for pi"
        echo "=== Done ==="
        exit 0
    fi
    echo ">>> Transcript fetched: $(wc -c < "$TRANSCRIPT_FILE") bytes"

    EXISTING_CATS=$(api_call GET /api/categories 2>/dev/null | python -c "
import sys, json
try:
    data = json.load(sys.stdin).get('data', [])
    cats = [c['category'] for c in data if c.get('category')]
    print(', '.join(cats) if cats else '(none yet)')
except: print('(none yet)')
" 2>/dev/null)
    echo ">>> Existing categories: $EXISTING_CATS"

    SUMMARY_FILE="$TMPDIR/summary_${TRANSCRIPT_ID}.md"
    CLASSIFY_FILE="$TMPDIR/classify_${TRANSCRIPT_ID}.json"

    UPDATE_HELPER="$TMPDIR/update.sh"
    cat > "$UPDATE_HELPER" << 'UPDATEEOF'
#!/bin/bash
SUMMARY_FILE="$1"
TITLE="$2"
UPDATEEOF
    cat >> "$UPDATE_HELPER" << UPDATEEOF
PAYLOAD=\$(python -c "import json; print(json.dumps({'markdown_content': open('\$SUMMARY_FILE').read(), 'title': '\$TITLE'}))")
curl -s -L -X PUT \\
    -H "CF-Access-Client-Id: $CF_ACCESS_ID" \\
    -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET" \\
    -H "Content-Type: application/json" \\
    -c /tmp/cf-cookies-chromescribe.txt \\
    -b /tmp/cf-cookies-chromescribe.txt \\
    -d "\$PAYLOAD" \\
    "${DASHBOARD_BASE}/api/transcripts/${TRANSCRIPT_ID}"
UPDATEEOF
    chmod +x "$UPDATE_HELPER"

    TODAY_DATE=$(date +%Y-%m-%d)

    pi --provider minimax --model MiniMax-M2.7-highspeed --no-session < /dev/null \
      "You are a content summarizer and classifier. Read the transcript file '$TRANSCRIPT_FILE' and produce TWO output files.

=== FILE 1: '$SUMMARY_FILE' ===

# $TRANSCRIPT_TITLE

**Source:** $URL
**Date:** $TODAY_DATE
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

=== FILE 2: '$CLASSIFY_FILE' ===

Classify the content. Write EXACTLY this JSON (and nothing else) to the file:

{\"category\": \"<ONE short category, 1-3 words>\", \"tags\": [\"<tag1>\", \"<tag2>\", \"<tag3>\", \"<tag4>\", \"<tag5>\"]}

Category rules:
- PREFER reusing an existing category from this list if it fits: $EXISTING_CATS
- Only invent a new one if none fit. Keep it short (1-3 words), use Title Case.
- Categories should be broad enough to group multiple videos.

Tag rules:
- 3-5 specific topical tags (people, tools, techniques, products mentioned)
- Lowercase, short (1-3 words each), no hashtags

IMPORTANT STEPS — do them in order, then exit:
1. Read '$TRANSCRIPT_FILE' using cat
2. Write the structured markdown to '$SUMMARY_FILE'
3. Write the classification JSON to '$CLASSIFY_FILE'
4. Upload summary by running: bash $UPDATE_HELPER '$SUMMARY_FILE' '$TRANSCRIPT_TITLE'
5. Exit immediately. No questions. No further actions." 2>&1 | tail -5

    echo ">>> Pi agent finished"

    if [ -f "$CLASSIFY_FILE" ]; then
        echo ">>> Uploading classification..."
        CLASSIFY_PAYLOAD=$(CLASSIFY_FILE="$CLASSIFY_FILE" python -c "
import json, os
try:
    with open(os.environ['CLASSIFY_FILE']) as f: c = json.load(f)
    out = {}
    if c.get('category'): out['category'] = c['category']
    if isinstance(c.get('tags'), list): out['tags'] = c['tags']
    print(json.dumps(out))
except Exception as e:
    print('')
" 2>/dev/null)
        if [ -n "$CLASSIFY_PAYLOAD" ] && [ "$CLASSIFY_PAYLOAD" != "{}" ]; then
            api_call PUT "/api/transcripts/$TRANSCRIPT_ID" -H "Content-Type: application/json" -d "$CLASSIFY_PAYLOAD" > /dev/null
            echo ">>> Classification uploaded: $CLASSIFY_PAYLOAD"
        else
            echo ">>> WARNING: classify.json invalid or empty"
        fi
    else
        echo ">>> WARNING: pi did not produce classify.json"
    fi

    echo "=== Done ==="
else
    # ---------- ARTICLE FLOW ----------
    echo ">>> Article detected — extracting via Jina Reader..."

    ARTICLE_FILE="article_$(date +%s).md"
    curl -sL --max-time 45 "https://r.jina.ai/$URL" > "$ARTICLE_FILE"

    if [ ! -s "$ARTICLE_FILE" ] || [ "$(wc -c < "$ARTICLE_FILE")" -lt 200 ]; then
        echo ">>> ERROR: Jina Reader returned no/minimal content. Site may block scraping."
        rm -f "$ARTICLE_FILE"
        exit 1
    fi
    WORDS=$(wc -w < "$ARTICLE_FILE")
    echo ">>> Extracted $WORDS words -> $ARTICLE_FILE"

    echo ">>> Uploading raw article to dashboard..."
    UPLOAD_RESULT=$(python upload_article.py "$URL" "$ARTICLE_FILE")
    echo "$UPLOAD_RESULT"

    TRANSCRIPT_ID=$(echo "$UPLOAD_RESULT" | python -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
    if [ -z "$TRANSCRIPT_ID" ]; then
        echo ">>> Upload failed or already exists. Skipping Phase 2."
        exit 1
    fi
    echo ">>> Phase 1 complete! Article #$TRANSCRIPT_ID on dashboard."

    DASHBOARD_URL="$DASHBOARD_BASE/transcript.html?id=${TRANSCRIPT_ID}"
    echo ">>> Opening $DASHBOARD_URL"
    cmd.exe /c start msedge "$DASHBOARD_URL" 2>/dev/null &

    echo ">>> Phase 2: Generating AI summary with Pi..."
    pi --provider minimax --model MiniMax-M2.5-highspeed --no-session \
      "You are a content summarizer. Read the article file '$ARTICLE_FILE' and create a structured markdown document.

Write the output to a file called 'output/summary_${TRANSCRIPT_ID}.md' with this EXACT format:

# <Title of the article>

**Source:** $URL
**Date:** $(date +%Y-%m-%d)
**Type:** Article

---

## TL;DR

<3-5 bullet points with key takeaways. Be specific — names, numbers, claims, quotes.>

---

## The Article

<800-1500 word web summary using pyramid principle. Lead with the most important insight. Short paragraphs, bold key phrases, subheadings every 2-3 paragraphs. Do NOT copy the original verbatim — synthesize and reorganize by importance.>

---

## Full Article

<The full original article text from '$ARTICLE_FILE', cleaned up for readability. Preserve paragraph breaks. Do not add or remove content.>

IMPORTANT:
1. First read the file '$ARTICLE_FILE' using bash
2. Write the output to 'output/summary_${TRANSCRIPT_ID}.md'
3. Then run: python update_transcript.py $TRANSCRIPT_ID output/summary_${TRANSCRIPT_ID}.md \"<title>\"
   Replace <title> with the actual article title you extracted."

    echo "=== Done ==="
fi
