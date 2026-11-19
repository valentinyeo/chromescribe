# Queue

## Sub-features

- Add a link, claim, finish, fail and retry entries
- Lazy column migration on first request

## How to get to it (user POV)

The phone app shares a link, `queue.sh` drains it, and the queue page in the dashboard shows it. API and lifecycle: `dashboard/README.md`.

## Driving it with the Worker test harness

`cd dashboard && node --test test/queue-api.test.mjs test/queue-lib.test.mjs test/queue-shell.test.mjs test/queue-ui.test.mjs`. `queue-api` calls `worker.fetch` against an in-memory D1 and reads the rows back.

## Driving it in the local web app

The phone app adds a link with `POST /api/queue`, then the queue page lists it under Waiting.

```bash
S=.claude/skills/verify-chromescribe/scripts; P=/tmp/cs-verify/proof
bash $S/launch.sh
curl -s -X POST -H 'content-type: application/json' -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' http://127.0.0.1:8799/api/queue | tee $P/queue-post.json
(cd dashboard && node "$(npm root -g)/wrangler/bin/wrangler.js" d1 execute chromescribe --local --config /tmp/cs-verify/wrangler.toml --persist-to /tmp/cs-verify/state --command "SELECT * FROM queue" --json) > $P/queue-db.json
node $S/shot.mjs /queue.html queue 390 844
bash $S/cleanup.sh
```

Proof: the response is `{"success":true,"data":{"queued":true,"id":1,"platform":"youtube"}}`, the D1 row has `status` `pending` and `video_id` `dQw4w9WgXcQ`, and `queue-390.png` shows the link under Waiting.

## Gotchas

- A pending video id is unique; a second add must not duplicate it.
