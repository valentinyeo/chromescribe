# CLAUDE.md

ChromeScribe turns YouTube videos, TikToks and web articles into transcripts with summaries, served at https://chromescribe.yeoux.net.

## Parts

- `extension/`: Manifest V3 Chrome extension. Sends the page URL to the local web terminal (`localhost:7681`, VPSManager), which runs `bash process.sh <url>`. Hardcoded to Windows paths.
- `process.sh`: videos are downloaded with yt-dlp and chunked with ffmpeg, then uploaded to `/api/whisper` or `/api/transcribe`; articles go through Jina Reader and `upload_article.py`. Then `/api/transcripts/:id/analyze` writes the summary. It opens the transcript in Edge unless `CHROMESCRIBE_NO_OPEN=1`.
- `queue.sh`: drains the Android share queue (client: https://github.com/valentinyeo/chromescribe-android). The VPS drains `youtube,article`; a Windows scheduled task drains `tiktok`.
- `monitor.sh`: polls active subscriptions from `GET /api/channels?active=1`, transcribes new videos, and notifies Telegram only when `CHROMESCRIBE_TELEGRAM=1` is set (off by default). `channels.txt` is only an offline fallback when the API fails.
- `dashboard/`: TypeScript Cloudflare Worker with the API and static pages. D1 for metadata, R2 for transcripts, pages and reports. API, queue lifecycle and pages: `dashboard/README.md`. Schema: `dashboard/schema.sql`.
- `cli/`: the `chromescribe` CLI and channel lenses. Commands: `cli/README.md`.
- `system-prompt-pi.txt` is legacy and unused. The phone app lives in https://github.com/valentinyeo/chromescribe-android and signs users in; it carries no service key.

## AI

- Transcription: Workers AI Whisper `@cf/openai/whisper-large-v3-turbo`. Summary and classification: `@cf/google/gemma-4-26b-a4b-it`.
- All inference goes through AI Gateway `default`, tagged `project=chromescribe`.
- The TL;DR applies the vendored `skills/i-have-adhd/SKILL.md` rules, inlined in `summarizeContent()` in `dashboard/src/index.ts`.

## Test

```bash
node tools/strip-comments.mjs --check .
node tools/encoding-check.mjs
node tools/media-check.mjs
node tools/client-key-check.mjs
node --test tools/*.test.js
node --test cli/test/*.test.mjs
cd dashboard && node --test test/*.test.mjs
```

`bash tools/run-checks.sh` runs all of these in parallel, as CI does. No package.json and no build step. Every PR runs them inside the `pstack-verifier` job (`.github/workflows/verify.yml`), whose verdict is the only check a PR needs to merge. No code comments: CI fails on any; `node tools/strip-comments.mjs .` removes them. Do not deploy as part of local verification unless explicitly authorized.

## Ship

- Deploy by pushing to `master`: `.github/workflows/deploy.yml` runs `tools/run-checks.sh` (every check from "Test" plus the no-paid-AI grep, in parallel) in the same job, then `dashboard/deploy.sh`, which uploads every `dashboard/public/*.html` page to R2 and always deploys the Worker, then `tools/live-check.mjs --require-login`, which fails the run unless every page on https://chromescribe.yeoux.net matches `dashboard/public`, the API refuses calls without a login, the service key gets in, and `/reports/<id>` stays open. A failed check stops the job, so the deploy steps never run. It reads the service key from the repo secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.
- Emergency: a live break is fixed by reverting the change that caused it first (`git revert <sha>`, PR, merge once the required check passes). The real fix follows as a normal PR with the same verification. There is no skip lane: no bypass actors on the ruleset, no skip markers, no direct pushes to `master`.
- Local `wrangler` deploys get 403: the shell's `CLOUDFLARE_API_TOKEN` belongs to the Hypertask account, not Yeo UX.
- Read-only D1 queries: `cd dashboard && wrangler d1 execute chromescribe --remote --command "<SQL>"`.

## Facts

- Cloudflare account Yeo UX `7865043d9ae730882b77f3d5d670c158`; D1 `chromescribe` (`08532531-b2b5-4922-9e88-7cfdd074928a`); R2 `chromescribe-transcripts`.
- Only show users https://chromescribe.yeoux.net; never show or link the workers.dev host.
- API calls send `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. Keys live only in 1Password: the CLI reads `yeo-key "Chromescribe Access"` first (`CHROMESCRIBE_YEO_KEY=` turns that off), then the environment; scripts (`lib/cf_access.sh`, `cf_access.py`) read env, then yeo-key, then the plain file. The verifier scans each PR's commits with gitleaks and fails on a leak; `.github/workflows/gitleaks.yml` scans every push to master; `.github/workflows/secret-rescan.yml` scans all history weekly and stays red while a working key sits in it. Zero Trust app "ChromeScribe Dashboard" covers both hosts; the bypass app "ChromeScribe public reports" keeps `chromescribe.yeoux.net/reports/*` open.
- `/api/*` also verifies the Access login itself when `CHRO10_API_GATE = "1"` in `dashboard/wrangler.toml` (`dashboard/src/access-gate.mjs`), checking the audience tag in the Worker secret `ACCESS_AUD` (refuses everyone when it is missing; the deploy live check then fails). It is on; setting it to `"0"` turns the Worker check off while Zero Trust still guards both hosts.
- The API sends no CORS headers: only same-origin pages may call it.
- TikTok blocks datacenter IPs: list and download TikTok only from the Windows box, never this VPS. First monitor run for a TikTok channel only seeds the backlog.
- Frontend is vanilla HTML, CSS and JS, dark theme, Geist font.
- Gitignored: `*.srt`, `output/`, `tmp/`, `docs/`, `.superpowers/`, and video, audio, subtitle and image files in the top folder.

## `process: <url>` requests

When a message says `process: <url>`, follow `system-prompt.txt` exactly: never ask questions, write `output/YYYY-MM-DD-<slug>.md` with TL;DR, The Article and Full Transcript, then print the TL;DR and the file path.

## Rules and what enforces them

| Rule | Enforced by |
|---|---|
| No code comments (including YAML, TOML, SQL and batch) | `tools/strip-comments.mjs --check` in CI |
| A new page is a file in `dashboard/public/` plus its route in `dashboard/src/index.ts` | `dashboard/test/static-pages.test.mjs` |
| Python text IO is UTF-8: `open(..., encoding='utf-8')`, and scripts that print call `sys.stdout.reconfigure` | `tools/encoding-check.mjs` in CI |
| No downloaded videos, audio, subtitles or top-folder images in git | `tools/media-check.mjs` in CI |
| No Access service key in the extension, Android sources or public pages | `tools/client-key-check.mjs` in CI |
| Every deploy is checked on the live site | `tools/live-check.mjs` in `deploy.yml`, tested by `tools/live-check.test.js` |
| With the gate on, `/api/*` refuses calls without a valid Access login; no CORS headers | `dashboard/test/access-gate.test.mjs`, `dashboard/test/channels-api.test.mjs` |
| A PR merges only on a `pstack-verifier` PASS or PASS+NOTES; it is the only required check | GitHub ruleset "pstack-verifier required" on master |
| Every workflow cancels its superseded runs | `tools/workflows.test.js` |
| Emergencies revert first; the fix gets normal verification, no skip lane | GitHub ruleset on master with no bypass actors; skip-marker step in `verify.yml` |
| Never put a CI skip marker in a commit message or PR title | skip-marker step in `verify.yml`; `dashboard/deploy.sh` always deploys the Worker, so the next push catches up |
| No real email in any commit reachable from the tested head (the repo is public; CI checks out only that head) | `tools/run-checks.sh` |
| Every PR gets an independent verdict from a model family no author used, PASS, PASS+NOTES or FAIL, posted on the PR | `pstack-verifier` job in `.github/workflows/verify.yml`, model from `scripts/pick-verifier-model` run from the base commit, moving to the next eligible family only when one is rate limited; `tools/verifier/verdict.test.mjs` |
| Every user journey runs nightly on master with video; a deploy first runs the journeys of the features it changed, with video kept 90 days | `.github/workflows/journeys.yml`, release proof step in `deploy.yml`, both through `tools/run-journeys.sh` |
| The feature map is checked against the app daily; corrections arrive as one PR that the same verifier judges | `.github/workflows/map-maintenance.yml`, which dispatches `verify.yml` |
| Every PR body declares its authors as `Author model: <family>/<model>` lines | `scripts/pick-verifier-model` fails the verifier without them |
| No OpenRouter or Z.ai API use | `tools/run-checks.sh`, run by `verify.yml` on PRs and `deploy.yml` before deploy |
