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

function api(db, path = 'channels', method = 'GET', input) {
  return worker.fetch(new Request(`https://test.example/api/${path}`, {
    method, ...(['POST', 'PATCH'].includes(method) ? { body: JSON.stringify(method === 'PATCH' ? input : { input }) } : {}),
  }), { DB: db });
}
const newId = 'UCaaaaaaaaaaaaaaaaaaaaaa';

test('lazy table starts empty, has paused default, never seeds and initializes once', async () => {
  const db = makeD1();
  const responses = await Promise.all([api(db), api(db)]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, []);
  }
  await api(db);
  assert.equal(db.queries.filter(sql => sql.startsWith('ALTER TABLE')).length, 1);
  assert.equal(db.queries.filter(sql => sql.startsWith('CREATE TABLE')).length, 1);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'channels_seed'").get().n, 0);
  const paused = db.raw.prepare('PRAGMA table_info(channels)').all().find(column => column.name === 'paused');
  assert.equal(paused.notnull, 1);
  assert.equal(paused.dflt_value, '0');
});

test('existing production table gains paused without adding or replacing subscriptions', async () => {
  const db = makeD1({ legacy: true });
  const rows = (await (await api(db)).json()).data;
  assert.deepEqual(rows, [{ id: 'tiktok:@old', handle: '@old', name: 'Old', platform: 'tiktok', paused: 0 }]);
  await api(db);
  assert.equal(db.queries.filter(sql => sql.startsWith('ALTER TABLE')).length, 1);
});

test('schema errors other than duplicate paused propagate and allow retry', async () => {
  const db = makeD1();
  const prepare = db.prepare;
  let fail = true;
  db.prepare = sql => {
    if (sql.startsWith('ALTER TABLE') && fail) return { run() { throw new Error('D1_ERROR: database unavailable'); } };
    return prepare(sql);
  };
  assert.equal((await api(db)).status, 500);
  fail = false;
  assert.equal((await api(db)).status, 200);
});

test('unsubscribing all channels never reseeds, and transcripts remain untouched', async () => {
  const db = makeD1();
  await api(db, 'channels', 'POST', 'tiktok:@mine');
  const rows = (await (await api(db)).json()).data;
  for (const row of rows) {
    const response = await api(db, 'channels/' + encodeURIComponent(row.id), 'DELETE');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.deleted, true);
  }
  assert.deepEqual((await (await api(db)).json()).data, []);
  assert.equal((await api(db, 'channels/' + rows[0].id, 'DELETE')).status, 404);
  assert.deepEqual({ ...db.raw.prepare('SELECT * FROM transcripts').get() }, { id: 'old', channel: 'Old channel' });
  for (const id of ['%ZZ', 'junk', 'tiktok%3A%40bad%2Fname']) {
    assert.equal((await api(db, 'channels/' + id, 'DELETE')).status, 400);
  }
});

test('TikTok subscribe normalizes, deduplicates, and supports encoded DELETE', async () => {
  const db = makeD1();
  const first = await api(db, 'channels', 'POST', 'https://tiktok.com/@New.User');
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).data, {
    id: 'tiktok:@new.user', handle: '@new.user', name: 'new.user', platform: 'tiktok', paused: 0, already_exists: false,
  });
  const again = await api(db, 'channels', 'POST', 'tiktok:@NEW.USER');
  assert.equal((await again.json()).data.already_exists, true);
  assert.equal((await api(db, 'channels/tiktok%3A%40new.user', 'DELETE')).status, 200);
});

test('YouTube handle resolution prefers externalId and og:title, deduplicating atomically', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return new Response(`<meta content="New &amp; Cool" property="og:title"><script>{"externalId":"${newId}","channelId":"UCbbbbbbbbbbbbbbbbbbbbbb"}</script>`);
  });
  const db = makeD1();
  const results = await Promise.all(['@newchannel', 'https://youtube.com/@newchannel/videos'].map(input => api(db, 'channels', 'POST', input)));
  const rows = await Promise.all(results.map(res => res.json()));
  assert.ok(results.every(res => res.status === 200));
  assert.deepEqual(rows[0].data, { id: newId, handle: '@newchannel', name: 'New & Cool', platform: 'youtube', paused: 0, already_exists: false });
  assert.equal(rows[1].data.already_exists, true);
  assert.deepEqual(calls, ['https://www.youtube.com/@newchannel', 'https://www.youtube.com/@newchannel']);
  const byId = await api(db, 'channels', 'POST', newId);
  assert.equal((await byId.json()).data.already_exists, true);
  assert.equal(calls.length, 2, 'known IDs need no network');
});

test('YouTube channelId and JSON metadata fallback supports direct channel IDs', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, `https://www.youtube.com/channel/${newId}`);
    return new Response(JSON.stringify({ channelId: newId, channelMetadataRenderer: {
      title: 'A "quoted" channel', vanityChannelUrl: 'https://www.youtube.com/@newchannel',
    } }));
  });
  const response = await api(makeD1(), 'channels', 'POST', `https://www.youtube.com/channel/${newId}/videos`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    id: newId, handle: '@newchannel', name: 'A "quoted" channel', platform: 'youtube', paused: 0, already_exists: false,
  });
});

