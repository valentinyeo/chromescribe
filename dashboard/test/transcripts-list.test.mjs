import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker from '../src/index.ts';

function makeEnv(count = 7) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const files = new Map();
  const insert = raw.prepare('INSERT INTO transcripts(id, video_id, title, channel, duration, srt_path, word_count, category, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (let id = 1; id <= count; id++) {
    const day = String(id % 28 + 1).padStart(2, '0');
    const month = String(Math.floor(id / 28) % 12 + 1).padStart(2, '0');
    insert.run(id, 'vid' + String(id).padStart(8, '0'), id === 1 ? 'Needle in the haystack' : 'Fixture video ' + id,
      id % 2 ? 'Odd Channel' : 'Even Channel', 60 * id, `fixtures/${id}.srt`, 100 + id,
      id % 2 ? 'Health' : 'AI', JSON.stringify(['tag' + id]), `2025-${month}-${day} 10:00:00`);
    files.set(`fixtures/${id}.srt`, `1\n00:00:00,000 --> 00:00:01,000\nFixture words ${id}\n`);
  }
  const DB = {
    raw,
    prepare(sql) {
      let params = [];
      return {
        bind(...args) { params = args; return this; },
        async first() { return raw.prepare(sql).get(...params) || null; },
        async all() { return { results: raw.prepare(sql).all(...params).map(row => ({ ...row })) }; },
        async run() { return { meta: { changes: raw.prepare(sql).run(...params).changes } }; },
      };
    },
  };
  const TRANSCRIPTS = {
    files,
    async get(key) { return files.has(key) ? { body: files.get(key), text: async () => files.get(key) } : null; },
    async delete(key) { files.delete(key); },
  };
  return { DB, TRANSCRIPTS };
}

function call(env, path, init = {}) {
  return worker.fetch(new Request('https://test.example/api/' + path, init), env);
}

async function list(env, query = '') {
  const response = await call(env, 'transcripts' + query);
  assert.equal(response.status, 200);
  return response.json();
}

const ids = body => body.data.map(row => row.id);

test('limit and offset page the list newest first and report the total', async () => {
  const env = makeEnv();
  const newest = ids(await list(env)).slice(0, 7);
  const first = await list(env, '?limit=3');
  assert.equal(first.success, true);
  assert.deepEqual(ids(first), newest.slice(0, 3));
  assert.equal(first.total, 7);
  assert.deepEqual(ids(await list(env, '?limit=3&offset=3')), newest.slice(3, 6));
  assert.deepEqual(ids(await list(env, '?limit=3&offset=6')), newest.slice(6));
  assert.deepEqual(ids(await list(env, '?limit=3&offset=50')), []);
  assert.deepEqual(ids(await list(env, '?offset=5')), newest.slice(5));
});

test('paged rows carry what the cards show and leave out storage paths', async () => {
  const env = makeEnv();
  const [row] = (await list(env, '?limit=1')).data;
  for (const key of ['id', 'video_id', 'title', 'channel', 'duration_formatted', 'word_count', 'created_at_formatted', 'category', 'tags']) {
    assert.ok(key in row, key);
  }
  assert.equal('srt_path' in row, false);
});

test('limit is clamped between 1 and 500 and bad numbers fall back to defaults', async () => {
  const env = makeEnv(520);
  assert.equal((await list(env, '?limit=0')).data.length, 1);
  assert.equal((await list(env, '?limit=-4')).data.length, 1);
  assert.equal((await list(env, '?limit=100000')).data.length, 500);
  assert.equal((await list(env, '?limit=abc')).data.length, 500);
  assert.deepEqual(ids(await list(env, '?limit=2&offset=-9')), ids(await list(env, '?limit=2')));
});

test('paging has no gaps or repeats when rows share a timestamp', async () => {
  const env = makeEnv(30);
  env.DB.raw.exec("UPDATE transcripts SET created_at = '2025-05-05 05:05:05'");
  const seen = [];
  for (let offset = 0; offset < 30; offset += 7) seen.push(...ids(await list(env, `?limit=7&offset=${offset}`)));
  assert.equal(new Set(seen).size, 30);
});

