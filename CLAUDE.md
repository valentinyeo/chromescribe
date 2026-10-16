# CLAUDE.md

ChromeScribe turns YouTube videos, TikToks and web articles into transcripts with summaries, served at https://chromescribe.yeoux.net.

## Parts

- `extension/`: Manifest V3 Chrome extension. Sends the page URL to the local web terminal (`localhost:7681`, VPSManager), which runs `bash process.sh <url>`. Hardcoded to Windows paths.
- `process.sh`: videos are downloaded with yt-dlp and chunked with ffmpeg, then uploaded to `/api/whisper` or `/api/transcribe`; articles go through Jina Reader and `upload_article.py`. Then `/api/transcripts/:id/analyze` writes the summary. It opens the transcript in Edge unless `CHROMESCRIBE_NO_OPEN=1`.
- `queue.sh`: drains the Android share queue (client: https://github.com/valentinyeo/chromescribe-android). The VPS drains `youtube,article`; a Windows scheduled task drains `tiktok`.
- `monitor.sh`: polls active subscriptions from `GET /api/channels?active=1`, transcribes new videos, and notifies Telegram. `channels.txt` is only an offline fallback when the API fails.
- `dashboard/`: TypeScript Cloudflare Worker with the API and static pages. D1 for metadata, R2 for transcripts, pages and reports. API, queue lifecycle and pages: `dashboard/README.md`. Schema: `dashboard/schema.sql`.
- `cli/`: the `chromescribe` CLI and channel lenses. Commands: `cli/README.md`.
- `system-prompt-pi.txt` and `android/` are legacy and unused.

## AI

- Transcription: Workers AI Whisper `@cf/openai/whisper-large-v3-turbo`. Summary and classification: `@cf/google/gemma-4-26b-a4b-it`.
- All inference goes through AI Gateway `default`, tagged `project=chromescribe`.
- The TL;DR applies the vendored `skills/i-have-adhd/SKILL.md` rules, inlined in `summarizeContent()` in `dashboard/src/index.ts`.

## Test

```bash
node tools/strip-comments.mjs --check .
node tools/encoding-check.mjs
node --test tools/*.test.js
node --test cli/test/*.test.mjs
cd dashboard && node --test test/*.test.mjs
```

No package.json and no build step. Every PR runs these in CI. No code comments: CI fails on any; `node tools/strip-comments.mjs .` removes them. Do not deploy as part of local verification unless explicitly authorized.

## Ship

- Deploy by pushing to `master`: `.github/workflows/deploy.yml` runs the tests, then `dashboard/deploy.sh`, which uploads every `dashboard/public/*.html` page to R2 and always deploys the Worker.
- Local `wrangler` deploys get 403: the shell's `CLOUDFLARE_API_TOKEN` belongs to the Hypertask account, not Yeo UX.
- Read-only D1 queries: `cd dashboard && wrangler d1 execute chromescribe-db --remote --command "<SQL>"`.

## Facts

- Cloudflare account Yeo UX `7865043d9ae730882b77f3d5d670c158`; D1 `chromescribe-db` (`08532531-b2b5-4922-9e88-7cfdd074928a`); R2 `chromescribe-transcripts`.
- Only show users https://chromescribe.yeoux.net; never show or link the workers.dev host.
- The dashboard is behind Cloudflare Zero Trust: API calls need `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. Keep credentials in the environment, never in committed files.
- TikTok blocks datacenter IPs: list and download TikTok only from the Windows box, never this VPS. First monitor run for a TikTok channel only seeds the backlog.
- Frontend is vanilla HTML, CSS and JS, dark theme, Geist font.
- Gitignored: `*.srt`, `output/`, `tmp/`, `docs/`, `.superpowers/`.

## `process: <url>` requests

When a message says `process: <url>`, follow `system-prompt.txt` exactly: never ask questions, write `output/YYYY-MM-DD-<slug>.md` with TL;DR, The Article and Full Transcript, then print the TL;DR and the file path.

## Rules and what enforces them

| Rule | Enforced by |
|---|---|
| No code comments | `tools/strip-comments.mjs --check` in CI |
| A new page is a file in `dashboard/public/` plus its route in `dashboard/src/index.ts` | `dashboard/test/static-pages.test.mjs` |
| Python text IO is UTF-8: `open(..., encoding='utf-8')`, and scripts that print call `sys.stdout.reconfigure` | `tools/encoding-check.mjs` in CI |
| A `[skip ci]` push still reaches production on the next push | `dashboard/deploy.sh` always deploys the Worker |
