# ChromeScribe

ChromeScribe turns YouTube videos, TikToks and web articles into readable transcripts with a short summary, and keeps them in a searchable dashboard at https://chromescribe.yeoux.net.

## Parts

- `extension/`: Chrome extension that sends the current page to the local processing script.
- `process.sh`, `queue.sh`, `monitor.sh`: download audio or article text, upload it, and drain the share queue and channel subscriptions.
- `dashboard/`: Cloudflare Worker with the API and the dashboard pages (D1 for metadata, R2 for files, Workers AI for transcription and summaries).
- `cli/`: the `chromescribe` command line tool for listing, searching, subscribing and building channel lenses.

## YouTube downloads

See [YOUTUBE.md](YOUTUBE.md) for the verified login-free server configuration,
direct Windows laptop downloads, and bot-blocking diagnostics.

## Tests

Requires Node 22 or newer.

```bash
node --test cli/test/*.test.mjs
cd dashboard && node --test test/*.test.mjs
```

Every pull request runs these tests. Pushes to `master` run them again and only deploy the dashboard when they pass.

## Deploy

Push to `master`. GitHub Actions uploads the dashboard pages to R2 and deploys the Worker. See `CLAUDE.md` for details.