test('the unpaged call returns every row in the same shape as before', async () => {
  const env = makeEnv(520);
  const all = await list(env);
  assert.equal(all.success, true);
  assert.equal(all.data.length, 520);
  assert.equal('total' in all, false);
  assert.equal(all.data[0].srt_path.endsWith('.srt'), true);
  assert.ok(all.data[0].duration_formatted && all.data[0].created_at_formatted);
  const byVideo = await list(env, '?video_id=vid00000003');
  assert.deepEqual(ids(byVideo), [3]);
});

test('the list answers 304 when the browser already holds the same page and changes when a row changes', async () => {
  const env = makeEnv();
  const first = await call(env, 'transcripts?limit=3');
  const etag = first.headers.get('ETag');
  assert.match(etag, /^"[0-9a-f]{64}"$/);
  assert.match(first.headers.get('Cache-Control'), /private/);
  const again = await call(env, 'transcripts?limit=3', { headers: { 'If-None-Match': 'W/' + etag } });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), '');
  env.DB.raw.exec("UPDATE transcripts SET title = 'Renamed' WHERE id = 7");
  const changed = await call(env, 'transcripts?limit=3', { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('ETag'), etag);
});

test('search finds a row that is outside the first page', async () => {
  const env = makeEnv(100);
  const firstPage = await list(env, '?limit=10');
  assert.equal(ids(firstPage).includes(1), false);
  const response = await call(env, 'search?q=Needle');
  assert.equal(response.status, 200);
  assert.deepEqual(ids(await response.json()), [1]);
  assert.equal((await call(env, 'search')).status, 400);
});

test('categories list counts that match filtering the full list by category', async () => {
  const env = makeEnv(40);
  const { data: categories } = await (await call(env, 'categories')).json();
  assert.deepEqual(categories.map(c => c.category).sort(), ['AI', 'Health']);
  const everything = (await list(env)).data;
  for (const { category, count } of categories) {
    assert.equal(everything.filter(row => row.category === category).length, count);
    assert.equal(count, 20);
  }
});

test('opening a transcript returns its metadata and its content', async () => {
  const env = makeEnv();
  const meta = await (await call(env, 'transcripts/4')).json();
  assert.equal(meta.data.title, 'Fixture video 4');
  const content = await call(env, 'transcript/4/content');
  assert.equal(content.status, 200);
  assert.match(await content.text(), /Fixture words 4/);
  assert.equal((await call(env, 'transcript/99/content')).status, 404);
  assert.equal((await call(env, 'transcripts/99')).status, 404);
});

test('delete removes the row and its content and the list shrinks', async () => {
  const env = makeEnv();
  const response = await call(env, 'transcripts/3', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.deleted, true);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM transcripts WHERE id = 3').get().n, 0);
  assert.equal(env.TRANSCRIPTS.files.has('fixtures/3.srt'), false);
  assert.equal(env.TRANSCRIPTS.files.has('fixtures/4.srt'), true);
  const after = await list(env, '?limit=50');
  assert.equal(after.total, 6);
  assert.equal(ids(after).includes(3), false);
  assert.equal((await call(env, 'transcripts/3', { method: 'DELETE' })).status, 404);
});

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const pageCode = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const tick = () => new Promise(resolve => setImmediate(resolve));

