import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/reports.html', import.meta.url), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
async function setup(payload, ok = true) {
  const elements = Object.fromEntries(['count', 'reportsList', 'error'].map(id => [id, { innerHTML: '', textContent: '' }]));
  const calls = [];
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return { ok, json: async () => payload };
    },
  });
  vm.runInContext(code, context);
  await new Promise(resolve => setImmediate(resolve));
  return { elements, context, calls };
}

test('reports UI renders API order, escaped fields, dates and encoded links with credentials', async () => {
  const { elements, calls } = await setup({ success: true, data: [
    { id: 'abcdef123456', title: 'New report', channel: 'Jake Trinder', topic: 'Clients', created_at: '2026-01-02' },
    { id: 'bad"<id>', title: '<img src=x onerror=alert(1)>', channel: '<channel>', topic: 'A & B', created_at: '2026-01-01' },
  ] });
  assert.equal(elements.count.textContent, '2 reports');
  const rendered = elements.reportsList.innerHTML;
  assert.ok(rendered.indexOf('New report') < rendered.indexOf('&lt;img'));
  assert.match(rendered, /href="\/reports\/abcdef123456"/);
  assert.match(rendered, /Jake Trinder/);
  assert.match(rendered, /Clients/);
  assert.match(rendered, /2026-01-02/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(rendered, /bad%22%3Cid%3E/);
  assert.match(rendered, /&lt;channel&gt;/);
  assert.match(rendered, /A &amp; B/);
  assert.doesNotMatch(rendered, /<img/);
  assert.deepEqual(calls, [{ url: '/api/reports', credentials: 'include' }]);
  assert.match(html, /family=Geist/);
  assert.match(html, /--background: #030303/);
  assert.match(html, /overflow-wrap: anywhere/);
});

test('reports UI shows empty and failed API states without exposing HTML', async () => {
  const empty = await setup({ success: true, data: [] });
  assert.equal(empty.elements.count.textContent, '0 reports');
  assert.match(empty.elements.reportsList.innerHTML, /No reports yet/);
  for (const [payload, ok, message] of [
    [{ success: false, error: '<unavailable>' }, false, '<unavailable>'],
    [{ success: true, data: null }, true, 'Could not load reports'],
  ]) {
    const { elements } = await setup(payload, ok);
    assert.equal(elements.error.textContent, message);
    assert.equal(elements.count.textContent, 'Reports unavailable');
  }
});

test('all dashboard navigation and Worker routes include reports', () => {
  for (const page of ['index', 'transcript', 'settings', 'stats', 'subscriptions']) {
    assert.match(readFileSync(new URL(`../public/${page}.html`, import.meta.url), 'utf8'), /href="\/reports.html"/);
  }
  assert.match(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'), /reports.html/);
});
