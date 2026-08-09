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

## Pages

- `/` - Dashboard with video grid
- `/transcript.html?id=:id` - Individual transcript view with video embed

## Environment

Variables can be set in `wrangler.toml` under `[vars]`:
```toml
[vars]
ENVIRONMENT = "production"
```
