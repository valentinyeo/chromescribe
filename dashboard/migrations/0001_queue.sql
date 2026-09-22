-- 0001_queue.sql
-- Creates the Android share queue used by POST /api/queue and drained by
-- queue.sh (cron -> monitor.sh --force).
--
-- Additive only:
--   * never touches the transcripts table
--   * never deletes or rewrites queue rows
--
-- The partial unique index is the race guard for duplicate pending rows:
-- two concurrent POST /api/queue requests for the same video now collide on
-- the index and the second one returns the existing row instead of inserting.
--
-- Limitation: if a database already has *duplicate pending* rows for the
-- same video_id, `CREATE UNIQUE INDEX ...` below will fail and the migration
-- will abort. The production queue table exists but is empty, so the index
-- builds cleanly there. If duplicates ever appear, resolve them by marking
-- the extra rows `failed` (a status change, not a delete) and re-run.

CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    video_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_pending_video
    ON queue(video_id) WHERE status = 'pending';