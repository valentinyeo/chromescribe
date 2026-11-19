import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.ts';
import { ensureQueue } from '../src/queue-lib.mjs';

function makeD1({ current = false } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(current ? readFileSync(new URL('../schema.sql', import.meta.url), 'utf8') : `
    CREATE TABLE transcripts (id INTEGER PRIMARY KEY, video_id TEXT UNIQUE, title TEXT, channel TEXT);
    CREATE TABLE queue (id INTEGER PRIMARY KEY, url TEXT, video_id TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE UNIQUE INDEX idx_queue_pending_video ON queue(video_id) WHERE status = 'pending';`);
  const queries = [];
  return {
    raw, queries,
    prepare(sql) {
      queries.push(sql);
      let params = [];
      return {
        bind(...args) { params = args; return this; },
        async first() { return raw.prepare(sql).get(...params) || null; },
        async all() { return { results: raw.prepare(sql).all(...params) }; },
        async run() { return { meta: { changes: raw.prepare(sql).run(...params).changes } }; },
      };
    },
  };
}
function api(db, path = 'queue/all', method = 'GET', body) {
  return worker.fetch(new Request('https://test.example/api/' + path, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { DB: db });
}
function insert(db, video = 'abcdefghijk', status = 'pending', date = '2026-01-01 00:00:00') {
  return Number(db.raw.prepare('INSERT INTO queue(url, video_id, status, created_at) VALUES (?, ?, ?, ?)')
    .run('https://youtu.be/' + video, video, status, date).lastInsertRowid);
}
function row(db, id = 1) { return db.raw.prepare('SELECT * FROM queue WHERE id = ?').get(id); }

test('TikTok path shares enqueue once and reach only the TikTok drain', async () => {
  const db = makeD1();
  const first = await api(db, 'queue', 'POST', { url: 'https://www.tiktok.com/t/ZP8abc123/?track=phone' });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { success: true, data: { queued: true, id: 1, platform: 'tiktok' } });
  const duplicate = await api(db, 'queue', 'POST', { url: 'https://m.tiktok.com/t/ZP8abc123' });
  assert.deepEqual(await duplicate.json(), { success: true, data: { queued: true, id: 1, platform: 'tiktok', duplicate: true } });
  const pending = await (await api(db, 'queue?platforms=tiktok')).json();
  assert.deepEqual(pending.data, [{ id: 1, url: 'https://www.tiktok.com/t/ZP8abc123/', video_id: 'tiktok-short:ZP8abc123' }]);
  assert.deepEqual((await (await api(db, 'queue?platforms=youtube,article')).json()).data, []);
});

test('malformed TikTok path shares never reach the queue', async () => {
  const db = makeD1();
  for (const url of [
    'https://www.tiktok.com/t/', 'https://www.tiktok.com/t/a-b/',
    'https://www.tiktok.com/t/abc/extra', 'https://www.tiktok.com/t/%61bc/',
    'https://www.tiktok.com.evil.com/t/abc/', 'https://www.tiktok.com:8443/t/abc/',
    'https://vm.tiktok.com/t/abc/', 'https://vt.tiktok.com/t/abc/',
  ]) {
    assert.equal((await api(db, 'queue', 'POST', { url })).status, 400, url);
  }
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM queue').get().n, 0);
});

test('lazy migration adds nullable columns once per binding even with concurrent requests and preserves old rows', async () => {
  const db = makeD1();
  insert(db);
  const responses = await Promise.all([api(db), api(db)]);
  assert.ok(responses.every(response => response.status === 200));
  await api(db);
  assert.equal(db.queries.filter(sql => sql.startsWith('ALTER TABLE')).length, 5);
  const columns = db.raw.prepare('PRAGMA table_info(queue)').all();
  for (const name of ['started_at', 'finished_at', 'error', 'attempts', 'transcript_id']) {
    assert.equal(columns.find(column => column.name === name).notnull, 0, name);
  }
  assert.equal(row(db).attempts, 0);
  assert.equal(row(db).url, 'https://youtu.be/abcdefghijk');
  const other = makeD1();
  await api(other);
  assert.equal(other.queries.filter(sql => sql.startsWith('ALTER TABLE')).length, 5);
});

test('current schema tolerates only duplicate-column errors and failed migration can retry', async () => {
  const current = makeD1({ current: true });
  assert.equal((await api(current)).status, 200);
  const db = makeD1();
  const prepare = db.prepare;
  let fail = true;
  db.prepare = sql => sql.startsWith('ALTER TABLE') && fail ? {
    run() { throw new Error('D1_ERROR: database unavailable'); },
  } : prepare(sql);
  assert.equal((await api(db)).status, 500);
  fail = false;
  assert.equal((await api(db)).status, 200);
  const wrongDuplicate = makeD1();
  wrongDuplicate.prepare = () => ({ run() { throw new Error('duplicate column name: unrelated'); } });
  await assert.rejects(ensureQueue(wrongDuplicate), /unrelated/);
});

