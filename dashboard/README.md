# ChromeScribe Dashboard

A private YouTube transcription dashboard hosted on Cloudflare Workers.

## Features

- 📹 YouTube video embeds with transcripts
- 📝 Markdown-formatted transcript display
- 🔍 Full-text search across all transcripts
- 💾 D1 database for metadata storage
- 📦 R2 bucket for SRT file storage
- 🌐 Globally distributed, fast loading

## Architecture

- **Cloudflare Workers** - API & routing
- **D1 Database** - Video metadata storage
- **R2 Bucket** - SRT/markdown file storage
- **Tailwind CSS** - Styling

## Setup

1. **Create D1 Database:**
   ```bash
   wrangler d1 create chromescribe
   ```

   Wrangler reads the Cloudflare account from `account_id` in
   `wrangler.toml` (or `CLOUDFLARE_ACCOUNT_ID`). Commands do not accept an
   `--account-id` flag.

2. **Apply Schema:**
   ```bash
   wrangler d1 execute chromescribe --file=./schema.sql --local
   ```

3. **Create R2 Bucket:**
   ```bash
   wrangler r2 bucket create chromescribe-transcripts
   ```

4. **Update `wrangler.toml`** with your database ID

5. **Deploy:**
   ```bash
   wrangler deploy
   ```

Or run the deployment script:
```bash
# Windows
deploy.bat

# Linux/Mac
bash deploy.sh
```

The deploy scripts upload each page with the Wrangler v4 object-path format,
`chromescribe-transcripts/<page>`, and then deploy the Worker. Existing D1 and
R2 resources are not recreated during a deployment.

## API Endpoints

