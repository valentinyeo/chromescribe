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

### List Transcripts
```
GET /api/transcripts
```

### Get Single Transcript
```
GET /api/transcripts/:id
```

### Get Transcript Content (SRT)
```
GET /api/transcript/:id/content
```

### Add New Transcription
```
POST /api/transcribe
Content-Type: application/json

{
  "url": "https://youtube.com/watch?v=...",
  "title": "Video Title",
  "channel": "Channel Name",
  "srt_content": "..." 
}
```

### Delete Transcript
```
DELETE /api/transcripts/:id
```

### Search
```
GET /api/search?q=query
```

### Android share queue

The Android companion app shares a YouTube URL; `queue.sh` (cron, on the box
with yt-dlp) drains it. Only strict YouTube watch/shorts/live/youtu.be URLs on
the exact https hosts `youtube.com`, `www.youtube.com`, `m.youtube.com` and
`youtu.be` are accepted.

```
POST /api/queue            { "url": "https://youtu.be/<11-char-id>" }
GET  /api/queue            # up to 10 pending rows, oldest first (queue.sh)
PUT  /api/queue/:id        { "status": "done" | "failed" } (queue.sh)
```

`POST` returns `{success:true,data:{queued:true,id}}`, adds `duplicate:true`
when a pending row already existed, or `{queued:false,transcript_id}` when the
video is already transcribed. Malformed input returns HTTP 400, never 500.

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

The canonical Android client lives at
https://github.com/valentinyeo/chromescribe-android. The `android/` folder in
this repo is the original prototype and is no longer the source of truth.

## Pages

- `/` - Dashboard with video grid
- `/transcript.html?id=:id` - Individual transcript view with video embed

## Environment

Variables can be set in `wrangler.toml` under `[vars]`:
```toml
[vars]
ENVIRONMENT = "production"
```
