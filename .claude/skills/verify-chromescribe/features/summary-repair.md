---
name: summary-repair
journey: summary-repair
paths:
  - dashboard/src/index.ts
  - dashboard/wrangler.toml
  - lib/analyze.sh
  - process.sh
  - monitor.sh
---

# Summary repair

A slow or failed model call can leave a transcript with its raw markdown and no TL;DR, which the video page shows as "No summary yet." `process.sh` and `monitor.sh` retry the analyze call, and a daily Worker cron repairs recent transcripts that still have none.

## Sub-features

- `analyze-retry` posts to `/api/transcripts/<id>/analyze` up to three times with a doubling delay, and stops retrying once the server has written the TL;DR after a client timeout.
- `summary-repair` runs from the Worker's daily cron, scans transcripts created in the last 14 days and analyzes at most five that still carry no TL;DR.
- `analyze-endpoint` is the one handler behind the retry, the repair and the dashboard Summarize button, so all three write the same markdown.

## How to get to it (user POV)

- Run `bash process.sh <url>` or `bash monitor.sh --force <video_id>`; a failed summary is retried without a second click.
- Open a transcript with no summary: the next daily run fills it in and the page shows the TL;DR.
- Press Summarize on `/transcript.html?id=<id>` for an immediate manual run.

## Driving it with cs-verify

Preconditions:

- `cs-verify launch` runs the real Worker with `--test-scheduled`, so `GET /__scheduled?cron=23+4+*+*+*` invokes the scheduled handler.
- A summary prompt containing `[[verify:slow-summary]]` makes the fake AI stall for three seconds, so a short `ANALYZE_MAX_TIME` times the client out while the server finishes the write.
- The `process` journey copies `process.sh`, `lib/analyze.sh` and `lib/cf_access.sh` into a temp directory and points `CHROMESCRIBE_API` at the local instance.

- **Retry proof.** Run `cs-verify journey process`. The journey stalls one summary call through the marker, runs `process.sh` for that article with `ANALYZE_MAX_TIME=1`, and requires `Analyze attempt 1/3 failed` plus `Cloudflare analysis had already finished on the server` in the output and exactly one `POST /api/transcripts/<id>/analyze` in the Worker log.
- **Repair proof.** Run `cs-verify journey summary-repair`. It stores an article transcript whose body has no TL;DR through `POST /api/transcribe`, calls `/__scheduled?cron=23+4+*+*+*`, and requires the stored body to gain `## TL;DR`, the row to gain a category, and the Worker log to print `Summary repair: N repaired, N failed, N recent transcripts scanned`.

## Gotchas

- The repair is capped at five transcripts per run and only looks at the last 14 days, so a bigger backlog drains one day at a time and AI spend stays bounded.
- `lib/analyze.sh` uses the caller's `api_call` function, so `process.sh` and `monitor.sh` define it before sourcing the helper.
- The repair needs the cron entry in `dashboard/wrangler.toml`; merging to master deploys it.
- Local `wrangler dev` only answers `/__scheduled` with `--test-scheduled`, which `cs-verify launch` passes.
