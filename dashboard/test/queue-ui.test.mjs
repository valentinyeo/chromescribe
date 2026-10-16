import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker from '../src/index.ts';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/queue.html');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const now = Date.parse('2026-01-02T12:00:00Z');
const base = { id: 1, status: 'pending', video_id: 'abcdefghijk', url: 'https://youtu.be/abcdefghijk', created_at: '2026-01-02 11:48:00', started_at: null, finished_at: null, attempts: 0 };
const settle = () => new Promise(resolve => setImmediate(resolve));

async function setup(initial = [], { hidden = false, payload, ok = true } = {}) {
  const elements = Object.fromEntries(['count', 'error', 'processing', 'pending', 'failed', 'done'].map(id => [id, {
    textContent: '', innerHTML: '', handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; },
  }]));
  const handlers = {};
  const calls = [];
  const timers = [];
  const confirms = [];
  let response = payload ?? { success: true, data: structuredClone(initial) };
  let responseOk = ok;
  class FixedDate extends Date { static now() { return now; } }
  const document = { hidden, getElementById: id => elements[id], addEventListener(type, handler) { handlers[type] = handler; } };
  const context = vm.createContext({
    document, Date: FixedDate,
    setInterval: (callback, milliseconds) => { timers.push({ callback, milliseconds }); },
    confirm: text => { confirms.push(text); return true; },
    fetch: async (url, options) => {
      calls.push(structuredClone({ url, ...options }));
      return { ok: responseOk, json: async () => response };
    },
  });
  vm.runInContext(code, context);
  await settle();
  return { context, elements, calls, timers, document, handlers, confirms,
    respond(payload, ok = true) { response = payload; responseOk = ok; } };
}

function action(id, action) {
  const button = { disabled: false, dataset: { id, action } };
  return { button, event: { target: { closest: () => button } } };
}

