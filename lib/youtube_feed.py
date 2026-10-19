import argparse
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stdin.reconfigure(encoding='utf-8', errors='replace')

parser = argparse.ArgumentParser()
parser.add_argument('channel_id')
parser.add_argument('--hours', type=float, default=36)
args = parser.parse_args()

if args.channel_id == '-':
    rss = sys.stdin.read()
else:
    try:
        rss = urllib.request.urlopen(
            f'https://www.youtube.com/feeds/videos.xml?channel_id={args.channel_id}',
            timeout=30,
        ).read().decode('utf-8', 'replace')
    except Exception as e:
        print(f'RSS fetch error: {e}', file=sys.stderr)
        sys.exit(1)

cutoff = datetime.now(timezone.utc) - timedelta(hours=args.hours)
entries = re.findall(r'<entry>(.*?)</entry>', rss, re.DOTALL)
for e in entries:
    vid = re.search(r'<yt:videoId>([^<]+)', e)
    title = re.search(r'<title>([^<]+)', e)
    pub = re.search(r'<published>([^<]+)', e)
    if not (vid and pub):
        continue
    is_short = False
    for link in re.findall(r'<link\b([^>]*)>', e):
        if not re.search(r'''\brel=["']alternate["']''', link):
            continue
        href = re.search(r'''\bhref=["']([^"']+)["']''', link)
        if href and urllib.parse.urlsplit(href.group(1)).path.startswith('/shorts/'):
            is_short = True
            break
    if is_short:
        continue
    try:
        pub_dt = datetime.fromisoformat(pub.group(1).replace('Z', '+00:00'))
        if pub_dt >= cutoff:
            print(f'{vid.group(1)}\t{title.group(1) if title else "Unknown"}')
    except (ValueError, TypeError):
        continue
