#!/bin/bash
# ChromeScribe processor - transcribes video and uploads to dashboard
# Usage: ./process.sh <url>

set -e

URL="$1"
if [ -z "$URL" ]; then
    echo "Usage: ./process.sh <url>"
    exit 1
fi

cd "$(dirname "$0")"

echo "=== ChromeScribe: Processing $URL ==="

# Step 1: Transcribe
echo ">>> Step 1: Transcribing..."
transcribe "$URL"

# Step 2: Find the SRT file (most recent)
SRT=$(ls -t *.srt | head -1)
echo ">>> Step 2: Found SRT: $SRT"

# Step 3: Upload to dashboard
echo ">>> Step 3: Uploading to dashboard..."
python upload_transcript.py "$URL" "$SRT"

echo "=== Done ==="