function clientSetup(count = 150) {
  const rows = Array.from({ length: count }, (_, index) => {
    const id = count - index;
    return {
      id, video_id: 'vid' + id, title: id === 1 ? 'Needle in the haystack' : 'Fixture video ' + id,
      channel: 'Channel ' + (id % 4), duration: 60, duration_formatted: '1:00', word_count: 10,
      created_at: new Date(Date.UTC(2025, 0, 1) + id * 3600000).toISOString(), created_at_formatted: 'Jan 1, 2025',
      category: id % 3 === 0 ? 'Health' : 'AI', tags: '[]',
    };
  });
  const calls = [];
  const observers = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    innerHTML: '', textContent: '', value: id === 'sortSelect' ? 'newest' : '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {},
    insertAdjacentHTML(_, markup) { this.innerHTML += markup; },
  }]));
  const context = vm.createContext({
    URL, URLSearchParams, setTimeout() {},
    location: new URL('https://chromescribe.yeoux.net/'),
    document: {
      getElementById(id) { assert.ok(elements[id], `Missing element: ${id}`); return elements[id]; },
      querySelector: () => ({ closest: () => ({ remove() {} }) }),
      addEventListener() {},
    },
    csTheme: { icon: () => '', label: () => '' },
    addEventListener() {}, scrollTo() {}, requestAnimationFrame: callback => callback(),
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null },
    history: { replaceState() {} },
    confirm: () => true,
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      unobserve() {}
    },
    fetch: async (url, options) => {
      calls.push(url);
      if (options?.method === 'DELETE') return { ok: true, json: async () => ({}) };
      const parsed = new URL(url, 'https://chromescribe.yeoux.net');
      if (parsed.pathname === '/api/transcripts') {
        const limit = Number(parsed.searchParams.get('limit'));
        const offset = Number(parsed.searchParams.get('offset') || 0);
        if (offset > 0) await gate;
        return { json: async () => ({ data: rows.slice(offset, offset + limit), total: rows.length }) };
      }
      return { json: async () => ({ data: [] }) };
    },
  });
  context.window = context;
  vm.runInContext(pageCode, context);
  context.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  const cards = () => (elements.videoGrid.innerHTML.match(/class="card"/g) || []).length;
  const scrollToEnd = () => observers[0].callback([{ isIntersecting: true }]);
  return { context, elements, calls, release, cards, scrollToEnd, rows };
}

test('the dashboard shows the first 60 cards from a limit=60 call before the rest has loaded', async () => {
  const { context, elements, calls, cards, release } = clientSetup();
  const loading = context.loadTranscripts();
  await tick();
  assert.equal(calls[0], '/api/transcripts?limit=60');
  assert.equal(cards(), 60);
  assert.equal(elements.stats.textContent, '150 videos');
  release();
  await loading;
  assert.ok(calls.includes('/api/transcripts?limit=500&offset=60'));
  assert.equal(vm.runInContext('transcripts.length', context), 150);
});

test('cards render in batches as the user scrolls and the grid is not rebuilt when the rest arrives', async () => {
  const { context, elements, cards, release, scrollToEnd } = clientSetup();
  const loading = context.loadTranscripts();
  await tick();
  const firstView = elements.videoGrid.innerHTML;
  release();
  await loading;
  assert.equal(elements.videoGrid.innerHTML, firstView);
  scrollToEnd();
  assert.equal(cards(), 120);
  scrollToEnd();
  assert.equal(cards(), 150);
  scrollToEnd();
  assert.equal(cards(), 150);
});

test('search finds a video outside the first page, waiting for the rest to arrive', async () => {
  const { context, elements, cards, release } = clientSetup();
  const loading = context.loadTranscripts();
  await tick();
  context.handleSearch('Needle');
  assert.equal(cards(), 0);
  release();
  await loading;
  assert.equal(cards(), 1);
  assert.match(elements.videoGrid.innerHTML, /Needle in the haystack/);
  context.handleSearch('');
  assert.equal(cards(), 60);
});

test('category filter covers every loaded row, not only the first page', async () => {
  const { context, elements, cards, release, scrollToEnd } = clientSetup();
  const loading = context.loadTranscripts();
  release();
  await loading;
  context.setCategory('Health');
  assert.equal(cards(), 50);
  assert.equal(elements.stats.textContent, '50 of 150 videos');
  context.setCategory('AI');
  assert.equal(cards(), 60);
  scrollToEnd();
  assert.equal(cards(), 100);
  assert.equal(elements.stats.textContent, '100 of 150 videos');
});

test('deleting a card drops it from the list without reloading the list', async () => {
  const { context, elements, calls, release } = clientSetup();
  const loading = context.loadTranscripts();
  release();
  await loading;
  const listCalls = () => calls.filter(url => url.startsWith('/api/transcripts?')).length;
  const before = listCalls();
  await context.deleteTranscript(150, 'Fixture video 150');
  assert.ok(calls.includes('/api/transcripts/150'));
  assert.equal(listCalls(), before);
  assert.equal(vm.runInContext('transcripts.length', context), 149);
  assert.equal(vm.runInContext('transcripts.some(t => t.id === 150)', context), false);
  assert.equal(elements.stats.textContent, '149 videos');
});
