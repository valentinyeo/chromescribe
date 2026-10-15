import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const code = html.slice(html.indexOf('    // Channels panel'), html.indexOf('  </script>', html.indexOf('    // Channels panel')));
const youtube = { id: 'UC9-XlrmeMEAdIha_XBuHp1w', handle: '@jaketrinder', name: 'Jake Trinder', platform: 'youtube' };
const tiktok = { id: 'tiktok:@user', handle: '@user', name: 'User "name" <test>', platform: 'tiktok' };

function setup() {
  const elements = Object.fromEntries(['channelsList', 'channelsBadge', 'channelsError'].map(id => [id, {
    innerHTML: '', textContent: '', handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; },
  }]));
  let rows = [youtube, tiktok];
  const calls = [];
  const confirms = [];
  const context = vm.createContext({
    API_BASE: '/api', URL,
    document: { getElementById: id => elements[id], addEventListener() {} },
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    confirm: message => { confirms.push(message); return true; },
    fetch: async (url, init = {}) => {
      calls.push({ url, ...init });
      if (init.method === 'DELETE') rows = rows.filter(row => !url.endsWith(encodeURIComponent(row.id)));
      if (init.method === 'POST') rows = [...rows, { ...youtube, id: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: 'New channel' }];
      return { ok: true, json: async () => ({ data: init.method ? {} : rows }) };
    },
  });
  vm.runInContext('let channelsCache = []; let activeChannel = null; let transcripts = [{ channel: "Jake Trinder videos" }];\n' + code, context);
  return { context, elements, calls, confirms };
}

function submitEvent(value) {
  const button = { disabled: false };
  return { button, event: { preventDefault() {}, target: {
    querySelector: selector => selector === 'button' ? button : { value },
  } } };
}

test('renders chips, platform links, safe metadata, compact form, transcript count and badge', async () => {
  const { context, elements } = setup();
  await context.loadChannels();
  const rendered = elements.channelsList.innerHTML;
  assert.equal(elements.channelsBadge.textContent, 2);
  assert.equal((rendered.match(/class="channel-chip-link channel-unsubscribe"/g) || []).length, 2);
  assert.match(rendered, /https:\/\/www\.youtube\.com\/channel\/UC9-XlrmeMEAdIha_XBuHp1w/);
  assert.match(rendered, /https:\/\/www\.tiktok\.com\/%40user/);
  assert.match(rendered, /channel-chip-count">1</);
  assert.match(rendered, /aria-label="Unsubscribe from User &quot;name&quot; &lt;test&gt;"/);
  assert.doesNotMatch(rendered, /onclick=/);
  assert.ok(rendered.indexOf('id="channelSubscribe"') > rendered.lastIndexOf('channel-unsubscribe'));
  assert.match(rendered, /type="submit" class="btn btn-secondary">Subscribe/);
  assert.match(rendered, /id="channelsError" role="alert"/);
});

test('subscribe posts input, refreshes rows and count, and enables the button', async () => {
  const { context, elements, calls } = setup();
  await context.loadChannels();
  const { event, button } = submitEvent('@newchannel');
  await context.subscribeChannel(event);
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].body), { input: '@newchannel' });
  assert.equal(calls[2].url, '/api/channels');
  assert.equal(elements.channelsBadge.textContent, 3);
  assert.equal(button.disabled, false);
  assert.match(elements.channelsList.innerHTML, /New channel/);
});

test('unsubscribe confirms the name, sends an encoded ID, and refreshes without touching transcripts', async () => {
  const { context, elements, calls, confirms } = setup();
  await context.loadChannels();
  await context.unsubscribeChannel(tiktok.id);
  assert.equal(confirms[0], `Unsubscribe from ${tiktok.name}? Existing transcripts will be kept.`);
  assert.equal(calls[1].url, '/api/channels/tiktok%3A%40user');
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(elements.channelsBadge.textContent, 1);
  assert.equal(vm.runInContext('transcripts.length', context), 1);
  context.confirm = () => false;
  await context.unsubscribeChannel(youtube.id);
  assert.equal(calls.length, 3, 'cancel sends no request');
});

test('API and network errors are inline and do not silently update the count', async () => {
  const { context, elements } = setup();
  await context.loadChannels();
  context.fetch = async () => ({ ok: false, json: async () => ({ error: 'Invalid channel handle' }) });
  const { event, button } = submitEvent('junk');
  await context.subscribeChannel(event);
  assert.equal(elements.channelsError.textContent, 'Invalid channel handle');
  assert.equal(elements.channelsBadge.textContent, 2);
  assert.equal(button.disabled, false);
  await context.unsubscribeChannel(youtube.id);
  assert.equal(elements.channelsError.textContent, 'Invalid channel handle');
  context.fetch = async () => { throw new Error('Network unavailable'); };
  await context.subscribeChannel(event);
  assert.equal(elements.channelsError.textContent, 'Network unavailable');
  await assert.rejects(context.loadChannels(), /Network unavailable/);
});

test('delegated chip actions distinguish unsubscribe from filtering', async () => {
  const { context, elements } = setup();
  await context.loadChannels();
  const filtered = [];
  const removed = [];
  context.toggleChannelFilter = name => filtered.push(name);
  context.unsubscribeChannel = id => removed.push(id);
  for (const unsubscribe of [false, true]) {
    elements.channelsList.handlers.click({ target: { closest: () => ({
      dataset: { channelId: youtube.id }, classList: { contains: () => unsubscribe },
    }) } });
  }
  assert.deepEqual(filtered, [youtube.name]);
  assert.deepEqual(removed, [youtube.id]);
  assert.equal(elements.channelsList.handlers.submit, context.subscribeChannel);
});
