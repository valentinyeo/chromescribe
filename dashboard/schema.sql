-- ChromeScribe Dashboard Database Schema

CREATE TABLE IF NOT EXISTS transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    channel TEXT DEFAULT 'Unknown',
    duration INTEGER DEFAULT 0,
    srt_path TEXT NOT NULL,
    word_count INTEGER DEFAULT 0,
    thumbnail_url TEXT,
    category TEXT,
    tags TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_video_id ON transcripts(video_id);
CREATE INDEX IF NOT EXISTS idx_created_at ON transcripts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_title ON transcripts(title);
CREATE INDEX IF NOT EXISTS idx_category ON transcripts(category);

-- Queue of URLs shared from the Android companion app.
-- queue.sh (cron, on the box with yt-dlp) drains pending rows via monitor.sh --force.
CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    video_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | failed
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    finished_at DATETIME,
    error TEXT,
    attempts INTEGER DEFAULT 0,
    transcript_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);

-- Race guard for the Android queue: at most one pending row per video_id.
-- Mirrors dashboard/migrations/0001_queue.sql; keep both in sync.
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_pending_video
    ON queue(video_id) WHERE status = 'pending';
