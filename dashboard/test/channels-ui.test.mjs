import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const removedPanel = /Monitored Channels|channels-panel|channel-chip|channelsList|channelsBadge|channelsCache|channelsError|loadChannels|renderChannels|toggleChannels|subscribeChannel|unsubscribeChannel|transcriptsByChannelName/;

function setup(search = '') {
  const handlers = {};
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    innerHTML: '', textContent: '', value: id === 'sortSelect' ? 'newest' : '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {},
    insertAdjacentHTML(_, markup) { this.innerHTML += markup; },
  }]));
  const calls = [];
  const rows = [
    { id: 1, video_id: 'AAAAAAAAAAA', title: 'First video', channel: 'Jake Trinder', tags: '[]' },
    { id: 2, video_id: 'BBBBBBBBBBB', title: 'Other video', channel: 'Another Channel', tags: '[]' },
    { id: 3, video_id: 'CCCCCCCCCCC', title: 'Third video', channel: 'jake trinder videos', tags: '[]' },
  ];
  const location = new URL('https://chromescribe.yeoux.net/' + search);
  const context = vm.createContext({
    URL, URLSearchParams, location,
    document: {
      getElementById(id) { assert.ok(elements[id], `Missing element: ${id}`); return elements[id]; },
      addEventListener(type, handler) { (handlers[type] ||= []).push(handler); },
    },
    csTheme: { icon: () => '', label: () => '' },
    addEventListener() {}, scrollTo() {}, requestAnimationFrame: callback => callback(),
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null },
    history: { replaceState(_, __, url) { location.href = String(url); } },
    fetch: async url => {
      calls.push(url);
      return { json: async () => ({ data: url.startsWith('/api/transcripts') ? rows : [] }) };
    },
  });
  context.window = context;
  vm.runInContext(code, context);
  context.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  return { context, handlers, elements, calls, location };
}

test('home has only Subscriptions navigation, with no channel panel, CSS, handlers or API requests', async () => {
  assert.throws(() => assert.doesNotMatch('channels-panel', removedPanel), assert.AssertionError,
    'the absence oracle detects a known panel fixture');
  assert.doesNotMatch(html, removedPanel);
  assert.match(html, /href="\/subscriptions.html"[^>]*>Subscriptions<\/a>/);
  const { handlers, context, calls, elements } = setup();
  for (const handler of handlers.DOMContentLoaded) handler();
  await context.loadTranscripts();
  assert.ok(calls.includes('/api/transcripts?limit=60'));
  assert.ok(calls.includes('/api/categories'));
  assert.ok(calls.every(url => !url.startsWith('/api/channels')));
  assert.match(elements.videoGrid.innerHTML, /Other video/);
});

test('channel deep links initialize activeChannel and filter transcript cards case-insensitively', async () => {
  const { handlers, context, elements } = setup('?channel=Jake%20Trinder');
  for (const handler of handlers.DOMContentLoaded) handler();
  await context.loadTranscripts();
  assert.equal(vm.runInContext('activeChannel', context), 'Jake Trinder');
  assert.match(elements.videoGrid.innerHTML, /First video/);
  assert.match(elements.videoGrid.innerHTML, /Third video/);
  assert.doesNotMatch(elements.videoGrid.innerHTML, /Other video/);
  assert.equal(elements.stats.textContent, '2 of 3 videos');
});

test('card channel clicks filter without opening a video, update URL and allow clearing', async () => {
  const { context, handlers, elements, location } = setup('?keep=yes');
  await context.loadTranscripts();
  let prevented = false, stopped = false;
  const event = {
    target: { closest: selector => selector === '.card-channel-link' ? { dataset: { channel: 'Jake Trinder' } } : null },
    preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
  };
  for (const handler of handlers.click) handler(event);
  assert.ok(prevented && stopped);
  assert.equal(location.searchParams.get('channel'), 'Jake Trinder');
  assert.equal(location.searchParams.get('keep'), 'yes');
  assert.doesNotMatch(elements.videoGrid.innerHTML, /Other video/);
  for (const handler of handlers.click) handler(event);
  assert.equal(vm.runInContext('activeChannel', context), 'Jake Trinder', 'clicking the current card channel does not clear it');
  context.toggleChannelFilter('Jake Trinder');
  assert.equal(location.searchParams.has('channel'), false);
  assert.match(elements.videoGrid.innerHTML, /Other video/);
});
