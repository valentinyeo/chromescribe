#!/usr/bin/env python3
import json, re, sys, urllib.request
from datetime import date
from cf_access import load

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET = load()

if len(sys.argv) < 3:
    print("Usage: python upload_article.py <url> <article_md_file> [title]")
    sys.exit(1)

url = sys.argv[1]
md_file = sys.argv[2]
cli_title = sys.argv[3] if len(sys.argv) > 3 else None

with open(md_file, 'r', encoding='utf-8') as f:
    raw = f.read()

title = cli_title

jina_title = re.match(r'^\s*Title:\s*(.+?)\s*\n', raw)
if jina_title:
    if not title:
        title = jina_title.group(1).strip()
    mc = re.search(r'\nMarkdown Content:\s*\n', raw)
    if mc:
        raw = raw[mc.end():]

fm_match = re.match(r'^---\n(.*?)\n---\n', raw, re.DOTALL)
if fm_match:
    fm = fm_match.group(1)
    raw = raw[fm_match.end():]
    if not title:
        t = re.search(r'^title:\s*(.+)$', fm, re.MULTILINE)
        if t:
            title = t.group(1).strip().strip('"').strip("'")

if not title:
    h = re.search(r'^#\s+(.+)$', raw, re.MULTILINE)
    title = h.group(1).strip() if h else url

raw = re.sub(r'^\s*#\s+' + re.escape(title) + r'\s*\n+', '', raw)

article_text = raw.strip()

md = f"""# {title}

**Source:** {url}
**Date:** {date.today()}
**Type:** Article

---

## Full Article

{article_text}
"""

payload = json.dumps({'url': url, 'title': title, 'markdown_content': md})

req = urllib.request.Request(
    'https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev/api/transcribe',
    data=payload.encode(),
    headers={
        'Content-Type': 'application/json',
        'User-Agent': 'ChromeScribe/1.0',
        'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
    }
)
try:
    resp = urllib.request.urlopen(req)
    print(resp.read().decode('utf-8', errors='replace'))
except urllib.error.HTTPError as e:
    print(f"Error {e.code}: {e.read().decode('utf-8', errors='replace')}")