test('invalid JSON, input, unresolved pages, and network failures return clear 400 errors', async t => {
  const db = makeD1();
  const malformed = await worker.fetch(new Request('https://test.example/api/channels', { method: 'POST', body: '{' }), { DB: db });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'Invalid JSON body');
  for (const input of [undefined, null, 'junk', 'https://example.com/@handle']) {
    const res = await api(db, 'channels', 'POST', input);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Enter a YouTube/);
  }
  const count = db.raw.prepare('SELECT count(*) AS n FROM channels').get().n;
  for (const outcome of ['missing', 'error', 'network', 'wrong-id']) {
    t.mock.method(globalThis, 'fetch', async () => {
      if (outcome === 'network') throw new Error('Network failed');
      return new Response(outcome === 'wrong-id' ? '{"externalId":"UCbbbbbbbbbbbbbbbbbbbbbb"}' : 'No channel metadata', { status: outcome === 'error' ? 404 : 200 });
    });
    const res = await api(db, 'channels', 'POST', outcome === 'wrong-id' ? newId : '@doesnotexist');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Could not resolve/);
    t.mock.restoreAll();
  }
  assert.equal(db.raw.prepare('SELECT count(*) AS n FROM channels').get().n, count);
});

test('an already populated table is not supplemented with defaults', async () => {
  const db = makeD1();
  await api(db);
  db.raw.prepare('INSERT INTO channels(id, platform, handle, name) VALUES (?, ?, ?, ?)').run(newId, 'youtube', '@mine', 'Mine');
  assert.deepEqual((await (await api(db)).json()).data.map(row => row.id), [newId]);
});

test('PATCH pauses and resumes both platforms and active=1 excludes only paused subscriptions', async t => {
  const db = makeD1();
  t.mock.method(globalThis, 'fetch', async () => new Response(`{"externalId":"${newId}"}`));
  for (const input of [newId, 'tiktok:@mine']) await api(db, 'channels', 'POST', input);
  const getRows = async (query = '') => (await (await api(db, 'channels' + query)).json()).data;
  for (const id of [newId, 'tiktok:@mine']) {
    const response = await api(db, 'channels/' + encodeURIComponent(id), 'PATCH', { paused: true });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.paused, 1);
    assert.ok((await getRows()).some(row => row.id === id && row.paused === 1));
    assert.ok((await getRows('?active=1')).every(row => row.id !== id && row.paused === 0));
    const again = await api(db, 'channels', 'POST', id);
    assert.equal((await again.json()).data.paused, 1, 'subscribing again does not resume');
  }
  assert.deepEqual(await getRows('?active=1'), []);
  assert.equal((await getRows()).length, 2);
  assert.equal((await getRows('?active=0')).length, 2);
  const resumed = await api(db, 'channels/tiktok%3A%40mine', 'PATCH', { paused: false });
  assert.equal((await resumed.json()).data.paused, 0);
  assert.deepEqual((await getRows('?active=1')).map(row => row.id), ['tiktok:@mine']);
  assert.deepEqual({ ...db.raw.prepare('SELECT * FROM transcripts').get() }, { id: 'old', channel: 'Old channel' });
});

test('PATCH strictly validates JSON, boolean shape and channel IDs, and reports unknown subscriptions', async () => {
  const db = makeD1();
  await api(db, 'channels', 'POST', 'tiktok:@mine');
  for (const body of [null, [], {}, true, { paused: 0 }, { paused: 1 }, { paused: 'true' }, { paused: null },
    { paused: true, extra: 1 }]) {
    assert.equal((await api(db, 'channels/tiktok%3A%40mine', 'PATCH', body)).status, 400, JSON.stringify(body));
  }
  const malformed = await worker.fetch(new Request('https://test.example/api/channels/tiktok%3A%40mine', {
    method: 'PATCH', body: '{',
  }), { DB: db });
  assert.equal(malformed.status, 400);
  for (const id of ['%ZZ', 'junk', 'tiktok%3A%40bad%2Fname']) {
    assert.equal((await api(db, 'channels/' + id, 'PATCH', { paused: true })).status, 400);
  }
  assert.equal((await api(db, 'channels/' + newId, 'PATCH', { paused: true })).status, 404);
  assert.equal((await (await api(db)).json()).data[0].paused, 0);
});

test('CORS preflight permits the pause method', async () => {
  const response = await worker.fetch(new Request('https://test.example/api/channels/tiktok%3A%40mine', {
    method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'PATCH' },
  }), {});
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('Access-Control-Allow-Methods').split(', ').includes('PATCH'));
});

test('an older channels table without an id column is kept aside, not dropped', async () => {
  const db = makeD1();
  db.raw.exec("CREATE TABLE channels (channel_id TEXT, title TEXT); INSERT INTO channels VALUES ('x', 'Old row')");
  const res = await api(db);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, []);
  assert.equal(db.raw.prepare('SELECT title FROM channels_legacy').get().title, 'Old row');
});