test('processing claims atomically, timestamps and increments attempts, done attaches transcript and finishes', async () => {
  const db = makeD1();
  insert(db);
  const claims = await Promise.all([api(db, 'queue/1', 'PUT', { status: 'processing' }), api(db, 'queue/1', 'PUT', { status: 'processing' })]);
  assert.deepEqual(claims.map(response => response.status).sort(), [200, 409]);
  assert.equal(row(db).status, 'processing');
  assert.equal(row(db).attempts, 1);
  assert.ok(row(db).started_at);
  assert.equal(row(db).finished_at, null);
  assert.equal((await api(db, 'queue/1', 'PUT', { status: 'done', transcript_id: 42 })).status, 200);
  assert.equal(row(db).status, 'done');
  assert.equal(row(db).transcript_id, 42);
  assert.ok(row(db).finished_at);
  assert.equal(row(db).attempts, 1);
});

test('failed captures trimmed bounded error, retry clears failure fields and next processing increments attempts', async () => {
  const db = makeD1();
  insert(db);
  await api(db, 'queue/1', 'PUT', { status: 'processing' });
  assert.equal((await api(db, 'queue/1', 'PUT', { status: 'failed', error: '  ERROR: ' + 'x'.repeat(600) + '  ' })).status, 200);
  assert.equal(row(db).error, 'ERROR: ' + 'x'.repeat(493));
  assert.ok(row(db).finished_at);
  assert.equal((await api(db, 'queue/1', 'PUT', { status: 'pending', error: 'ignored' })).status, 200);
  assert.equal(row(db).status, 'pending');
  assert.equal(row(db).error, null);
  assert.equal(row(db).finished_at, null);
  assert.equal(row(db).attempts, 1);
  await api(db, 'queue/1', 'PUT', { status: 'processing' });
  assert.equal(row(db).attempts, 2);
  assert.equal((await api(db, 'queue/1', 'PUT', { status: 'failed' })).status, 200);
  assert.equal(row(db).error, null);
});

test('retry only permits failed rows and partial unique index rejects duplicate pending retry with 409', async () => {
  const db = makeD1();
  for (const [index, status] of ['pending', 'processing', 'done', 'failed'].entries()) insert(db, String(index), status);
  for (const id of [1, 2, 3]) assert.equal((await api(db, 'queue/' + id, 'PUT', { status: 'pending' })).status, 409);
  insert(db, '3');
  const conflict = await api(db, 'queue/4', 'PUT', { status: 'pending' });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /already has a pending/);
  assert.equal(row(db, 4).status, 'failed');
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM queue WHERE video_id = '3' AND status = 'pending'").get().n, 1);
  await api(db, 'queue/5', 'DELETE');
  assert.equal((await api(db, 'queue/4', 'PUT', { status: 'pending' })).status, 200);
});

test('delete removes nonprocessing rows, rejects processing and returns 404 for missing rows', async () => {
  const db = makeD1();
  for (const [index, status] of ['pending', 'processing', 'done', 'failed'].entries()) insert(db, String(index), status);
  for (const id of [1, 3, 4]) {
    const response = await api(db, 'queue/' + id, 'DELETE');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.deleted, true);
    assert.equal(row(db, id), undefined);
  }
  assert.equal((await api(db, 'queue/2', 'DELETE')).status, 409);
  assert.equal(row(db, 2).status, 'processing');
  assert.equal((await api(db, 'queue/99', 'DELETE')).status, 404);
});

test('all joins transcripts by video_id, returns every status newest first and validates limits without altering pending feed', async () => {
  const db = makeD1();
  for (const [index, status] of ['pending', 'processing', 'failed', 'done'].entries()) insert(db, String(index), status, '2026-01-02 00:00:00');
  insert(db, 'older', 'pending', '2026-01-01 00:00:00');
  db.raw.exec("INSERT INTO transcripts VALUES (42, '3', 'A title', 'A channel')");
  const all = (await (await api(db, 'queue/all?limit=200')).json()).data;
  assert.deepEqual(all.map(item => item.id), [4, 3, 2, 1, 5]);
  assert.equal(all[0].title, 'A title');
  assert.equal(all[0].channel, 'A channel');
  assert.equal(all[0].transcript_id, 42);
  assert.equal(all[1].title, null);
  assert.equal(all[1].transcript_id, null);
  await api(db, 'queue/4', 'PUT', { status: 'done', transcript_id: 99 });
  assert.equal((await (await api(db, 'queue/all?limit=1')).json()).data[0].transcript_id, 99);
  const pending = (await (await api(db, 'queue')).json()).data;
  assert.deepEqual(pending, [{ id: 1, url: 'https://youtu.be/0', video_id: '0' }, { id: 5, url: 'https://youtu.be/older', video_id: 'older' }]);
  for (const limit of ['', '0', '-1', '1.5', 'NaN', '1001', '1&limit=2']) assert.equal((await api(db, 'queue/all?limit=' + limit)).status, 400);
  for (let i = 0; i < 210; i++) insert(db, 'extra' + i, 'done');
  assert.equal((await (await api(db)).json()).data.length, 200);
});

