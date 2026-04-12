#!/bin/bash
# Re-classify all transcripts in a too-broad source category into narrower ones.
# Usage: ./refine_category.sh "AI Tools" [--dry-run]
#
# How it works:
# - Fetches all transcripts whose category == SOURCE_CATEGORY
# - For each, asks pi to classify with SOURCE_CATEGORY explicitly forbidden
# - PUTs the new (narrower) classification

set -uo pipefail

SOURCE_CATEGORY="${1:-}"
DRY_RUN=0
if [ "${2:-}" = "--dry-run" ]; then DRY_RUN=1; fi

if [ -z "$SOURCE_CATEGORY" ]; then
    echo "Usage: $0 \"Source Category\" [--dry-run]"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMPDIR="$(mktemp -d /tmp/chromescribe-refine.XXXXXX)"
DASHBOARD_URL="https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev"

export PATH="$HOME/.local/bin:$HOME/.deno/bin:$HOME/.npm-global/bin:$PATH"

CF_ACCESS_ID="${CF_ACCESS_CLIENT_ID:-REMOVED_OLD_KEY}"
CF_ACCESS_SECRET="${CF_ACCESS_CLIENT_SECRET:-REMOVED_OLD_KEY}"

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

log() { echo "[$(date '+%H:%M:%S')] $*"; }

api_call() {
    local method="$1" path="$2"
    shift 2
    curl -s -L -X "$method" \
        -H "CF-Access-Client-Id: $CF_ACCESS_ID" \
        -H "CF-Access-Client-Secret: $CF_ACCESS_SECRET" \
        -c /tmp/cf-cookies-chromescribe.txt \
        -b /tmp/cf-cookies-chromescribe.txt \
        "$@" \
        "${DASHBOARD_URL}${path}"
}

log "Fetching all transcripts..."
all_json="$TMPDIR/all.json"
api_call GET /api/transcripts > "$all_json"

# IDs to refine
python3 -c "
import json
for t in json.load(open('$all_json'))['data']:
    if (t.get('category') or '').strip() == '$SOURCE_CATEGORY':
        print(t['id'])
" > "$TMPDIR/ids.txt"

to_process=$(wc -l < "$TMPDIR/ids.txt")
log "Found $to_process transcripts in category '$SOURCE_CATEGORY'"

if [ "$DRY_RUN" = "1" ]; then
    log "DRY RUN — exiting before classification"
    exit 0
fi

count=0
failed=0

while IFS= read -r id; do
    count=$((count + 1))

    title=$(python3 -c "
import json
for t in json.load(open('$all_json'))['data']:
    if t['id'] == $id:
        print(t['title'])
        break
")

    log "[$count/$to_process] Refining #$id: $title"

    content_file="$TMPDIR/content_${id}.txt"
    api_call GET "/api/transcript/$id/content" > "$content_file"

    if [ ! -s "$content_file" ]; then
        log "  SKIP: empty content"
        failed=$((failed + 1))
        continue
    fi

    # Existing non-AI-Tools categories for reuse hint
    existing_cats=$(api_call GET /api/categories 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin).get('data', [])
    cats = [c['category'] for c in data if c.get('category') and c['category'] != '$SOURCE_CATEGORY']
    print(', '.join(cats) if cats else '(none yet)')
except: print('(none yet)')
")

    classify_file="$TMPDIR/classify_${id}.json"

    pi --provider minimax --model MiniMax-M2.7-highspeed --no-session < /dev/null \
      "Read the transcript at '$content_file' and classify it into a NARROW primary category.

Write EXACTLY this JSON (and nothing else) to '$classify_file':

{\"category\": \"<ONE short, narrow category, 1-3 words>\", \"tags\": [\"<tag1>\", \"<tag2>\", \"<tag3>\", \"<tag4>\", \"<tag5>\"]}

CRITICAL RULES:
- FORBIDDEN category: '$SOURCE_CATEGORY' — DO NOT use this. It is too broad.
- You MUST pick something more specific.
- PREFER reusing one of these existing categories if it fits: $existing_cats
- Only invent a new one if none fit. Keep it narrow and specific.

Examples of GOOD narrow primary categories for AI-related content:
- 'Claude Code' (tutorials/tips specifically about Anthropic's Claude Code CLI)
- 'AI Agents' (agentic systems, multi-agent orchestration)
- 'AI Marketing' (using AI for marketing, growth, SEO, content generation)
- 'AI Coding' (AI-assisted coding that isn't Claude Code specific — Cursor, Copilot, Windsurf)
- 'Prompt Engineering' (prompt design, context engineering, prompt caching)
- 'Open Source AI' (Gemma, Llama, Mistral, local LLMs, Ollama)
- 'AI News' (announcements, releases, industry news)
- 'RAG' (retrieval-augmented generation, vector DBs, knowledge bases)
- 'AI Tutorials' (generic how-to with AI, setup guides)
- 'Vibe Coding' (no-code / low-code AI building, rapid prototyping)

Tag rules:
- 3-5 specific topical tags
- Lowercase, short (1-3 words each), no hashtags

STEPS:
1. Read '$content_file'
2. Write the JSON to '$classify_file'
3. Exit immediately." 2>&1 | tail -3

    if [ ! -f "$classify_file" ]; then
        log "  FAIL: pi did not produce classify.json"
        failed=$((failed + 1))
        continue
    fi

    payload=$(python3 -c "
import json
try:
    with open('$classify_file') as f: c = json.load(f)
    new_cat = (c.get('category') or '').strip()
    # Safety: never accept the forbidden category back
    if new_cat == '$SOURCE_CATEGORY' or not new_cat:
        print('')
    else:
        out = {'category': new_cat}
        if isinstance(c.get('tags'), list): out['tags'] = c['tags']
        print(json.dumps(out))
except: print('')
" 2>/dev/null)

    if [ -z "$payload" ]; then
        log "  FAIL: invalid or forbidden category in response"
        failed=$((failed + 1))
        continue
    fi

    api_call PUT "/api/transcripts/$id" -H "Content-Type: application/json" -d "$payload" > /dev/null
    log "  OK: $payload"

done < "$TMPDIR/ids.txt"

log "Done. Refined $((count - failed))/$count, failed $failed"
