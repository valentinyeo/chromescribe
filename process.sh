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
    # ---------- VIDEO FLOW ----------
    echo ">>> Phase 1: Transcribing..."

    # Determine deterministic SRT filename from URL so we never pick up a stale file.
    # TikTok URLs need yt-dlp download first (transcribe CLI only supports YouTube + local files).
    if echo "$URL" | grep -qi "tiktok.com"; then
        echo ">>> TikTok detected — downloading audio with yt-dlp..."
        TS=$(date +%s)
        AUDIO_FILE="tiktok_${TS}.mp3"
        SRT="tiktok_${TS}.srt"
        yt-dlp -x --audio-format mp3 -o "$AUDIO_FILE" "$URL"
        rm -f "$SRT"
        transcribe -o "$SRT" "$AUDIO_FILE"
        TR_EXIT=$?
        rm -f "$AUDIO_FILE"
    else
        YT_ID=$(echo "$URL" | grep -oE '(youtube\.com/watch\?v=|youtu\.be/|youtube\.com/shorts/)[a-zA-Z0-9_-]{11}' | grep -oE '[a-zA-Z0-9_-]{11}$' | head -1)
        if [ -z "$YT_ID" ]; then
            echo ">>> ERROR: Could not extract YouTube ID from URL: $URL"
            exit 1
        fi
        SRT="youtube_${YT_ID}.srt"
        rm -f "$SRT"
        transcribe -o "$SRT" "$URL"
        TR_EXIT=$?
    fi

    if [ "$TR_EXIT" -ne 0 ] || [ ! -s "$SRT" ]; then
        echo ">>> ERROR: transcribe failed (exit=$TR_EXIT) or produced no/empty SRT at '$SRT'."
        echo ">>> Check OPENAI_API_KEY (env var or ~/.transcribe/config.json) and network."
        exit 1
    fi
    echo ">>> Found SRT: $SRT ($(wc -c < "$SRT") bytes)"

    echo ">>> Uploading raw transcript to dashboard..."
    UPLOAD_RESULT=$(python upload_transcript.py "$URL" "$SRT")
    echo "$UPLOAD_RESULT"

    TRANSCRIPT_ID=$(echo "$UPLOAD_RESULT" | python -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
    if [ -z "$TRANSCRIPT_ID" ]; then
        echo ">>> Upload failed or already exists. Skipping Phase 2."
        exit 1
    fi
    echo ">>> Phase 1 complete! Transcript #$TRANSCRIPT_ID on dashboard."

    DASHBOARD_URL="$DASHBOARD_BASE/transcript.html?id=${TRANSCRIPT_ID}"
    echo ">>> Opening $DASHBOARD_URL"
    cmd.exe /c start msedge "$DASHBOARD_URL" 2>/dev/null &

    echo ">>> Phase 2: Generating AI summary with Pi..."
    pi --provider minimax --model MiniMax-M2.5-highspeed --no-session \
      "You are a content summarizer. Read the transcript file '$SRT' and create a structured markdown document.

Write the output to a file called 'output/summary_${TRANSCRIPT_ID}.md' with this EXACT format:

# <Title of the video>

**Source:** $URL
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

<Clean transcript text from the SRT file. Remove timestamps and sequence numbers.>

</details>

IMPORTANT:
1. First read the file '$SRT' using bash
2. Write the output to 'output/summary_${TRANSCRIPT_ID}.md'
3. Then run: python update_transcript.py $TRANSCRIPT_ID output/summary_${TRANSCRIPT_ID}.md \"<title>\"
   Replace <title> with the actual video title you extracted."

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
