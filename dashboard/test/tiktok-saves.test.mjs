import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../../extension/tiktok-saves.js', import.meta.url), 'utf8');

function load({ favs, queueOk = () => true, queueResponse }) {
  const store = {};
  const posted = [];
  const postOptions = [];
  const ctx = {
    self: {}, console: { log() {} }, URL, JSON, Date, Set, Array,
    chrome: {
      runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
      alarms: { get() {}, create() {}, onAlarm: { addListener() {} } },
      storage: { local: {
        get: async (k) => ({ [k]: store[k] }),
        set: async (o) => Object.assign(store, o),
      } },
    },
    fetch: async (url, opts = {}) => {
      if (url.includes('tiktok.com/api')) return { status: 200, json: async () => ({ itemList: favs() }) };
      const { url: u } = JSON.parse(opts.body);
      posted.push(u);
      postOptions.push(opts);
      if (queueResponse) return queueResponse(u);
      const ok = queueOk(u);
      return { ok, status: ok ? 200 : 500, json: async () => ({ success: ok }) };
    },
  };
  vm.runInNewContext(src, ctx);
  return { check: () => vm.runInNewContext('check()', ctx), store, posted, postOptions };
}

const item = (id, extra = {}) => ({ id, author: { uniqueId: 'u' }, ...extra });

test('first run seeds without queueing; later runs queue only new videos', async () => {
  let list = [item('1'), item('2')];
  const ext = load({ favs: () => list });
  await ext.check();
  assert.equal(ext.posted.length, 0);
  assert.equal(ext.store.status.seeded, 2);

  list = [item('4', { imagePost: {} }), item('3'), item('1'), item('2')];
  await ext.check();
  assert.deepEqual(ext.posted, ['https://www.tiktok.com/@u/video/3']);

  await ext.check();
  assert.equal(ext.posted.length, 1, 'already-queued saves are not sent again');
});

test('a failed enqueue is retried on the next run', async () => {
  let list = [item('1')];
  let up = false;
  const ext = load({ favs: () => list, queueOk: () => up });
  await ext.check();
  list = [item('2'), item('1')];
  await ext.check();
  assert.equal(ext.store.status.ok, false);
  up = true;
  await ext.check();
  assert.deepEqual(ext.posted, ['https://www.tiktok.com/@u/video/2', 'https://www.tiktok.com/@u/video/2']);
  assert.equal(ext.store.status.ok, true);
});

test('an empty favourites response never seeds', async () => {
  const ext = load({ favs: () => [] });
  await ext.check();
  assert.equal(ext.store.seen, undefined);
  assert.equal(ext.store.status.ok, false);
});

test('every queue POST uses the browser login without Access service headers', async () => {
  let list = [item('1')];
  const ext = load({ favs: () => list });
  await ext.check();
  list = [item('3'), item('2'), item('1')];
  await ext.check();
  assert.equal(ext.postOptions.length, 2);
  for (const opts of ext.postOptions) {
    assert.equal(opts.method, 'POST');
    assert.equal(opts.credentials, 'include');
    assert.equal(opts.redirect, 'manual');
    assert.deepEqual(Object.keys(opts.headers), ['Content-Type']);
    assert.equal(opts.headers['Content-Type'], 'application/json');
    assert.equal(Object.keys(opts.headers).some((name) => /^CF-Access/i.test(name)), false);
  }
});

test('signed out pauses after one POST and catches up after sign in', async () => {
  let list = [item('1')];
  let signedOut = true;
  const ext = load({
    favs: () => list,
    queueResponse: () => signedOut
      ? { type: 'opaqueredirect', status: 0, ok: false }
      : { status: 200, ok: true, json: async () => ({ success: true }) },
  });
  await ext.check();
  list = [item('3'), item('2'), item('1')];
  await ext.check();
  assert.deepEqual(ext.posted, ['https://www.tiktok.com/@u/video/2']);
  assert.equal(ext.store.status.ok, false);
  assert.match(ext.store.status.error, /Sign/);
  assert.equal(ext.store.seen.includes('2'), false);
  assert.equal(ext.store.seen.includes('3'), false);

  signedOut = false;
  await ext.check();
  assert.deepEqual(ext.posted.slice(1), ['https://www.tiktok.com/@u/video/2', 'https://www.tiktok.com/@u/video/3']);
  assert.equal(ext.store.seen.includes('2'), true);
  assert.equal(ext.store.seen.includes('3'), true);
  assert.equal(ext.store.status.ok, true);
});

for (const response of [
  { type: 'opaqueredirect', status: 302, ok: false },
  { status: 0, ok: false },
  { status: 401, ok: false },
  { status: 403, ok: false },
]) {
  test(`signed out response ${response.type || response.status} preserves earlier queued saves`, async () => {
    let list = [item('1')];
    const ext = load({
      favs: () => list,
      queueResponse: (url) => url.endsWith('/2')
        ? { status: 200, ok: true, json: async () => ({ success: true }) }
        : response,
    });
    await ext.check();
    list = [item('4'), item('3'), item('2'), item('1')];
    await ext.check();
    assert.deepEqual(ext.posted, ['https://www.tiktok.com/@u/video/2', 'https://www.tiktok.com/@u/video/3']);
    assert.equal(ext.store.seen.includes('2'), true);
    assert.equal(ext.store.seen.includes('3'), false);
    assert.equal(ext.store.seen.includes('4'), false);
    assert.equal(ext.store.status.ok, false);
    assert.equal(ext.store.status.error, 'Signed out of ChromeScribe: open https://chromescribe.yeoux.net once to sign in');
    assert.deepEqual(Array.from(ext.store.status.queued), ['https://www.tiktok.com/@u/video/2']);
    assert.deepEqual(Array.from(ext.store.status.failed), []);
  });
}
