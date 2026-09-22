// Tests for the Android queue's strict URL parser and race-free enqueue.
// Run with: node --test dashboard/test/
//
// Uses Node's built-in node:sqlite as an in-memory stand-in for D1 so the
// real SQL (partial unique index + ON CONFLICT) is exercised, not a mock of
// our own assumptions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { parseStrictYouTubeUrl, enqueueSharedUrl } from '../src/queue-lib.mjs';

const SCHEMA = `
CREATE TABLE transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL
);
CREATE TABLE queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    video_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_queue_status ON queue(status);
CREATE UNIQUE INDEX idx_queue_pending_video ON queue(video_id) WHERE status = 'pending';
`;

/** Minimal D1-compatible adapter over node:sqlite. */
function makeD1() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  return {
    raw,
    prepare(sql) {
      const stmt = raw.prepare(sql);
      let params = [];
      const api = {
        bind(...args) {
          params = args;
          return api;
        },
        async first() {
          return stmt.get(...params) ?? null;
        },
        async run() {
          const result = stmt.run(...params);
          return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
        },
      };
      return api;
    },
  };
}

test('strict parser accepts canonical YouTube shapes', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=abcdefghijk', 'abcdefghijk'],
    ['https://youtube.com/watch?v=abcdefghijk&t=42', 'abcdefghijk'],
    ['https://m.youtube.com/watch?v=abcdefghijk', 'abcdefghijk'],
    ['https://youtu.be/abcdefghijk', 'abcdefghijk'],
    ['https://youtu.be/abcdefghijk?si=tracking', 'abcdefghijk'],
    ['https://www.youtube.com/shorts/abcdefghijk', 'abcdefghijk'],
    ['https://m.youtube.com/live/abcdefghijk', 'abcdefghijk'],
    ['  https://www.youtube.com/watch?v=abcdefghijk  ', 'abcdefghijk'],
  ];
  for (const [url, id] of cases) {
    const parsed = parseStrictYouTubeUrl(url);
    assert.ok(parsed, `expected ${url} to parse`);
    assert.equal(parsed.id, id);
    // Always normalised so downstream yt-dlp never sees attacker input.
    assert.equal(parsed.url, `https://www.youtube.com/watch?v=${id}`);
  }
});

test('strict parser rejects hostile / malformed input', () => {
  const bad = [
    'https://evil.com/watch?v=abcdefghijk',
    'https://youtube.com.evil.tld/watch?v=abcdefghijk',
    'https://evil.tld/?u=https://youtube.com/watch?v=abcdefghijk',
    'https://notyoutube.com/watch?v=abcdefghijk',
    'http://www.youtube.com/watch?v=abcdefghijk', // non-https
    'https://www.youtube.com/watch?v=short', // not 11 chars
    'https://www.youtube.com/watch?v=abcdefghijkl', // 12 chars
    'https://www.youtube.com/watch', // missing v
    'https://www.youtube.com/embed/abcdefghijk', // unsupported path
    'https://www.youtube.com/watch?v=abc$efghijk', // invalid chars
    'https://user:pass@youtube.com/watch?v=abcdefghijk', // embedded creds
    'https://youtube.com:8443/watch?v=abcdefghijk', // non-standard port
    'https://music.youtube.com/watch?v=abcdefghijk', // not in allow-list
    'javascript:alert(1)',
    'ftp://youtube.com/watch?v=abcdefghijk',
    '',
    '   ',
  ];
  for (const url of bad) {
    assert.equal(parseStrictYouTubeUrl(url), null, `expected ${url} to be rejected`);
  }
  assert.equal(parseStrictYouTubeUrl(123), null);
  assert.equal(parseStrictYouTubeUrl(null), null);
});

test('first enqueue inserts a pending row', async () => {
  const db = makeD1();
  const result = await enqueueSharedUrl(db, 'https://youtu.be/abcdefghijk');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { queued: true, id: 1 });
  const { n } = db.raw.prepare("SELECT COUNT(*) AS n FROM queue WHERE status='pending'").get();
  assert.equal(n, 1);
  // youtu.be is normalised before storage.
  const row = db.raw.prepare('SELECT url FROM queue WHERE id = 1').get();
  assert.equal(row.url, 'https://www.youtube.com/watch?v=abcdefghijk');
});

test('duplicate enqueue returns the same pending row, no new insert', async () => {
  const db = makeD1();
  const first = await enqueueSharedUrl(db, 'https://www.youtube.com/watch?v=abcdefghijk');
  const second = await enqueueSharedUrl(db, 'https://youtu.be/abcdefghijk?si=x');
  assert.equal(second.status, 200);
  assert.deepEqual(second.data, { queued: true, id: first.data.id, duplicate: true });
  const { n } = db.raw.prepare("SELECT COUNT(*) AS n FROM queue WHERE status='pending'").get();
  assert.equal(n, 1);
});

test('concurrent enqueues cannot create two pending rows', async () => {
  const db = makeD1();
  const [a, b] = await Promise.all([
    enqueueSharedUrl(db, 'https://www.youtube.com/watch?v=abcdefghijk'),
    enqueueSharedUrl(db, 'https://youtu.be/abcdefghijk'),
  ]);
  assert.equal(a.data.id, b.data.id);
  const dupes = [a.data, b.data].filter((d) => d.duplicate === true);
  assert.equal(dupes.length, 1, 'exactly one of the two requests should report duplicate');
  const { n } = db.raw.prepare("SELECT COUNT(*) AS n FROM queue WHERE status='pending'").get();
  assert.equal(n, 1);
});

test('already-transcribed video is not queued', async () => {
  const db = makeD1();
  db.raw.prepare('INSERT INTO transcripts (video_id, title) VALUES (?, ?)').run('abcdefghijk', 'Done');
  const result = await enqueueSharedUrl(db, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.deepEqual(result, { status: 200, data: { queued: false, transcript_id: 1 } });
  const { n } = db.raw.prepare('SELECT COUNT(*) AS n FROM queue').get();
  assert.equal(n, 0);
});

test('a video can be re-queued after the previous attempt failed', async () => {
  const db = makeD1();
  const first = await enqueueSharedUrl(db, 'https://www.youtube.com/watch?v=abcdefghijk');
  db.raw.prepare("UPDATE queue SET status='failed' WHERE id=?").run(first.data.id);
  const second = await enqueueSharedUrl(db, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(second.status, 200);
  assert.deepEqual(second.data, { queued: true, id: 2 });
});

test('rejected URL returns 400 and writes nothing', async () => {
  const db = makeD1();
  const result = await enqueueSharedUrl(db, 'https://evil.com/watch?v=abcdefghijk');
  assert.equal(result.status, 400);
  assert.equal(result.error, 'Unsupported URL');
  const { n } = db.raw.prepare('SELECT COUNT(*) AS n FROM queue').get();
  assert.equal(n, 0);
});