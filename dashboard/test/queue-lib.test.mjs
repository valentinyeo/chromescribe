import worker from '../src/index.ts';
// Tests for the Android queue's strict URL parser and race-free enqueue.
// Run with: node --test dashboard/test/
//
// Uses Node's built-in node:sqlite as an in-memory stand-in for D1 so the
// real SQL (partial unique index + ON CONFLICT) is exercised, not a mock of
// our own assumptions.

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { parseStrictYouTubeUrl, parseSharedUrl, hashUrl, listPendingQueue, enqueueSharedUrl } from '../src/queue-lib.mjs';

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
        async all() { return { results: stmt.all(...params) }; },
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
  assert.deepEqual(result.data, { queued: true, platform: 'youtube', id: 1 });
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
  assert.deepEqual(second.data, { queued: true, platform: 'youtube', id: first.data.id, duplicate: true });
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
  assert.deepEqual(result, { status: 200, data: { queued: false, platform: 'youtube', transcript_id: 1 } });
  const { n } = db.raw.prepare('SELECT COUNT(*) AS n FROM queue').get();
  assert.equal(n, 0);
});

test('a video can be re-queued after the previous attempt failed', async () => {
  const db = makeD1();
  const first = await enqueueSharedUrl(db, 'https://www.youtube.com/watch?v=abcdefghijk');
  db.raw.prepare("UPDATE queue SET status='failed' WHERE id=?").run(first.data.id);
  const second = await enqueueSharedUrl(db, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(second.status, 200);
  assert.deepEqual(second.data, { queued: true, platform: 'youtube', id: 2 });
});

test('rejected URL returns 400 and writes nothing', async () => {
  const db = makeD1();
  const result = await enqueueSharedUrl(db, 'http://evil.com/watch?v=abcdefghijk');
  assert.equal(result.status, 400);
  assert.equal(result.error, 'Unsupported URL');
  const { n } = db.raw.prepare('SELECT COUNT(*) AS n FROM queue').get();
  assert.equal(n, 0);
});

test('shared parser supports full and short TikTok with exact hosts', () => {
  for (const host of ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']) {
    assert.deepEqual(parseSharedUrl(`https://${host}/@a.b/video/123456789012345?track=x`), {
      platform: 'tiktok', prefixedId: 'tiktok:123456789012345', url: 'https://www.tiktok.com/@a.b/video/123456789012345',
    });
  }
  for (const host of ['vm.tiktok.com', 'vt.tiktok.com']) {
    assert.deepEqual(parseSharedUrl(`https://${host}/Ab123/?x=y`), {
      platform: 'tiktok', prefixedId: 'tiktok-short:Ab123', url: `https://${host}/Ab123/`,
    });
  }
  for (const url of ['https://tiktok.com.evil.tld/@u/video/123456789012345',
    'https://youtube.com.evil.tld/watch?v=abcdefghijk', 'https://tiktok.com/@u/video/1234',
    'https://tiktok.com/@u/video/1234567890123456789012', 'https://vt.tiktok.com/a/b',
    'https://vm.tiktok.com/a-b', 'http://tiktok.com/@u/video/123456789012345',
    'https://tiktok.com:444/@u/video/123456789012345', 'https://youtube.com/watch?v=short']) {
    assert.equal(parseSharedUrl(url), null, url);
  }
  assert.equal(parseSharedUrl('https://youtu.be/abcdefghijk').prefixedId, 'abcdefghijk');
});

test('articles strip fragments and share the transcript hash implementation', () => {
  const url = 'https://example.com/story?q=1';
  assert.deepEqual(parseSharedUrl(url + '#section'), { platform: 'article', url, prefixedId: `article:${hashUrl(url)}` });
  assert.equal(hashUrl('abc'), '0b885c8b');
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(index, /import \{[^}]*hashUrl[^}]*\} from '\.\/queue-lib\.mjs'/);
  assert.match(index, /const id = hashUrl\(url\)/);
  assert.doesNotMatch(index, /(?:const|function) hashUrl/);
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://127.0.0.1/',
    'https://[::1]/', 'https://2130706433/', 'https://localhost/', 'https://localhost./',
    'https://a.local/', 'https://a.internal/', 'https://example.com/' + 'x'.repeat(2048), '', null]) {
    assert.equal(parseSharedUrl(url), null, String(url));
  }
});

test('GET platform filtering precedes limit and preserves unfiltered behavior', async () => {
  const db = makeD1();
  for (let i = 0; i < 12; i++) db.raw.prepare('INSERT INTO queue(url, video_id) VALUES (?, ?)').run('https://example.com', `youtube${i}`);
  for (const id of ['article:abc', 'tiktok:123', 'tiktok-short:Abc']) db.raw.prepare('INSERT INTO queue(url, video_id) VALUES (?, ?)').run('https://example.com', id);
  assert.equal((await listPendingQueue(db, new URLSearchParams())).data.length, 10);
  const filtered = await listPendingQueue(db, new URLSearchParams('platforms=article,tiktok'));
  assert.deepEqual(filtered.data.map(r => r.video_id), ['article:abc', 'tiktok:123', 'tiktok-short:Abc']);
  for (const q of ['platforms=', 'platforms=foo', 'platforms=youtube,', 'platforms=YouTube', 'platforms=youtube&platforms=article']) {
    assert.equal((await listPendingQueue(db, new URLSearchParams(q))).status, 400);
  }
});


test('Worker GET validates filters and POST shares article IDs with ingestion', async () => {
  const db = makeD1();
  const env = { DB: db };
  const request = (path, init) => worker.fetch(new Request('https://test.example/api/' + path, init), env);
  const post = await request('queue', { method: 'POST', body: JSON.stringify({url: 'https://example.com/post#anchor'}) });
  assert.equal(post.status, 200);
  assert.equal((await post.json()).data.platform, 'article');
  const filtered = await request('queue?platforms=article');
  const rows = (await filtered.json()).data;
  assert.equal(rows[0].video_id, `article:${hashUrl('https://example.com/post')}`);
  assert.deepEqual((await (await request('queue?platforms=youtube')).json()).data, []);
  assert.equal((await request('queue?platforms=invalid')).status, 400);
  assert.equal((await (await request('queue')).json()).data.length, 1);
  const again = await request('queue', { method: 'POST', body: JSON.stringify({url: 'https://example.com/post#different'}) });
  assert.equal((await again.json()).data.duplicate, true);
});


test('article URL containing a video link keeps its article ID during ingestion', async () => {
  for (const embedded of ['https://youtube.com/watch?v=abcdefghijk', 'https://tiktok.com/@u/video/123456789012345']) {
    const url = 'https://example.com/read?next=' + embedded;
    const parsed = parseSharedUrl(url);
    assert.equal(parsed.platform, 'article');
    const db = makeD1();
    db.raw.prepare('INSERT INTO transcripts(video_id, title) VALUES (?, ?)').run(parsed.prefixedId, 'Existing article');
    const response = await worker.fetch(new Request('https://test.example/api/transcribe', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({url, markdown_content:'# Article'}),
    }), {DB: db});
    const payload = await response.json();
    assert.equal(payload.data.video_id, parsed.prefixedId);
    assert.equal(payload.data.already_exists, true);
  }
});
