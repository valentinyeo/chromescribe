# Queue

## Sub-features

- Add a link, claim, finish, fail and retry entries
- Lazy column migration on first request

## How to get to it (user POV)

The phone app shares a link, `queue.sh` drains it, and the queue page in the dashboard shows it. API and lifecycle: `dashboard/README.md`.

## Driving it with the Worker test harness

`cd dashboard && node --test test/queue-api.test.mjs test/queue-lib.test.mjs test/queue-shell.test.mjs test/queue-ui.test.mjs`. `queue-api` calls `worker.fetch` against an in-memory D1 and reads the rows back.

## Gotchas

- A pending video id is unique; a second add must not duplicate it.
