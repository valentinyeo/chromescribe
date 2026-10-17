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
  assert.deepEqual(rows, [{ id: 'tiktok:@old', handle: '@old', name: 'Old', platform: 'tiktok', paused: 0, transcripts: 0 }]);
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

test('API never allows calls from other websites', async () => {
  const preflight = await worker.fetch(new Request('https://test.example/api/channels/tiktok%3A%40mine', {
    method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'DELETE', Origin: 'https://evil.example' },
  }), {});
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), null);
  const list = await api(makeD1());
  assert.equal(list.headers.get('Access-Control-Allow-Origin'), null);
});

test('an older channels table without an id column is kept aside, not dropped', async () => {
  const db = makeD1();
  db.raw.exec("CREATE TABLE channels (channel_id TEXT, title TEXT); INSERT INTO channels VALUES ('x', 'Old row')");
  const res = await api(db);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, []);
  assert.equal(db.raw.prepare('SELECT title FROM channels_legacy').get().title, 'Old row');
});

test('GET channel counts match transcript channel names exactly, including zero and paused rows', async () => {
  const db = makeD1();
  await api(db);
  db.raw.exec(`INSERT INTO channels(id, platform, handle, name, paused) VALUES
    ('${newId}', 'youtube', '@old', 'Old channel', 1),
    ('UCbbbbbbbbbbbbbbbbbbbbbb', 'youtube', '@none', 'No transcripts', 0),
    ('tiktok:@mine', 'tiktok', '@mine', 'Mine', 0);
    INSERT INTO transcripts VALUES ('two', 'Old channel'), ('three', 'Mine'),
      ('four', 'Old channel extra'), ('five', 'old channel')`);
  const rows = (await (await api(db)).json()).data;
  assert.equal(rows.find(row => row.id === newId).transcripts, 2);
  assert.equal(rows.find(row => row.handle === '@none').transcripts, 0);
  assert.equal(rows.find(row => row.handle === '@mine').transcripts, 1);
  const active = (await (await api(db, 'channels?active=1')).json()).data;
  assert.equal(active.length, 2);
  assert.ok(active.every(row => row.paused === 0 && Number.isInteger(row.transcripts)));
});

test('http and https vanity URLs resolve @handles and prefer real titles over IDs and handles', async t => {
  for (const protocol of ['http', 'https']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(`
      <meta property="og:title" content="${newId}">
      <title>Jake &amp; Friends &#39;News&#39; - YouTube</title>
      {"externalId":"${newId}","channelMetadataRenderer":{"description":"First","title":"@jaketrinder"},
       "vanityChannelUrl":"${protocol}://www.youtube.com/@jaketrinder"}`));
    const response = await api(makeD1(), 'channels', 'POST', newId);
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.handle, '@jaketrinder');
    assert.equal(data.name, "Jake & Friends 'News'");
    t.mock.restoreAll();
  }
});

test('missing real page titles use the feed author even when the page resolves successfully', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    return new Response(url.includes('/feeds/') ? '<feed><author><name>Jake &amp; Co</name></author></feed>' :
      `{"externalId":"${newId}","vanityChannelUrl":"http://www.youtube.com/@jaketrinder"}`);
  });
  const response = await api(makeD1(), 'channels', 'POST', newId);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.name, 'Jake & Co');
  assert.equal(calls.length, 2);
});

test('blocked channel pages fall back to the decoded feed author', async t => {
  t.mock.method(globalThis, 'fetch', async url => new Response(url.includes('/feeds/') ?
    '<author><name>Jake &#x26; Co</name></author>' : '', { status: url.includes('/feeds/') ? 200 : 403 }));
  const response = await api(makeD1(), 'channels', 'POST', newId);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.name, 'Jake & Co');
});

async function seedRefresh(db, handle = newId, name = newId) {
  await api(db);
  db.raw.prepare('INSERT INTO channels(id, platform, handle, name, paused) VALUES (?, ?, ?, ?, ?)')
    .run(newId, 'youtube', handle, name, 1);
}

