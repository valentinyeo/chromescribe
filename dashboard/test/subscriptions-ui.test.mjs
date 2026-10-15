import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker from '../src/index.ts';

const html = readFileSync(new URL('../public/subscriptions.html', import.meta.url), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const youtube = { id: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: 'alpha', handle: '@alpha', platform: 'youtube', paused: 0, transcripts: 7 };
const tiktok = { id: 'tiktok:@beta', name: 'Beta', handle: '@beta', platform: 'tiktok', paused: 1, transcripts: 0 };

async function setup(initial = [tiktok, youtube]) {
  const elements = Object.fromEntries(['filter', 'count', 'channelsList', 'error', 'message', 'channelInput', 'subscribeForm'].map(id => [id, {
    value: '', textContent: '', innerHTML: '', handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; },
  }]));
  const button = { disabled: false };
  const calls = [];
  const confirms = [];
  let rows = structuredClone(initial);
  const context = vm.createContext({
    document: { getElementById: id => elements[id], querySelector: () => button },
    confirm: text => { confirms.push(text); return true; },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      let data;
      if (options.method === 'POST') {
        const exists = rows.some(row => row.id === 'tiktok:@added');
        if (!exists) rows.push({ ...tiktok, id: 'tiktok:@added', handle: '@added', name: 'Added', paused: 0 });
        data = { already_exists: exists };
      } else if (options.method) {
        const id = decodeURIComponent(url.split('/').at(-1));
        if (options.method === 'DELETE') rows = rows.filter(row => row.id !== id);
        else rows.find(row => row.id === id).paused = JSON.parse(options.body).paused ? 1 : 0;
        data = {};
      } else data = structuredClone(rows);
      return { ok: true, json: async () => ({ success: true, data }) };
    },
  });
  vm.runInContext(code, context);
  await context.loadChannels();
  calls.length = 0;
  return { context, elements, button, calls, confirms };
}

function action(id, action) {
  const button = { disabled: false, dataset: { id, action } };
  return { button, event: { target: { closest: () => button } } };
}

