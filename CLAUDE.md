# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

ChromeScribe is a video/article transcription platform with three components:

1. **Chrome Extension** (`extension/`) - Manifest V3 extension that sends URLs to a web terminal (`localhost:7681`) which runs `bash process.sh`. Hardcoded to Windows paths. Video URLs (YouTube/TikTok): the local script only downloads/chunks audio and uploads it; Cloudflare Workers AI performs Whisper transcription plus Gemma summary/classification through AI Gateway. Article URLs: Jina Reader extracts and uploads the page, then the Worker analyzes it.
2. **Cloudflare Worker API + Dashboard** (`dashboard/`) - TypeScript Worker serving a transcript dashboard. Uses D1 (SQLite) for metadata, R2 for SRT/markdown storage, and Cloudflare AI (Whisper) for audio transcription.
3. **Processing System Prompt** (this file, below) - Instructions for Claude Code instances that receive `process: <url>` commands from the extension.

### Data Flow

**Extension flow** (current, via `process.sh`):
```
Extension → localhost:7681 terminal → bash process.sh <url>
  if video URL (YouTube/TikTok):
    Phase 1: yt-dlp → ffmpeg chunk (>500KB) → POST /api/whisper per chunk → POST /api/transcribe (markdown JSON)
             or, for small files: POST /api/transcribe (audio multipart, Worker transcribes server-side)
    Phase 2: POST /api/transcripts/:id/analyze → Workers AI summary + classification → R2/D1
  else (article URL):
    Phase 1: Jina Reader (r.jina.ai) → upload_article.py → dashboard API
    Phase 2: pi reads article file → summary → update_transcript.py → dashboard API
```

**Claude Code flow** (manual, via `process: <url>`):
```
Claude Code runs `transcribe <url>` → .srt file
  → Claude reads .srt → writes structured markdown to output/ AND uploads to dashboard API
  → Dashboard Worker stores in D1 + R2 → serves via index.html/transcript.html
```

### Dashboard Worker (`dashboard/src/index.ts`)
- **API endpoints**: `GET /api/transcripts`, `GET /api/transcripts/:id`, `GET /api/transcript/:id/content`, `POST /api/transcribe`, `PUT /api/transcripts/:id`, `DELETE /api/transcripts/:id`, `GET /api/search?q=`, channel subscriptions: `GET /api/channels` (includes integer `paused`; `?active=1` returns only active subscriptions), `POST /api/channels {input}`, `PATCH /api/channels/:id {paused: true|false}`, `DELETE /api/channels/:id`, reports: `POST /api/reports {title, channel, topic, html}`, `GET /api/reports`, `DELETE /api/reports/:id`, and `GET /reports/:id` (sandboxed HTML, no scripts), plus the Android share queue: `POST /api/queue`, `GET /api/queue`, `PUT /api/queue/:id`
- **POST /api/transcribe** has two modes: JSON body with URL+markdown (from Claude), or multipart form with audio file (uses CF AI Whisper)
- Video ID parsing: YouTube (`youtube.com/watch`, `youtu.be/`, `/shorts/`) and TikTok (`tiktok.com/@user/video/id` → `tiktok:id`)
- Static HTML served from R2 bucket (index.html, transcript.html, settings.html, stats.html, subscriptions.html, reports.html)
- D1 database schema in `dashboard/schema.sql`; the Worker lazily creates an empty `channels` table and safely adds `paused INTEGER NOT NULL DEFAULT 0` to existing tables once per database binding per isolate. There are no seeded subscriptions; populate via `POST /api/channels` after deployment. Pausing skips monitoring without removing the subscription or existing transcripts.

## Commands

### CLI and channel lenses

`cli/chromescribe` is the Bash CLI, installed via `~/.local/bin/chromescribe` symlink.
It defaults to https://chromescribe.yeoux.net; `CHROMESCRIBE_API` overrides API calls,
not public links. Keep Access credentials in `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET`, never in files. Dependencies: curl, jq, column, Python 3;
learning additionally uses yt-dlp (RSS fallback), git, and hax with Codex access.