All `/api/*` calls go through Cloudflare Zero Trust and need the
`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers.

### Transcripts

- `GET /api/transcripts`, `GET /api/transcripts/:id`, `GET /api/transcript/:id/content`
- `GET /api/transcripts?around=<id>` returns only that row's neighbours for the transcript page's previous and next buttons: `{prev, next, index, total}`, where `prev` is the newer row and `next` the older one in list order, and `index` is the row's zero-based place. Unknown id gets 404.
- `GET /api/transcripts` with no parameters returns every row. With `?limit=N&offset=M` (limit clamped 1 to 500) it returns that page newest first, only the columns the cards show, and a `total` next to `data`. Answers carry an `ETag` and `Cache-Control: private, no-cache`, so a repeat call with `If-None-Match` gets 304.
- `PUT /api/transcripts/:id`, `DELETE /api/transcripts/:id`, `GET /api/search?q=`
- `POST /api/transcribe` has two modes: a JSON body with URL and markdown (from Claude), or a multipart form with an audio file that the Worker transcribes with Workers AI Whisper.
- `POST /api/whisper` transcribes one audio chunk; `POST /api/transcripts/:id/analyze` writes the summary and classification.
- `process.sh` and `monitor.sh` send the analyze call through `lib/analyze.sh`: up to three attempts (`ANALYZE_ATTEMPTS`), a doubling delay between them (`ANALYZE_RETRY_DELAY`, 20s), a 240s curl timeout (`ANALYZE_MAX_TIME`), and a `GET /api/transcript/:id/content` check after every failure that stops the retries once the server has written a TL;DR on its own.
- A daily cron (`[triggers]` in `wrangler.toml`, 04:23 UTC) runs the Worker's `scheduled` handler, which reads the transcripts created in the last 14 days, picks at most five that carry no TL;DR, and runs the same analysis on them. The cap and the window are constants in `src/index.ts`, so one run can never loop over the library and burn AI quota.
- Video IDs: YouTube (`youtube.com/watch`, `youtu.be/`, `/shorts/`) and TikTok (`tiktok.com/@user/video/id`, stored as `tiktok:<id>`).

### Channel subscriptions

- `GET /api/channels` includes integer `paused` and a `transcripts` count matched on `transcripts.channel = channels.name`; `?active=1` returns only active subscriptions.
- `POST /api/channels {input}` accepts YouTube channel URLs, @handles, UC IDs, and TikTok profile URLs or `tiktok:@handle`.
- `PATCH /api/channels/:id {paused: true|false}`; pausing skips monitoring without removing the subscription or its transcripts.
- `POST /api/channels/:id/refresh` re-resolves YouTube names and handles without degrading real metadata; TikTok is unchanged.
- `DELETE /api/channels/:id`.
- The Worker lazily creates an empty `channels` table and adds `paused INTEGER NOT NULL DEFAULT 0` once per database binding per isolate. There are no seeded subscriptions.

### Reports

- `POST /api/reports {title, channel, topic, html}`, `GET /api/reports`, `DELETE /api/reports/:id`.
- `GET /reports/:id` serves the HTML sandboxed: the CSP allows template CSS and fonts but no scripts, frames, API connections, or forms.
- The Worker lazily creates the D1 `reports` table and stores HTML in R2 at `reports/<id>.html`, limited to 2 MB UTF-8.

### Share queue

- `POST /api/queue {url}` enqueues YouTube, TikTok, and article URLs with race-free pending deduplication (`src/queue-lib.mjs`).
- `GET /api/queue?platforms=youtube,article,tiktok` returns pending rows only, oldest first, limit 10, for drainers. Before listing, a row still in `processing` whose `started_at` is older than the 30 minute lease (`QUEUE_LEASE_SECONDS` in `src/queue-lib.mjs`) goes back to `pending` and counts as an attempt, or becomes `failed` with a `Drainer stopped before finishing` error once attempts reach `QUEUE_MAX_ATTEMPTS` (2). Each reclaim is a guarded update on status and `started_at`, and is skipped while another row for the same video is pending.
- `GET /api/queue/all?limit=200` returns all statuses newest first with transcript title, channel and ID (limit 1 to 1000).
- `PUT /api/queue/:id {status, error?, transcript_id?}` accepts processing, done, failed or pending. Processing claims a pending row, records `started_at` and increments attempts; done and failed record `finished_at`. Attempts counts every claim and every lease reclaim. Error text is trimmed and capped at 500 characters. Retrying to pending is only allowed from failed and clears error and `finished_at`; a conflict with an existing pending row returns 409.
- `DELETE /api/queue/:id` removes history except processing rows (409). Missing rows return 404.
- Lifecycle columns are lazily added once per database binding per isolate, ignoring only duplicate-column errors.

`queue.sh` filters by `QUEUE_PLATFORMS`: the VPS drains `youtube,article`, and a Windows scheduled task drains `tiktok` because TikTok blocks datacenter IPs. YouTube uses `monitor.sh --force`; articles and TikTok use `process.sh` with `CHROMESCRIBE_NO_OPEN=1` and `REQUIRE_ANALYZE=1`. A row is marked processing before the download starts, then done only when processing succeeds (including analysis, or confirmation the content already exists), or failed with a short diagnostic that redacts credentials and downloader URLs. If the final status update fails, or the drainer dies mid-job, the row stays processing until the next queue listing is older than the lease, which returns it to waiting or fails it for the operator.

## Queue setup, migration and verification

1. **Credentials** (parent-managed, never committed). `queue.sh` reads
   `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` from the environment or
   from a gitignored `.env.chromescribe` (see `.env.chromescribe.example`).
2. **Migration** (additive, production `queue` exists but is empty):
   ```bash
   cd dashboard
   wrangler d1 migrations apply chromescribe --remote
   ```
   `0001_queue.sql` only creates queue objects that are missing and the
   partial unique index `idx_queue_pending_video`. It never touches
   `transcripts` and never deletes queue rows. If duplicate pending rows for
   one video ever exist the index build aborts; resolve by marking the extras
   `failed` (a status change) and re-run.
3. **Tests** (Node built-ins, no dependencies):
   ```bash
   cd dashboard && node --test test/*.test.mjs
   ```
4. **Shell syntax / dry-run**:
   ```bash
   bash -n queue.sh && bash -n monitor.sh
   cd dashboard && wrangler deploy --dry-run
   ```

The Android client lives at
https://github.com/valentinyeo/chromescribe-android.

## Pages

Static pages live in R2 and are served by the Worker: `index.html`, `transcript.html?id=:id`, `settings.html`, `stats.html`, `subscriptions.html`, `reports.html`, `queue.html`.

- `/subscriptions.html` is the only channel-management page: add, pause, resume, or remove subscriptions. Names and counts link to `/?channel=<name>`.
- `/queue.html` shows In progress, Waiting (oldest first, with server or laptop routing), Failed (errors, attempts, Retry and Remove), and the last 30 Done with transcript links. It shows the newest 200 entries and refreshes every 15 seconds while visible.

## Environment

Variables can be set in `wrangler.toml` under `[vars]`:
```toml
[vars]
ENVIRONMENT = "production"
```
