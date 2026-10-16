        TEXT_FILE="$TEXT_FILE" URL="$URL" TODAY="$TODAY" python -c '
import json, os
with open(os.environ["TEXT_FILE"]) as f: text = f.read().strip()
url, today = os.environ["URL"], os.environ["TODAY"]
md = f"# Video Transcript\n\n**Source:** {url}\n**Date:** {today}\n**Type:** Video Transcription\n\n---\n\n## Full Transcript\n\n{text}\n\n---\n\n*Transcribed with Cloudflare Workers AI (chunked)*\n"
print(json.dumps({"url": url, "markdown_content": md}))
' > "$MD_FILE"
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
