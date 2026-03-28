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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_video_id ON transcripts(video_id);
CREATE INDEX IF NOT EXISTS idx_created_at ON transcripts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_title ON transcripts(title);
