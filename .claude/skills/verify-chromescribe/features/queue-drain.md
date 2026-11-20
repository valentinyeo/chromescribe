---
name: queue-drain
journey: queue-drain
paths:
  - queue.sh
---

# queue.sh drain loop

`queue.sh` drains the share queue: it claims pending rows, runs the matching pipeline, then marks each row done or failed.

## Sub-features

- `drain-claim` marks a row `processing` before any work.
- `drain-article` runs `process.sh` for article and TikTok rows.
- `drain-video` hands YouTube rows to `monitor.sh --force`.
- `drain-done` marks the row `done` after success.
- `drain-fail` marks it `failed` with a sanitised, 500-character reason.
- `drain-lock` refuses a second concurrent run through `flock`.

## How to get to it (user POV)

- A cron job or scheduled task runs `bash queue.sh`.
- The VPS drains `youtube,article`; the Windows box drains `tiktok`.
- The queue page shows the state each run leaves behind.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` runs the real Worker on `127.0.0.1` with the Access gate off. The journey drains that instance.
- The journey copies `queue.sh`, `process.sh`, `monitor.sh`, `upload_article.py`, `fxtwitter_article.py` and `lib/cf_access.sh` into a temp directory, points `MONITOR_SH` at that copy of `monitor.sh`, puts a stub `yt-dlp` on `PATH`, and adds a `curl` wrapper that answers only the outside network (Jina Reader, FXTwitter, YouTube oEmbed) and hands every other URL to the real `curl`.
- It runs with `CHROMESCRIBE_API` set to the local instance and `CHROMESCRIBE_NO_OPEN=1`.

- **Article drain.** The journey queues a fresh article link through `POST /api/queue` and a second link whose transcript it already wrote through `POST /api/transcribe`, then runs `bash queue.sh` with `QUEUE_PLATFORMS=article`.
- **Claim.** Both rows must show `attempts` 1 and `started_at` in local D1 after the run.
- **Done.** The row whose transcript already exists ends `done`: `process.sh` reads `already_exists` from the real handler and prints `Already transcribed`.
- **Transcript.** The fresh row writes its transcript through the real `/api/transcribe` handler, and a matching row appears in local D1.
- **Done after analysis.** The fresh row ends `done`, because analysis runs through the real handler and the fake AI.
- **Video hand-off.** The journey then runs `bash queue.sh` with `QUEUE_PLATFORMS=youtube`. The oldest waiting video must appear in the real `monitor.sh` output as `Force mode: processing video <id>`, the Worker log must show `Video ID: <id>` and `Transcribing audio with Cloudflare AI, buffer size: N`, and the row must end `done`.
- **No API stub.** The journey fails if any recorded `curl` call went somewhere other than the local instance or a faked outside host.

## Gotchas

- `queue.sh` calls the API at `CHROMESCRIBE_API`, default the workers.dev host. The journey points it at the local instance, so the stub `curl` of older runs is gone.
- Article and TikTok rows run the real `process.sh` from the repo copy. The video rows run the real `monitor.sh`.
- `GET /api/queue` returns at most 10 pending rows, so one run drains 10 at most. The journey drains the oldest seeded video rows, then deletes the transcripts it wrote for them and puts them back to `pending`.
- Transcription and analysis reach the fake `env.AI` from `scripts/fake-ai-entry.mjs`. The handlers are real.
- The failure branch needs a non-zero pipeline. `dashboard/test/queue-shell.test.mjs` covers its message cleanup.
- TikTok must only drain from the Windows box. The journey never queues or drains a TikTok link.