test('queue static page has matching theme, accessible sections and responsive rows', () => {
  for (const heading of ['In progress', 'Waiting', 'Failed', 'Done recently']) assert.ok(html.includes('>' + heading + '</h2>'));
  assert.match(html, /family=Geist/);
  assert.match(html, /--background: #030303/);
  assert.match(html, /overflow-wrap: anywhere/);
  assert.match(html, /role="alert"/);
  assert.match(html, /role="status"/);
  assert.match(html, /@media \(max-width: 600px\)/);
  assert.match(html, /newest 200 entries/);
});

test('queue groups statuses, numbers oldest pending first, labels laptop/server and renders relative plus recorded timestamps', async () => {
  const { elements, calls, context } = await setup([
    { ...base, id: 2, title: 'Newer pending', video_id: 'tiktok-short:ABC', created_at: '2026-01-02 11:50:00' },
    { ...base, id: 3, title: 'Article pending', video_id: 'article:abc', created_at: '2026-01-02 11:48:00' },
    { ...base, title: 'Older pending' },
    { ...base, id: 4, title: 'Working', status: 'processing', started_at: '2026-01-02 11:55:00' },
    { ...base, id: 5, title: 'Broken', status: 'failed', error: 'Download failed', attempts: 3, finished_at: '2026-01-02 11:59:00' },
    { ...base, id: 6, title: 'Finished', status: 'done', transcript_id: 42, finished_at: '2026-01-02 11:59:00' },
  ]);
  assert.equal(elements.count.textContent, '6 queue entries');
  assert.ok(elements.pending.innerHTML.indexOf('#1 Older pending') < elements.pending.innerHTML.indexOf('#2 Article pending'));
  assert.ok(elements.pending.innerHTML.indexOf('#2 Article pending') < elements.pending.innerHTML.indexOf('#3 Newer pending'));
  assert.equal((elements.pending.innerHTML.match(/runs on the server/g) || []).length, 2);
  assert.equal((elements.pending.innerHTML.match(/runs on the laptop/g) || []).length, 1);
  for (const platform of ['TikTok', 'Article', 'YouTube']) assert.ok(elements.pending.innerHTML.includes(platform));
  assert.match(elements.pending.innerHTML, /Added: 12 min ago/);
  assert.match(elements.pending.innerHTML, /Started: Not recorded/);
  assert.match(elements.processing.innerHTML, /Started: 5 min ago/);
  assert.match(elements.processing.innerHTML, /title="2026-01-02 11:55:00"/);
  assert.match(elements.failed.innerHTML, /Finished: 1 min ago/);
  assert.match(elements.failed.innerHTML, /Download failed/);
  assert.match(elements.failed.innerHTML, /Attempts: 3/);
  assert.match(elements.failed.innerHTML, />Retry<|>Remove</);
  assert.match(elements.done.innerHTML, /href="\/transcript.html\?id=42">Finished<\/a>/);
  assert.deepEqual(calls, [{ url: '/api/queue/all?limit=200', credentials: 'include' }]);
  assert.equal(context.relativeTime('2026-01-02T10:00:00+00:00'), '2 hr ago');
  assert.equal(context.relativeTime('2025-12-31 12:00:00'), '2 days ago');
  assert.equal(context.relativeTime('invalid'), 'Not recorded');
  assert.equal(context.relativeTime(null), 'Not recorded');
});

test('all rendered fields escape HTML and untrusted transcript IDs cannot become links', async () => {
  const hostile = '<img src=x onerror="alert(1)"> & \'test\'';
  const { elements } = await setup([
    { ...base, id: hostile, status: 'failed', title: hostile, channel: hostile, error: hostile, attempts: hostile, created_at: hostile, started_at: hostile, finished_at: hostile },
    { ...base, id: 2, status: 'done', title: hostile, transcript_id: '1" onclick="alert(1)' },
    { ...base, id: 3, url: hostile },
  ]);
  for (const section of ['pending', 'failed', 'done']) {
    const rendered = elements[section].innerHTML;
    assert.match(rendered, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; &#39;test&#39;/);
    assert.doesNotMatch(rendered, /<img|onclick=|<a href=/);
  }
  assert.match(elements.failed.innerHTML, /data-id="&lt;img/);
  assert.match(elements.failed.innerHTML, /Attempts: &lt;img/);
});

test('done recently shows only 30 latest completions, including legacy rows without finished_at', async () => {
  const rows = Array.from({ length: 35 }, (_, index) => ({ ...base, id: index + 1, status: 'done', title: 'Done ' + (index + 1), transcript_id: index + 1, finished_at: `2026-01-02 11:${String(index).padStart(2, '0')}:00` }));
  rows.push({ ...base, id: 36, status: 'done', title: 'Legacy newest', created_at: '2026-01-02 11:59:00' });
  const { elements } = await setup(rows);
  assert.equal((elements.done.innerHTML.match(/class="channel-row"/g) || []).length, 30);
  assert.match(elements.done.innerHTML, /Legacy newest/);
  assert.ok(elements.done.innerHTML.indexOf('Legacy newest') < elements.done.innerHTML.indexOf('>Done 35<'));
  assert.doesNotMatch(elements.done.innerHTML, />Done [1-6]</);
});

test('empty and failed loads are visible and errors use textContent, preserving previous successful results', async () => {
  const empty = await setup();
  for (const status of ['processing', 'pending', 'failed', 'done']) assert.match(empty.elements[status].innerHTML, /Nothing here/);
  for (const [payload, ok, error] of [[{ success: false, error: '<API unavailable>' }, false, '<API unavailable>'], [{ success: true, data: null }, true, 'Could not load queue']]) {
    const r = await setup([], { payload, ok });
    assert.equal(r.elements.error.textContent, error);
    assert.equal(r.elements.count.textContent, 'Queue unavailable');
  }
  const r = await setup([base]);
  const old = r.elements.pending.innerHTML;
  r.respond({ success: false, error: 'Network failed' }, false);
  await r.context.loadQueue();
  assert.equal(r.elements.pending.innerHTML, old);
  assert.equal(r.elements.error.textContent, 'Network failed');
});

test('auto-refresh runs every 15 seconds only while visible and refreshes immediately on return', async () => {
  const r = await setup([base]);
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0].milliseconds, 15000);
  r.calls.length = 0;
  r.document.hidden = true;
  r.timers[0].callback();
  r.handlers.visibilitychange();
  await settle();
  assert.equal(r.calls.length, 0);
  r.document.hidden = false;
  r.handlers.visibilitychange();
  await settle();
  assert.equal(r.calls.length, 1);
  r.timers[0].callback();
  await settle();
  assert.equal(r.calls.length, 2);
  const hidden = await setup([base], { hidden: true });
  assert.equal(hidden.calls.length, 0);
});

test('Retry PUTs pending, Remove DELETEs after confirmation, reloads and exposes API conflicts', async () => {
  const r = await setup([{ ...base, status: 'failed' }]);
  r.calls.length = 0;
  const retry = action('1', 'retry');
  await r.elements.failed.handlers.click(retry.event);
  assert.deepEqual(r.calls[0], { url: '/api/queue/1', method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"status":"pending"}', credentials: 'include' });
  assert.equal(r.calls[1].url, '/api/queue/all?limit=200');
  assert.equal(retry.button.disabled, false);
  const remove = action('1', 'remove');
  await r.context.changeQueue(remove.event);
  assert.equal(r.confirms.length, 1);
  assert.deepEqual(r.calls[2], { url: '/api/queue/1', method: 'DELETE', credentials: 'include' });
  r.respond({ success: false, error: 'This video already has a pending row' }, false);
  await r.context.changeQueue(retry.event);
  assert.equal(r.elements.error.textContent, 'This video already has a pending row');
  assert.equal(retry.button.disabled, false);
  const before = r.calls.length;
  retry.button.disabled = true;
  await r.context.changeQueue(retry.event);
  assert.equal(r.calls.length, before);
});

test('all dashboard nav, both deployment paths, Worker static allowlist and docs include queue', async () => {
  for (const page of ['index', 'settings', 'stats', 'subscriptions', 'reports', 'transcript']) assert.match(read(`../public/${page}.html`), /href="\/queue.html"[^>]*>Queue<\/a>/);
  for (const page of ['subscriptions', 'reports']) assert.match(html, new RegExp(`href="/${page}.html"`));
  assert.match(read('../deploy.sh'), /STATIC_PAGES=\([^\n]*queue.html\)/);
  assert.match(read('../../.github/workflows/deploy.yml'), /wrangler r2 object put chromescribe-transcripts\/queue.html --file=.\/public\/queue.html --remote/);
  const doc = read('../README.md');
  for (const endpoint of ['GET /api/queue/all?limit=200', 'DELETE /api/queue/:id', 'PUT /api/queue/:id', '/queue.html']) assert.ok(doc.includes(endpoint));
  const objects = [];
  const response = await worker.fetch(new Request('https://test.example/queue.html'), { TRANSCRIPTS: { async get(key) { objects.push(key); return { body: html }; } } });
  assert.equal(response.status, 200);
  assert.deepEqual(objects, ['queue.html']);
  assert.equal(await response.text(), html);
  assert.match(response.headers.get('Content-Security-Policy'), /default-src 'self'/);
  const missing = await worker.fetch(new Request('https://test.example/queue.html'), { TRANSCRIPTS: { async get() { return null; } } });
  assert.equal(missing.status, 404);
});

test('Telegram and all printed or opened shell transcript URLs use public domain while API hosts remain untouched', () => {
  const monitor = read('../../monitor.sh');
  const process = read('../../process.sh');
  const queue = read('../../queue.sh');
  assert.match(monitor, /local cs_url="https:\/\/chromescribe.yeoux.net\/transcript.html\?id=\$transcript_id"/);
  assert.equal((process.match(/DASHBOARD_URL="https:\/\/chromescribe.yeoux.net\/transcript.html\?id=\$\{TRANSCRIPT_ID\}"/g) || []).length, 3);
  for (const source of [monitor, process, queue]) {
    assert.doesNotMatch(source, /\$(?:DASHBOARD_URL|DASHBOARD_BASE)\/transcript.html/);
    assert.match(source, /https:\/\/chromescribe-dashboard\.ancient-glitter-9ac9\.workers.dev/);
  }
});