- Existing commands: `list [-n N] [--channel <name>] [--json]`, `search`, `get`, `cat`, `url`, `view`.
- Subscriptions: `channels [--json]`, `subscribe <url|@handle|UC id>`,
  `unsubscribe <channel>`, `pause <channel>`, `resume <channel>`.
  Selectors accept exact names/handles case-insensitively, UC IDs, and channel URLs;
  ambiguous selectors fail instead of choosing silently.
- `learn <channel> [--max N] [--no-queue]`: subscribe if needed, enumerate the newest
  30 uploads with yt-dlp or the latest 15 via RSS, check `video_id`, queue missing
  videos with `{url}`, then distill every current transcript for the channel.
  `--no-queue` never enqueues. Run learn again after the server queue drains.
- `cli/lenses.py` handles file-backed Codex map/reduce with complete transcript
  chunks, per-video notes, and incremental merging. Only transcript IDs absent
  from VIDEOS.md are fetched again. Completed notes carry source checksums so a
  failed merge can resume without repeating unchanged distillation. Empty or
  failed synthesis is not installed.
- Lenses live in the separate git repository `~/projects/channel-lenses`, under
  `lenses/<lowercase-handle>/`: VIDEOS.md, KNOWLEDGE.md, SKILL.md, and notes/.
  The CLI initializes that repository but never commits or pushes. Skills are
  symlinked as `~/.claude/skills/lens-<handle>`; a blocked symlink prints an exact
  `ln` command. `CHROMESCRIBE_LENSES` overrides the lens repository for tests.
- `lens <channel> "<topic>" [--no-publish]`: requires a built lens, ranks relevant
  citations/titles, reuses per-video evidence notes (maps source detail if missing),
  checks wording against source transcripts, follows the local
  report-page skill/template, and creates one cited HTML page. It publishes via
  `/api/reports` and prints https://chromescribe.yeoux.net/reports/<id>.
  `--no-publish` saves under the lens repository's reports/ and prints the path.
- Reports are listed at `/reports.html`. The Worker lazily creates D1's reports
  table and stores HTML in R2's `reports/<id>.html`. HTML is limited to 2 MB UTF-8.
  Its CSP allows template CSS/fonts but no scripts, frames, API connections, or forms.

Checks: `node --test cli/test/*.test.mjs` and
`cd dashboard && node --test test/*.test.mjs`.
Do not deploy as part of local verification unless explicitly authorized.

### Deploy Dashboard (REQUIRED after any `dashboard/public/` changes)
```bash
cd dashboard && ./deploy.sh
```
Or manually:
```bash
cd dashboard && wrangler r2 object put chromescribe-transcripts/index.html --file=./public/index.html --remote && wrangler r2 object put chromescribe-transcripts/transcript.html --file=./public/transcript.html --remote && wrangler deploy
```

### Deploy Worker Only (no static file changes)
```bash
cd dashboard && wrangler deploy
```

### D1 Database Operations
```bash
cd dashboard && wrangler d1 execute chromescribe-db --remote --command "SELECT * FROM transcripts ORDER BY created_at DESC LIMIT 10"
```

### Bulk Import Existing Markdown Files
```bash
cd dashboard && node import.js
```

### CI/CD
Push to `master` triggers `.github/workflows/deploy.yml` which uploads static files to R2 and deploys the Worker. Requires `CLOUDFLARE_API_TOKEN` secret.
**Local deploys don't work**: the `CLOUDFLARE_API_TOKEN` in the shell env is scoped to the Hypertask account, not Yeo UX (`7865043d…`) where chromescribe lives - any local `wrangler` R2/Worker command gets 403. Deploy by pushing to `master`.

## Key Details

