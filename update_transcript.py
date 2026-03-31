#!/usr/bin/env python3
"""Update an existing transcript on the ChromeScribe dashboard.

Usage:
    python update_transcript.py <transcript_id> <markdown_file>
    python update_transcript.py <transcript_id> <markdown_file> <title>
"""
import json, sys, urllib.request

if len(sys.argv) < 3:
    print("Usage: python update_transcript.py <transcript_id> <markdown_file> [title]")
    sys.exit(1)

transcript_id = sys.argv[1]
md_file = sys.argv[2]
title = sys.argv[3] if len(sys.argv) > 3 else None

with open(md_file, 'r', encoding='utf-8') as f:
    content = f.read()

payload = {'markdown_content': content}
if title:
    payload['title'] = title

req = urllib.request.Request(
    f'https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev/api/transcripts/{transcript_id}',
    data=json.dumps(payload).encode(),
    method='PUT',
    headers={'Content-Type': 'application/json', 'User-Agent': 'ChromeScribe/1.0'}
)
try:
    resp = urllib.request.urlopen(req)
    print(resp.read().decode())
except urllib.error.HTTPError as e:
    print(f"Error {e.code}: {e.read().decode()}")
