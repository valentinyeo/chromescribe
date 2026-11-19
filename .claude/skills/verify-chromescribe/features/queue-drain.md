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

- `cs-verify launch` is ok, but the journey never talks to it.
- The journey copies `queue.sh` and `lib/cf_access.sh` into a temp directory, with a stub `curl` that serves one pending YouTube row and records every call, and a stub `monitor.sh` that logs its arguments and exits 0.

- **Drain.** Run `cs-verify journey queue-drain`. The journey runs `bash queue.sh` with `MONITOR_SH` pointing at the stub.
- **Lifecycle.** The recorded calls must include `PUT /api/queue/1` with `processing` before `done`.
- **Hand-off.** The stub monitor log must contain the video id and title.
- **Outcome.** stdout must contain `Queue #1: done`, and the script must exit 0.

## Gotchas

- `queue.sh` hardcodes the workers.dev base. The stub `curl` must write its body to the `-o` path and print the status for `-w`, or every API check fails.
- Article and TikTok rows call the real `process.sh` from the repo. The journey uses a YouTube row so the stub monitor is the only worker.
- The failure branch needs a non-zero pipeline. The journey does not drive it; `dashboard/test/queue-shell.test.mjs` covers that.
- TikTok must only drain from the Windows box. Never run a real drain on the VPS with TikTok rows.
