---
name: process
journey: process
paths:
  - process.sh
  - upload_article.py
  - fxtwitter_article.py
---

# process.sh pipeline

`process.sh <url>` turns one YouTube, TikTok, X or article link into a transcript: download or extract, upload, then run hosted analysis.

## Sub-features

- `process-video` downloads with `yt-dlp`, extracts audio with `ffmpeg`, and uploads small audio to `/api/transcribe`.
- `process-chunked` splits large audio and sends each chunk to `/api/whisper`, then uploads combined markdown.
- `process-article` reads an article through Jina Reader or FXTwitter and uploads it with `upload_article.py`.
- `process-existing` stops when the link is already transcribed.
- `process-analysis` posts to `/api/transcripts/<id>/analyze` and warns instead of failing when it is not required.
- `process-open` opens the transcript in Edge unless `CHROMESCRIBE_NO_OPEN=1`.

## How to get to it (user POV)

- Run `bash process.sh https://www.youtube.com/watch?v=<id>` from a shell.
- The Chrome extension runs the same script through the local terminal.
- `queue.sh` and `monitor.sh` call it for queued links and new uploads.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` is ok, but the journey never talks to it.
- The journey copies `process.sh`, `lib/cf_access.sh`, `fxtwitter_article.py` and a JSON-printing `upload_article.py` into a temp directory, and puts stub `curl`, `cmd.exe`, `yt-dlp` and `ffmpeg` on `PATH`.

- **Video path.** Run `cs-verify journey process`. The journey runs `process.sh https://www.youtube.com/watch?v=JOURNEYPROC` with `REQUIRE_ANALYZE=1` and `CHROMESCRIBE_NO_OPEN=1`. It must exit 0, print `Audio extracted` and `Phase 1 complete`, call `/api/transcribe`, then `/api/transcripts/7/analyze`.
- **Article path.** The journey runs `process.sh https://example.com/journey-article`. It must exit 0, print `Article #7`, and never open a browser.
- **Analysis.** Both paths must print `Cloudflare summary complete`.

## Gotchas

- Real downloads need live YouTube or TikTok and a working `yt-dlp`. TikTok blocks datacenter IPs, and this journey runs on a VPS with stubs only.
- The audio paths need Workers AI, which is off locally. The stub `curl` answers the transcribe and analyze calls; the real handler is covered by `dashboard/test/` and the add-video journey.
- `process.sh` hardcodes the workers.dev API base and is not pointed at the local instance. The stubs record the calls instead.
- The chunked path only runs for audio over 500 KB. The journey stub writes a few bytes, so it exercises the small-upload path.