- **No package.json / no build step** - Worker is deployed directly via wrangler. Queue correctness tests use Node's built-in runner: `cd dashboard && node --test test/*.test.mjs` (parser + enqueue against in-memory SQLite, plus a mocked `queue.sh` drainer failure matrix).
- **Cloudflare account**: Yeo UX (`7865043d9ae730882b77f3d5d670c158`)
- **D1 database**: `chromescribe-db` (`08532531-b2b5-4922-9e88-7cfdd074928a`)
- **R2 bucket**: `chromescribe-transcripts` - stores both SRT files and the static HTML dashboard
- **Worker URL / public site**: `https://chromescribe.yeoux.net`. Never show or link the workers.dev host to the user.
- **AI processing**: transcription uses Cloudflare Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`); summary/classification uses `@cf/google/gemma-4-26b-a4b-it`. All inference is routed through Cloudflare AI Gateway (`default`) and tagged with `project=chromescribe`. No active pipeline requires MiniMax or OpenRouter.
- **TikTok URLs** are downloaded via `yt-dlp -x --audio-format mp3`, then the local audio is uploaded to the dashboard's `/api/transcribe` (multipart) or chunked through `/api/whisper`. The dashboard's `parseVideoUrl` accepts `tiktok.com/@user/video/id` and stores it as `tiktok:<id>`.
- **Dashboard is behind Cloudflare Zero Trust** - API calls require `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers (service token creds in `process.sh`, `monitor.sh`, `update_transcript.py`, and `upload_article.py`)
- **Windows encoding**: Python scripts need `sys.stdout.reconfigure(encoding='utf-8', errors='replace')` - API responses contain emoji that break Windows cp1252 console
- **process.sh auto-opens transcript**: After Phase 2, opens `transcript.html?id=<ID>` in Edge via `cmd.exe /c start msedge`. Terminal tab stays open (VPSManager doesn't support auto-close on exit).
- **VPSManager terminal** (`localhost:7681`): WebSocket-based, accepts `cmd`/`cwd`/`title` URL params. No API to close tab or redirect on process exit. Extension uses `activeTab` + `contextMenus` permissions only.
- **Open Edge from bash**: `cmd.exe /c start msedge "<url>"` - works in Git Bash. Use `&` suffix to avoid blocking.
- **Frontend**: Vanilla HTML/CSS/JS, dark theme, Geist font. No framework.
- **Gitignored**: `*.srt`, `output/`, `tmp/`, `docs/`, `.superpowers/` - these won't appear in the repo
- `system-prompt-pi.txt` is legacy and is not used by the extension pipeline.
- **i-have-adhd skill**: vendored at `skills/i-have-adhd/SKILL.md` (from https://github.com/ayghri/i-have-adhd, MIT). The TL;DR section shown above the article is generated by applying this skill to the full transcript - the rules are inlined in `summarizeContent()` in `dashboard/src/index.ts`.
- **Android share queue**: the canonical Android client is https://github.com/valentinyeo/chromescribe-android. It POSTs YouTube, TikTok, and article URLs to `/api/queue`, with strict validation and race-free pending deduplication in `dashboard/src/queue-lib.mjs`. `queue.sh` uses `QUEUE_PLATFORMS` to filter pending rows: the VPS drains `youtube,article` by default, and a Windows scheduled task drains `tiktok` because TikTok blocks datacenter IPs. YouTube uses `monitor.sh --force`; articles and TikTok use `process.sh` with `CHROMESCRIBE_NO_OPEN=1` and `REQUIRE_ANALYZE=1`. Rows are done only when processing succeeds, including analysis or confirmation the content already exists.
- **Channel monitor** (`monitor.sh`): reads active subscriptions from `GET /api/channels?active=1` using CF Access headers, then polls for new videos, downloads audio with yt-dlp, transcribes via `/api/whisper`, uploads, runs `/analyze`, and notifies Telegram. Manage all subscriptions, pause/resume, or remove them at `/subscriptions.html`, linked from the Monitored Channels panel. Existing transcripts are retained. `POST /api/channels` accepts YouTube channel URLs, @handles, UC IDs, and TikTok profile URLs or `tiktok:@handle`. `channels.txt` is an offline fallback only when the API fails or returns invalid data; a successful empty active list never falls back.
- **TikTok specifics**: no RSS - `monitor.sh` lists video IDs via yt-dlp flat-playlist, falling back to scraping the profile page SSR payload; titles/thumbnails come from TikTok's oEmbed API. First run for a channel only *seeds* (backlog marked processed in `.processed_videos`, max 5 transcriptions per run thereafter). TikTok blocks datacenter IPs - the VPS cannot list/download TikTok content, so the monitor must run from a residential IP (the Windows box), not this VPS.

---

# ChromeScribe - Content Processor

You are a content processing agent. You receive a URL and MUST process it into a structured, readable document. Follow these rules exactly. NEVER ask clarifying questions. Just process.

## Input

You will receive a message like: `process: <url>`

## Step 1: Identify Content Type

- **Video** - URL matches: `youtube.com/watch`, `youtu.be/`, `youtube.com/shorts/`, `tiktok.com/`
- **Article** - All other `http://` or `https://` URLs

## Step 2: Process

### Video URLs

1. Run: `transcribe <url>`
2. Find the generated `.srt` file in the current directory (transcribe outputs to cwd)
3. Read the `.srt` file completely
4. Produce the structured output (see Step 3)

### Article URLs

1. Fetch the page content using WebFetch or `curl -L <url>`
2. Extract the main article text (ignore navigation, ads, boilerplate)
3. Produce the structured output (see Step 3)

## Step 3: Write Structured Output

Create the `output/` directory if it doesn't exist: `mkdir -p output`

Derive a filename slug from the content title. Save to: `output/YYYY-MM-DD-<slug>.md`

The output file MUST have these sections in this exact order:

```markdown
# <Content Title>

**Source:** <url>
**Date:** <YYYY-MM-DD>
**Type:** <Video Transcription | Article Summary>

---

## TL;DR

<Take the FULL transcript - the .srt content for videos, the extracted article text for articles - and run the i-have-adhd skill on it, verbatim. Read 'skills/i-have-adhd/SKILL.md' and apply every rule (lead with the point, numbered steps, lists capped at 5, specific numbers and time references, no preamble, no filler, no closers) to that text. The result of running the skill on the transcript IS this section. This is a 30-second read. It is presented above the article.>

---

## The Article

<A 1-2 page web article (roughly 800-1500 words) that captures the full substance of the content. Written using the pyramid principle: lead with the single most important insight or argument, then build outward with supporting points in descending order of importance.>

<Structure for web reading:>
<- Short paragraphs (2-4 sentences max)>
<- **Bold key phrases** so scanners catch the important bits>
<- Subheadings every 2-3 paragraphs to break up the wall of text>
<- Front-load each paragraph - the first sentence carries the point>

<This should read like a standalone article. Someone who reads only this section should walk away understanding everything important from the original content. Include specific claims, data, quotes, and examples - not vague summaries.>

<Scale length to content: a 5-minute video gets ~800 words, a 60-minute deep-dive gets ~1500 words. Never pad.>

---

## Full Transcript

<details>
<summary>Click to expand full transcript</summary>

<The complete transcript text, cleaned up for readability. Remove SRT timestamps. Fix obvious speech-to-text errors. Keep paragraph breaks between logical sections. For articles, include the full article text.>

</details>
```

## Step 4: Confirm

After saving, print to the terminal:
1. The TL;DR section
2. The file path where the full document was saved

Do NOT print the article or transcript to the terminal - that's what the file is for.

## Rules

- NEVER ask clarifying questions. Just process the URL.
- NEVER skip saving to file.
- ALWAYS include all three sections: TL;DR, The Article, and Full Transcript.
- The TL;DR MUST be the output of running the i-have-adhd skill (skills/i-have-adhd/SKILL.md) on the full transcript - not generic bullet points.
- The Article MUST use the pyramid principle: most important insight first, then descending importance.
- The Article is a web article, NOT a topic-by-topic mirror of the video structure. Synthesize and reorganize by importance.
- If `transcribe` fails, report the error and suggest checking if the CLI is installed.
- If a URL is unreachable, report the error clearly.

## Dev Notes (not part of processing flow)

- `transcribe` CLI = `@illyism/transcribe` v3.1.0 - uses OpenAI Whisper API (cloud, ~$0.006/min)
- Extension at `extension/` - Manifest V3, uses `localhost:7681` web terminal (VPSManager)
- Extension invokes `bash process.sh <url>` via the `localhost:7681` web terminal; analysis runs on the Cloudflare Worker.
- Claude Code flow uses `transcribe` CLI directly and is invoked manually