test('invalid IDs, malformed JSON, unsupported statuses and invalid optional fields reject without mutation', async () => {
  const db = makeD1();
  insert(db);
  for (const method of ['PUT', 'DELETE']) {
    for (const id of ['bad', '0', '-1', '1/extra', '9007199254740992']) assert.equal((await api(db, 'queue/' + id, method, method === 'PUT' ? { status: 'done' } : undefined)).status, 400);
  }
  for (const body of [null, {}, [], { status: 'bad' }, { status: 'failed', error: 1 }, { status: 'failed', error: null },
    { status: 'done', transcript_id: 0 }, { status: 'done', transcript_id: '1' }, { status: 'done', transcript_id: 1.5 }]) {
    assert.equal((await api(db, 'queue/1', 'PUT', body)).status, 400);
  }
  const malformed = await worker.fetch(new Request('https://test.example/api/queue/1', { method: 'PUT', body: '{' }), { DB: db });
  assert.equal(malformed.status, 400);
  assert.equal((await api(db, 'queue/99', 'PUT', { status: 'done' })).status, 404);
  assert.equal(row(db).status, 'pending');
});

test('legacy drainer can mark done or failed without processing first', async () => {
  const db = makeD1();
  insert(db);
  insert(db, 'bbbbbbbbbbb');
  assert.equal((await api(db, 'queue/1', 'PUT', { status: 'done' })).status, 200);
  assert.equal((await api(db, 'queue/2', 'PUT', { status: 'failed' })).status, 200);
  assert.equal(row(db).attempts, 0);
  assert.ok(row(db).finished_at);
});

function backdateClaim(db, id, seconds) {
  db.raw.prepare("UPDATE queue SET started_at = datetime('now', ?) WHERE id = ?").run(`-${seconds} seconds`, id);
}

test('a row stuck in processing past the lease is listed again and can be claimed', async () => {
  const db = makeD1();
  insert(db);
  assert.equal((await api(db, 'queue/1', 'PUT', { status: 'processing' })).status, 200);
  backdateClaim(db, 1, 31 * 60);
  const listed = (await (await api(db, 'queue')).json()).data;
  assert.deepEqual(listed.map(item => item.id), [1]);
  assert.equal(row(db).status, 'pending');
  assert.equal(row(db).attempts, 2);
  assert.equal((await api(db, 'queue/1', 'PUT', { status: 'processing' })).status, 200);
  assert.equal(row(db).status, 'processing');
  assert.equal(row(db).attempts, 3);
});

test('a processing row inside the lease stays out of the pending feed', async () => {
  const db = makeD1();
  insert(db);
  assert.equal((await api(db, 'queue/1', 'PUT', { status: 'processing' })).status, 200);
  backdateClaim(db, 1, 60);
  assert.deepEqual((await (await api(db, 'queue')).json()).data, []);
  assert.equal(row(db).status, 'processing');
  assert.equal(row(db).attempts, 1);
});

test('concurrent listings reclaim one stale row exactly once', async () => {
  const db = makeD1();
  insert(db);
  assert.equal((await api(db, 'queue/1', 'PUT', { status: 'processing' })).status, 200);
  backdateClaim(db, 1, 31 * 60);
  const lists = await Promise.all([api(db, 'queue'), api(db, 'queue')]);
  assert.ok(lists.every(response => response.status === 200));
  assert.equal(row(db).status, 'pending');
  assert.equal(row(db).attempts, 2);
});

test('a stale row past the attempt limit fails for the operator instead of listing', async () => {
  const db = makeD1();
  insert(db);
  assert.equal((await api(db, 'queue/1', 'PUT', { status: 'processing' })).status, 200);
  db.raw.prepare('UPDATE queue SET attempts = 2 WHERE id = 1').run();
  backdateClaim(db, 1, 31 * 60);
  assert.deepEqual((await (await api(db, 'queue')).json()).data, []);
  assert.equal(row(db).status, 'failed');
  assert.match(row(db).error, /drainer stopped before finishing/i);
  assert.ok(row(db).finished_at);
});

test('a stale row never becomes a second pending row for the same video', async () => {
  const db = makeD1();
  insert(db);
  assert.equal((await api(db, 'queue/1', 'PUT', { status: 'processing' })).status, 200);
  insert(db);
  backdateClaim(db, 1, 31 * 60);
  const response = await api(db, 'queue');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map(item => item.id), [2]);
  assert.equal(row(db, 1).status, 'processing');
});