test('refresh repairs existing YouTube names and http handles without changing IDs, pause or transcripts', async t => {
  const db = makeD1();
  await seedRefresh(db);
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, `https://www.youtube.com/channel/${newId}`);
    return new Response(`<meta property="og:title" content="Jake Trinder">{"externalId":"${newId}",
      "vanityChannelUrl":"http://www.youtube.com/@jaketrinder"}`);
  });
  const response = await api(db, `channels/${newId}/refresh`, 'POST');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    id: newId, name: 'Jake Trinder', handle: '@jaketrinder', platform: 'youtube', paused: 1,
  });
  const row = db.raw.prepare('SELECT * FROM channels WHERE id = ?').get(newId);
  assert.equal(row.handle, '@jaketrinder');
  assert.equal(row.name, 'Jake Trinder');
  assert.deepEqual({ ...db.raw.prepare('SELECT * FROM transcripts').get() }, { id: 'old', channel: 'Old channel' });
});

test('refresh never degrades a real name or @handle with placeholder metadata', async t => {
  const db = makeD1();
  await seedRefresh(db, '@jaketrinder', 'Jake Trinder');
  for (const name of [newId, '@jaketrinder', 'jaketrinder', '']) {
    t.mock.method(globalThis, 'fetch', async url => new Response(url.includes('/feeds/') ? '' :
      `{"externalId":"${newId}","channelMetadataRenderer":{"title":"${name}"}}`));
    const response = await api(db, `channels/${newId}/refresh`, 'POST');
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.name, 'Jake Trinder');
    assert.equal(data.handle, '@jaketrinder');
    t.mock.restoreAll();
  }
});

test('refresh validates IDs, reports unknown channels and resolution failures, and leaves TikTok untouched', async t => {
  const db = makeD1();
  for (const id of ['%ZZ', 'junk', 'tiktok%3A%40bad%2Fname']) {
    assert.equal((await api(db, `channels/${id}/refresh`, 'POST')).status, 400);
  }
  assert.equal((await api(db, `channels/${newId}/refresh`, 'POST')).status, 404);
  await seedRefresh(db, '@jaketrinder', 'Jake Trinder');
  await api(db, 'channels', 'POST', 'tiktok:@mine');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline'); });
  const unchanged = (await (await api(db, 'channels/tiktok%3A%40mine/refresh', 'POST')).json()).data;
  assert.equal(unchanged.name, 'mine');
  assert.equal(unchanged.handle, '@mine');
  assert.equal(fetch.mock.callCount(), 0, 'TikTok refresh makes no network requests');
  assert.equal((await api(db, `channels/${newId}/refresh`, 'POST')).status, 400);
  assert.equal(db.raw.prepare('SELECT name FROM channels WHERE id = ?').get(newId).name, 'Jake Trinder');
});

test('display-name capitalization is preserved when it resembles the handle', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(`
    <meta property="og:title" content="JakeTrinder">
    {"externalId":"${newId}","vanityChannelUrl":"http://www.youtube.com/@jaketrinder"}`));
  const response = await api(makeD1(), 'channels', 'POST', newId);
  assert.equal((await response.json()).data.name, 'JakeTrinder');
});

test('refresh with a blocked page can improve the name through RSS without losing a real handle', async t => {
  const db = makeD1();
  await seedRefresh(db, '@jaketrinder');
  t.mock.method(globalThis, 'fetch', async url => new Response(url.includes('/feeds/') ?
    '<author><name>Jake Trinder</name></author>' : '', { status: url.includes('/feeds/') ? 200 : 403 }));
  const response = await api(db, `channels/${newId}/refresh`, 'POST');
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.name, 'Jake Trinder');
  assert.equal(data.handle, '@jaketrinder');
});

test('a slower refresh with missing metadata cannot overwrite a concurrent successful repair', async t => {
  const db = makeD1();
  await seedRefresh(db);
  let release, signalStarted;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { signalStarted = resolve; });
  let pages = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('/feeds/')) {
      signalStarted();
      await waiting;
      return new Response('');
    }
    pages++;
    return new Response(pages === 1 ? `{"externalId":"${newId}"}` :
      `<meta property="og:title" content="Jake Trinder">{"externalId":"${newId}","vanityChannelUrl":"http://www.youtube.com/@jaketrinder"}`);
  });
  const slower = api(db, `channels/${newId}/refresh`, 'POST');
  await started;
  const faster = await api(db, `channels/${newId}/refresh`, 'POST');
  assert.equal(faster.status, 200);
  release();
  const response = await slower;
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.name, 'Jake Trinder');
  assert.equal(data.handle, '@jaketrinder');
  assert.equal(db.raw.prepare('SELECT handle FROM channels WHERE id = ?').get(newId).handle, '@jaketrinder');
});
