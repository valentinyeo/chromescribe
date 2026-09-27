// The TikTok Saves extension must never import favourites that existed before
// its first run, must queue each new save once, and must retry failed ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../../extension/tiktok-saves.js', import.meta.url), 'utf8');

function load({ favs, queueOk = () => true }) {
  const store = {};
  const posted = [];
  const ctx = {
    self: {}, console: { log() {} }, URL, JSON, Date, Set, Array,
    importScripts: () => { ctx.self.CS_ACCESS = { id: 'i', secret: 's' }; },
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
      const ok = queueOk(u);
      return { ok, status: ok ? 200 : 500, json: async () => ({ success: ok }) };
    },
  };
  vm.runInNewContext(src, ctx);
  return { check: () => vm.runInNewContext('check()', ctx), store, posted };
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
