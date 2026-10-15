import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.ts';

function makeD1({ legacy = false } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec("CREATE TABLE transcripts (id TEXT PRIMARY KEY, channel TEXT); INSERT INTO transcripts VALUES ('old', 'Old channel')");
  if (legacy) raw.exec(`CREATE TABLE channels (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, handle TEXT NOT NULL, name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ); INSERT INTO channels(id, platform, handle, name) VALUES ('tiktok:@old', 'tiktok', '@old', 'Old')`);
  const queries = [];
  return {
    raw, queries,
    prepare(sql) {
      queries.push(sql);
      let params = [];
      return {
        bind(...args) { params = args; return this; },
        async all() { return { results: raw.prepare(sql).all(...params) }; },
        async first() { return raw.prepare(sql).get(...params) || null; },
        run() { return { meta: { changes: raw.prepare(sql).run(...params).changes } }; },
      };
    },
    async batch(statements) {
      raw.exec('BEGIN');
      try {
        const results = statements.map(stmt => stmt.run());
        raw.exec('COMMIT');
        return results;
      } catch (err) { raw.exec('ROLLBACK'); throw err; }
    },
  };
}


function storage() {
  const objects = new Map();
  return {
    objects,
    async put(key, value) { objects.set(key, value); },
    async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
    async delete(key) { objects.delete(key); },
  };
}
function setup() {
  const DB = makeD1();
  const TRANSCRIPTS = storage();
  const env = { DB, TRANSCRIPTS };
  const call = (path, method = 'GET', body) => worker.fetch(new Request('https://test.example' + path, {
    method, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  }), env);
  return { DB, TRANSCRIPTS, call };
}
const valid = { title: 'A report', channel: 'Channel', topic: 'Clients', html: '<!doctype html><h1>Answer</h1>' };

test('reports lazily create an empty table and complete create/list/get/delete lifecycle', async () => {
  const { DB, TRANSCRIPTS, call } = setup();
  assert.deepEqual((await (await call('/api/reports')).json()).data, []);
  const created = await call('/api/reports', 'POST', valid);
  assert.equal(created.status, 200);
  const { id, url } = (await created.json()).data;
  assert.match(id, /^[a-f0-9]{12}$/);
  assert.equal(url, 'https://chromescribe.yeoux.net/reports/' + id);
  assert.equal(TRANSCRIPTS.objects.get(`reports/${id}.html`), valid.html);
  const rows = (await (await call('/api/reports')).json()).data;
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], created_at: undefined }, { id, title: valid.title, channel: valid.channel, topic: valid.topic, created_at: undefined });
  assert.ok(rows[0].created_at);
  const page = await call('/reports/' + id);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), valid.html);
  assert.equal(page.headers.get('Content-Type'), 'text/html; charset=utf-8');
  const csp = page.headers.get('Content-Security-Policy');
  for (const directive of ["default-src 'none'", "script-src 'none'", "style-src 'unsafe-inline' https://fonts.googleapis.com", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", 'sandbox']) assert.ok(csp.includes(directive), directive);
  assert.equal(page.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await call('/reports/' + id, 'HEAD')).status, 200);
  assert.equal((await call('/reports/' + id, 'POST', 'x')).status, 405);
  const deleted = await call('/api/reports/' + id, 'DELETE');
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).data.deleted, true);
  assert.equal(TRANSCRIPTS.objects.size, 0);
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM reports').get().n, 0);
  assert.equal((await call('/reports/' + id)).status, 404);
  assert.equal((await call('/api/reports/' + id, 'DELETE')).status, 404);
  assert.deepEqual((await (await call('/api/reports')).json()).data, []);
});

test('reports list newest first including same-second creates', async () => {
  const { call, DB } = setup();
  for (const title of ['First', 'Second', 'Third']) await call('/api/reports', 'POST', { ...valid, title });
  let rows = (await (await call('/api/reports')).json()).data;
  assert.deepEqual(rows.map(row => row.title), ['Third', 'Second', 'First']);
  DB.raw.prepare("UPDATE reports SET created_at = '2099-01-01' WHERE title = 'First'").run();
  rows = (await (await call('/api/reports')).json()).data;
  assert.equal(rows[0].title, 'First');
});

test('reports validate JSON, all string fields, blank strings and UTF-8 byte limit', async () => {
  const { call, TRANSCRIPTS } = setup();
  for (const body of ['{', null, [], true, {}, ...Object.keys(valid).flatMap(key =>
    [undefined, null, 42, {}, [], '', '   '].map(value => ({ ...valid, [key]: value })))]) {
    const response = await call('/api/reports', 'POST', body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  for (const html of ['x'.repeat(2 * 1024 * 1024 + 1), 'é'.repeat(1024 * 1024 + 1)]) {
    assert.equal((await call('/api/reports', 'POST', { ...valid, html })).status, 400);
  }
  assert.equal(TRANSCRIPTS.objects.size, 0);
  assert.equal((await call('/api/reports', 'POST', { ...valid, html: 'é'.repeat(1024 * 1024) })).status, 200);
});

test('invalid IDs and traversal cannot delete a report or read report storage as HTML', async () => {
  const { call, TRANSCRIPTS } = setup();
  await call('/api/reports', 'POST', valid);
  for (const id of ['bad', '%ZZ', 'aa%2Fbb', 'a'.repeat(13)]) {
    assert.equal((await call('/api/reports/' + id, 'DELETE')).status, 400);
    assert.equal((await call('/reports/' + id)).status, 404);
  }
  assert.equal(TRANSCRIPTS.objects.size, 1);
});

test('failed D1 insertion removes orphan HTML and failed R2 writes never insert a row', async () => {
  const { call, DB, TRANSCRIPTS } = setup();
  const prepare = DB.prepare;
  DB.prepare = sql => sql.startsWith('INSERT INTO reports') ? { bind() { return this; }, run() { throw Error('insert failed'); } } : prepare(sql);
  assert.equal((await call('/api/reports', 'POST', valid)).status, 500);
  assert.equal(TRANSCRIPTS.objects.size, 0);
  DB.prepare = prepare;
  TRANSCRIPTS.put = async () => { throw Error('R2 failed'); };
  assert.equal((await call('/api/reports', 'POST', valid)).status, 500);
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM reports').get().n, 0);
});

test('reports dashboard is explicitly served as HTML', async () => {
  const { call, TRANSCRIPTS } = setup();
  TRANSCRIPTS.objects.set('reports.html', '<h1>Reports</h1>');
  const response = await call('/reports.html');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(await response.text(), '<h1>Reports</h1>');
});
