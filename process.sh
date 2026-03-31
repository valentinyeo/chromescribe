#!/bin/bash
# ChromeScribe processor
# Phase 1: transcribe + upload raw transcript (reliable, no AI)
# Phase 2: Pi summarizes + updates dashboard entry (AI, best-effort)
# Usage: ./process.sh <url>

set -e

URL="$1"
if [ -z "$URL" ]; then
    echo "Usage: ./process.sh <url>"
    exit 1
fi

cd "$(dirname "$0")"

echo "=== ChromeScribe: Processing $URL ==="

# Phase 1: Transcribe and upload raw
echo ">>> Phase 1: Transcribing..."
transcribe "$URL"

SRT=$(ls -t *.srt | head -1)
echo ">>> Found SRT: $SRT"

echo ">>> Uploading raw transcript to dashboard..."
UPLOAD_RESULT=$(python upload_transcript.py "$URL" "$SRT")
echo "$UPLOAD_RESULT"

# Extract transcript ID from response
TRANSCRIPT_ID=$(echo "$UPLOAD_RESULT" | python -c "import sys,json; print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)

if [ -z "$TRANSCRIPT_ID" ]; then
    echo ">>> Upload failed or already exists. Skipping Phase 2."
    exit 1
fi

echo ">>> Phase 1 complete! Transcript #$TRANSCRIPT_ID on dashboard."

# Phase 2: AI summary via Pi
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
