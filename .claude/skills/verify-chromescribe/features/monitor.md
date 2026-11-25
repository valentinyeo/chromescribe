---
name: monitor
journey: monitor
paths:
  - monitor.sh
  - lib/youtube_feed.py
---

# monitor.sh

`monitor.sh` polls active channels for new uploads, transcribes each new video, analyses it, and optionally sends a Telegram message.

## Sub-features

- `monitor-channels` reads active channels from `GET /api/channels?active=1`, falling back to `channels.txt`.
- `monitor-force` processes one given video with `--force <video_id> [title]`.
- `monitor-youtube` reads each channel's feed and skips Shorts and processed ids.
- `monitor-tiktok` seeds a TikTok backlog on first run when the listing has at least ten videos, and processes at most five new videos per run.
- `monitor-transcribe` uploads audio or combined chunks and analyzes the result.
- `monitor-analysis-retry` retries the analyze call up to three times and stops once the server has written the TL;DR. See [Summary repair](./summary-repair.md).
- `monitor-telegram` notifies Telegram only when `CHROMESCRIBE_TELEGRAM=1`.
- `monitor-state` records processed ids in `.processed_videos`.

## How to get to it (user POV)

- A cron job runs `bash monitor.sh` every few hours.
- Run `bash monitor.sh --force <video_id> "<title>"` to transcribe one video by hand.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` is ok, but the journey never talks to it.
- The journey copies `monitor.sh` and `lib/cf_access.sh` into a temp directory, with stub `curl`, `yt-dlp` and `ffmpeg` on `PATH`.

- **Force one video.** Run `cs-verify journey monitor`. The journey runs `monitor.sh --force MONITOR0001 "Journey monitor video"` with `CHROMESCRIBE_TELEGRAM=0`.
- **Upload and analysis.** stdout must show `Transcribed and uploaded as #42` and `Analysis complete (word_count=900, category=Health)`.
- **State.** `.processed_videos` must contain `MONITOR0001`.
- **No notification.** The recorded curl calls must not include `api.telegram.org`.

## Gotchas

- The channel polling path calls the YouTube feed through `lib/youtube_feed.py`. The journey uses `--force` so no feed call happens.
- `--force` does not skip already processed ids; it is the manual path.
- Telegram stays off unless the environment sets `CHROMESCRIBE_TELEGRAM=1`. The journey asserts the default.
- Real transcription needs Workers AI and live downloads. The stubs answer both, and the real HTTP handling is covered by the dashboard tests.