test('static page has matching theme, accessible controls, locale sorting and escaped interpolation', () => {
  assert.match(html, /family=Geist/);
  assert.match(html, /--background: #030303/);
  assert.match(html, /role="alert"/);
  assert.match(html, /label for="filter"/);
  assert.match(html, /localeCompare\(b.name, undefined, \{ sensitivity: 'base' \}\)/);
  assert.match(html, /escapeHtml\(channel.name\)/);
  assert.match(html, /escapeHtml\(channel.handle\)/);
  assert.match(html, /escapeHtml\(channel.id\)/);
  assert.match(html, /escapeHtml\(channelUrl\(channel\)\)/);
  const render = code.slice(code.indexOf('    function renderChannels()'), code.indexOf('    async function channelRequest'));
  assert.doesNotMatch(render, /\$\{channel\.(?:name|handle|id)\}/);
});

test('sort is case-insensitive and does not mutate API rows; letter groups include nonletters and accents', async () => {
  const { context, elements } = await setup([
    tiktok, { ...youtube, id: 'z', name: 'zulu' }, youtube,
    { ...youtube, id: 'a2', name: 'Alpine' }, { ...youtube, id: 'number', name: '123 News' },
    { ...youtube, id: 'accent', name: 'Éclair' },
  ]);
  const source = [{ name: 'z' }, { name: 'Beta' }, { name: 'alpha' }];
  assert.deepEqual(Array.from(context.sortChannels(source), row => row.name), ['alpha', 'Beta', 'z']);
  assert.deepEqual(source.map(row => row.name), ['z', 'Beta', 'alpha']);
  assert.equal(context.channelLetter('9 news'), '#');
  assert.equal(context.channelLetter('Éclair'), 'E');
  const rendered = elements.channelsList.innerHTML;
  assert.ok(rendered.indexOf('>alpha<') < rendered.indexOf('>Alpine<'));
  assert.ok(rendered.indexOf('>Alpine<') < rendered.indexOf('>Beta<'));
  assert.ok(rendered.indexOf('>Beta<') < rendered.indexOf('>zulu<'));
  assert.equal((rendered.match(/<h2>A /g) || []).length, 1);
  assert.match(rendered, /<h2># /);
  assert.match(rendered, /<h2>E /);
  assert.equal(elements.count.textContent, '6 subscriptions');
});

test('renders platform links, active/paused statuses and safe names, handles, URLs and IDs', async () => {
  const unsafe = { ...youtube, id: 'bad"<id>', name: '<img src=x onerror=alert(1)>', handle: '@"<bad>' };
  const { context, elements } = await setup([youtube, tiktok, unsafe, { ...youtube, id: 'UCbbbbbbbbbbbbbbbbbbbbbb', handle: 'UCbbbbbbbbbbbbbbbbbbbbbb' }]);
  const rendered = elements.channelsList.innerHTML;
  assert.match(rendered, /https:\/\/www.youtube.com\/@alpha/);
  assert.match(rendered, /https:\/\/www.youtube.com\/channel\/UCbbbbbbbbbbbbbbbbbbbbbb/);
  assert.match(rendered, /https:\/\/www.tiktok.com\/@beta/);
  assert.match(rendered, />Active</);
  assert.match(rendered, />Paused</);
  assert.match(rendered, />Pause<\/button>/);
  assert.match(rendered, />Resume<\/button>/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(rendered, /data-id="bad&quot;&lt;id&gt;"/);
  assert.match(rendered, /@&quot;&lt;bad&gt;/);
  assert.doesNotMatch(rendered, /<img/);
  assert.equal(context.escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
});

test('display names and transcript counts link to the channel view, handles stay secondary', async () => {
  const name = 'Jake & Friends "News"';
  const { elements, calls } = await setup([{ ...youtube, name, transcripts: 12 }, tiktok]);
  const rendered = elements.channelsList.innerHTML;
  const link = '/?channel=' + encodeURIComponent(name);
  assert.ok(rendered.includes(`<p class="channel-name"><a href="${link}">Jake &amp; Friends &quot;News&quot;</a></p>`));
  assert.ok(rendered.includes(`<a href="${link}">12 transcripts</a>`));
  assert.match(rendered, /href="\/\?channel=Beta">0 transcripts<\/a>/);
  assert.match(rendered, /href="https:\/\/www.youtube.com\/@alpha"[^>]*>@alpha<\/a>/);
  assert.ok(rendered.indexOf('class="channel-name"') < rendered.indexOf('>@alpha<'));
  assert.ok(calls.every(call => !call.url.includes('/transcripts')), 'counts come from channels, not a second API request');
});

test('filter searches names, handles and platform with visible and total counts and an empty state', async () => {
  const { context, elements } = await setup();
  for (const query of ['BETA', '@beta', 'tiktok']) {
    elements.filter.value = query;
    elements.filter.handlers.input();
    assert.equal(elements.count.textContent, '1 of 2 subscriptions');
    assert.match(elements.channelsList.innerHTML, />Beta</);
    assert.doesNotMatch(elements.channelsList.innerHTML, />alpha</);
  }
  elements.filter.value = 'no matches';
  context.renderChannels();
  assert.equal(elements.count.textContent, '0 of 2 subscriptions');
  assert.match(elements.channelsList.innerHTML, /No subscriptions found/);
});

test('add reports subscribed and already subscribed, refreshes, and sends credentials on every request', async () => {
  const { context, elements, calls, button } = await setup();
  for (const message of ['Subscribed', 'Already subscribed']) {
    elements.channelInput.value = ' tiktok:@added ';
    await context.subscribeChannel({ preventDefault() {} });
    assert.equal(elements.message.textContent, message);
    assert.equal(elements.channelInput.value, '');
    assert.equal(button.disabled, false);
  }
  assert.deepEqual(calls.map(call => call.method || 'GET'), ['POST', 'GET', 'POST', 'GET']);
  assert.deepEqual(JSON.parse(calls[0].body), { input: 'tiktok:@added' });
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.ok(calls.every(call => call.credentials === 'include'));
  assert.equal(elements.count.textContent, '3 subscriptions');
});

test('pause and resume PATCH strict booleans, re-fetch, and update status', async () => {
  const { context, elements, calls } = await setup();
  for (const paused of [true, false]) {
    const { event, button } = action(youtube.id, 'pause');
    await context.changeChannel(event);
    assert.equal(button.disabled, false);
    assert.equal(calls.at(-2).method, 'PATCH');
    assert.deepEqual(JSON.parse(calls.at(-2).body), { paused });
    assert.equal(calls.at(-2).headers['Content-Type'], 'application/json');
    assert.equal(calls.at(-1).url, '/api/channels');
    assert.match(elements.channelsList.innerHTML, paused ? />Resume<\/button>/ : />Pause<\/button>/);
  }
  assert.ok(calls.every(call => call.credentials === 'include'));
});

test('remove confirms transcript retention, uses encoded ID, refreshes and honors cancel', async () => {
  const { context, calls, elements, confirms } = await setup();
  await context.changeChannel(action(tiktok.id, 'remove').event);
  assert.equal(confirms[0], 'Remove Beta? Transcripts already made are kept.');
  assert.equal(calls[0].url, '/api/channels/tiktok%3A%40beta');
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[1].method, undefined);
  assert.equal(elements.count.textContent, '1 subscriptions');
  context.confirm = () => false;
  await context.changeChannel(action(youtube.id, 'remove').event);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.credentials === 'include'));
});

test('API, network and re-fetch errors stay visible, preserve rows and re-enable controls', async () => {
  const { context, elements, button } = await setup();
  for (const [fetch, error] of [
    [async () => ({ ok: false, json: async () => ({ error: '<bad channel>' }) }), '<bad channel>'],
    [async () => { throw new Error('Offline'); }, 'Offline'],
    [async (_, init) => ({ ok: true, json: async () => init.method ? { success: true, data: {} } : { success: true, data: null } }), 'Could not load subscriptions'],
  ]) {
    context.fetch = fetch;
    await context.subscribeChannel({ preventDefault() {} });
    assert.equal(elements.error.textContent, error);
    assert.equal(button.disabled, false);
    for (const type of ['pause', 'remove']) {
      const actionEvent = action(youtube.id, type);
      await context.changeChannel(actionEvent.event);
      assert.equal(elements.error.textContent, error);
      assert.equal(actionEvent.button.disabled, false);
    }
    assert.equal(elements.count.textContent, '2 subscriptions');
  }
});

test('Worker serves subscriptions from R2 with the same HTML and cache headers as existing pages', async () => {
  const env = { TRANSCRIPTS: { get: async key => ({ body: key === 'subscriptions.html' ? html : '<html>Stats</html>' }) } };
  const response = await worker.fetch(new Request('https://test.example/subscriptions.html'), env);
  const stats = await worker.fetch(new Request('https://test.example/stats.html'), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), html);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.deepEqual([...response.headers], [...stats.headers]);
});
