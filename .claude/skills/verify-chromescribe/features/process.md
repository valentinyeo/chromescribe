---
name: process
journey: process
paths:
  - process.sh
  - upload_article.py
  - fxtwitter_article.py
  - dashboard/src/index.ts
---

# process.sh pipeline

`process.sh <url>` turns one YouTube, TikTok, X or article link into a transcript: download or extract, upload, then run hosted analysis.

## Sub-features

- `process-video` downloads with `yt-dlp`, extracts audio with `ffmpeg`, and uploads small audio to `/api/transcribe`.
- `process-chunked` splits large audio and sends each chunk to `/api/whisper`, then uploads combined markdown.
- `process-article` reads an article through Jina Reader or FXTwitter and uploads it with `upload_article.py`.
- `process-existing` stops when the link is already transcribed.
- `process-analysis` posts to `/api/transcripts/<id>/analyze` and warns instead of failing when it is not required.
- `process-analysis-retry` retries that post up to three times with a doubling delay, and stops once the transcript already carries a TL;DR. See [Summary repair](./summary-repair.md).
- `process-open` opens the transcript in Edge unless `CHROMESCRIBE_NO_OPEN=1`.

## How to get to it (user POV)

- Run `bash process.sh https://www.youtube.com/watch?v=<id>` from a shell.
- The Chrome extension runs the same script through the local terminal.
- `queue.sh` and `monitor.sh` call it for queued links and new uploads.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` runs the real Worker on `127.0.0.1` with the Access gate off. The journey drives that instance; nothing is stubbed in our own code.
- The journey copies `process.sh`, `upload_article.py`, `fxtwitter_article.py` and `lib/cf_access.sh` into a temp directory, puts a stub `yt-dlp` on `PATH` that writes a real 10 second audio file with the real `ffmpeg`, and adds a `curl` wrapper that answers only the outside network (Jina Reader, FXTwitter, YouTube oEmbed) and hands every other URL to the real `curl`.
- It runs with `CHROMESCRIBE_API` set to the local instance and `CHROMESCRIBE_NO_OPEN=1`.

- **Article path.** Run `cs-verify journey process`. The journey runs `process.sh https://example.com/journey-process-<stamp>`. It must exit 0 and print `Phase 1 complete! Article #<id>`.
- **Article checks.** The Worker log must show `POST /api/transcribe 201`, a transcript row for the article must exist in local D1, its body must read back from local R2, and the Worker log must show `POST /api/transcripts/<id>/analyze`.
- **Article summary.** The article path must print `Cloudflare summary complete` from the real analyze handler and the fake AI.
- **Audio path.** The journey runs `process.sh https://www.youtube.com/watch?v=<id>` with `REQUIRE_ANALYZE=1`. The Worker log must show `Video ID: <id>` and `Transcribing audio with Cloudflare AI, buffer size: N`, which proves the real multipart upload reached the `/api/transcribe` handler.
- **Audio outcome.** The real handler accepts the audio: `process.sh` exits 0, prints `Audio extracted` and `Phase 1 complete`, and writes a transcript with an id above 0.
- **Analyze retry.** A second article run carries `[[verify:slow-summary]]` in its body and runs with `ANALYZE_MAX_TIME=1` and `ANALYZE_RETRY_DELAY=4`. The fake AI stalls that summary for 3 seconds, so the curl call times out, the helper waits, then finds the summary the server wrote. Output must carry `Analyze attempt 1/3 failed` and `Cloudflare analysis had already finished on the server`, the Worker log must show one `POST /api/transcripts/<id>/analyze`, and the stored body must have `## TL;DR`.
- **No API stub.** The journey fails if any recorded `curl` call went somewhere other than the local instance or a faked outside host.

## Gotchas

- Real downloads need live YouTube or TikTok and a working `yt-dlp`. TikTok blocks datacenter IPs, so `yt-dlp` is a stub here. `ffmpeg` is a local tool, so the journey runs the real one.
- Transcription and analysis reach the fake `env.AI` from `scripts/fake-ai-entry.mjs`. The handlers are real.
- The chunked path only runs for audio over 500 KB. The fake audio is 10 seconds of 64k AAC, so the small-upload path is what runs.
- Jina Reader, FXTwitter and YouTube oEmbed are the only faked network calls. `r.jina.ai` in particular is a real paid service.
