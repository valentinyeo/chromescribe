#!/usr/bin/env python3
"""Upload a transcript to the ChromeScribe dashboard.

Usage:
    python upload_transcript.py <url> <srt_file>

Reads the SRT file, strips timestamps, builds markdown, and POSTs to the dashboard API.
"""
import json, os, re, sys, urllib.request
from datetime import date

# Fix Windows console encoding for emoji/unicode
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# Cloudflare Zero Trust service token
CF_ACCESS_ID = os.environ.get('CF_ACCESS_CLIENT_ID', 'REMOVED_OLD_KEY')
CF_ACCESS_SECRET = os.environ.get('CF_ACCESS_CLIENT_SECRET', 'REMOVED_OLD_KEY')

if len(sys.argv) < 3:
    print("Usage: python upload_transcript.py <url> <srt_file>")
    sys.exit(1)

url = sys.argv[1]
srt_file = sys.argv[2]

with open(srt_file, 'r', encoding='utf-8') as f:
    srt = f.read()

# Strip SRT timestamps and sequence numbers to get clean text
lines = []
for line in srt.split('\n'):
    line = line.strip()
    if not line or re.match(r'^\d+$', line) or re.match(r'\d{2}:\d{2}:\d{2}', line):
        continue
    lines.append(line)
transcript = ' '.join(lines)

md = f"""# Video Transcript

**Source:** {url}
**Date:** {date.today()}
**Type:** Video Transcription

---

## Full Transcript

{transcript}
"""

payload = json.dumps({'url': url, 'markdown_content': md})

req = urllib.request.Request(
    'https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev/api/transcribe',
    data=payload.encode(),
    headers={
        'Content-Type': 'application/json',
        'User-Agent': 'ChromeScribe/1.0',
        'CF-Access-Client-Id': CF_ACCESS_ID,
        'CF-Access-Client-Secret': CF_ACCESS_SECRET,
    }
)
try:
    resp = urllib.request.urlopen(req)
    print(resp.read().decode('utf-8', errors='replace'))
except urllib.error.HTTPError as e:
    print(f"Error {e.code}: {e.read().decode('utf-8', errors='replace')}")
