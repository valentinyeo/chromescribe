# Changelog

## [0.2.0] - 2026-09-22

Android share-to-YouTube queue backend correctness pass (not yet deployed).

### Added

- Strict, queue-only YouTube URL parser (`dashboard/src/queue-lib.mjs`): https
  only, exact host allow-list (`youtube.com`, `www.youtube.com`,
  `m.youtube.com`, `youtu.be`), 11-char video id, `watch`/`shorts`/`live`/
  `youtu.be` shapes. The generic `parseVideoUrl` is untouched for other call
  sites. URLs are normalised to `https://www.youtube.com/watch?v=<id>` before
  storage.
- Race-free enqueue: `INSERT ... ON CONFLICT(video_id) WHERE status='pending'
  DO NOTHING` backed by a partial unique index, then a follow-up `SELECT`.
  Concurrent duplicate POSTs now return the same row with `duplicate: true`
  instead of inserting twice.
- Additive D1 migration `dashboard/migrations/0001_queue.sql` (creates the
  queue table/indexes if missing; never touches `transcripts` or deletes
  queue rows).
- Node built-in tests:
  `dashboard/test/queue-lib.test.mjs` (parser + enqueue against in-memory
  SQLite) and `dashboard/test/queue-shell.test.mjs` (mocked curl/monitor
  drainer failure matrix).

### Changed

- `POST /api/queue` rejects malformed JSON/non-object bodies with 400 instead
  of 500; `PUT /api/queue/:id` validates the id and body similarly. Response
  envelope is unchanged (`{success:true,data:{queued:true,id,duplicate?}}` /
  `queued:false,transcript_id`).
- `queue.sh`: removed hardcoded credential fallbacks, uses
  `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` from the environment or a
  gitignored `.env.chromescribe`; no shared cookie jar; no `-L`, `--proto
  '=https'`, `-f`, and max-time on every call; validates the success envelope
  and the queue row shape; aborts nonzero on fetch/API/downloader/mark-done
  failure; marks failed rows and continues, exiting nonzero if any row or
  mark-done failed.
- `monitor.sh`: `queue.sh` invokes `--force` with `REQUIRE_ANALYZE=1`, so the
  queue only records `done` once transcription *and* `/analyze` succeed.
  Ordinary cron runs and manual `--force` remain best-effort.
- Documented the canonical Android repo
  (https://github.com/valentinyeo/chromescribe-android); the in-repo
  `android/` prototype folder is kept for history but no longer evolves.

### Deployment

- Apply the additive migration, then deploy the Worker. Preserve live
  prompts/models: only the queue route, helper module, migration and shell
  changes are intended for production.