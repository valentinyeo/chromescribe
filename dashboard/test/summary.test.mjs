import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker from '../src/index.ts';

const summary = '## TL;DR\nLead\n- **Point**: Detail.\n## Summary\n**Bottom line:** Detail.\n## Talking Points\n- Point';

test('analyze passes timing metadata, preserves source, and still classifies', async () => {
  for (const video_id of ['abcdefghijk', 'article:123']) {
    const body = 'one two three four five six';
    const stored = '# Title\n\n## TL;DR\nOld\n## The Article\nOld article\n## Full Transcript\n<details>\n<summary>Expand</summary>\n' + body + '\n</details>';
    let written;
    const calls = [];
    const env = {
      DB: { prepare: () => ({
        bind() { return this; },
        first: async () => ({ srt_path: 'test', video_id, duration: 90 }),
        run: async () => ({}),
        all: async () => ({ results: [] }),
      }) },
      TRANSCRIPTS: {
        get: async () => ({ text: async () => stored }),
        put: async (_, text) => { written = text; },
      },
      AI: { run: async (_, options) => {
        calls.push(options);
        return { response: calls.length === 1 ? summary : '{"category":"Testing","tags":["test"]}' };
      } },
    };
    const response = await worker.fetch(new Request('https://test.example/api/transcripts/1/analyze', { method: 'POST' }), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.classified, true);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].max_completion_tokens >= 6000);
    const content = calls[0].messages[1].content.split('CONTENT:\n')[1];
    assert.equal(content.includes('[0:30]'), !video_id.startsWith('article:'));
    assert.ok(written.endsWith(body + '\n\n</details>\n'));
    assert.ok(calls[1].messages[1].content.includes('## Talking Points'));
  }
});

test('old or incomplete model output is rejected without overwriting storage', async () => {
  for (const output of ['## TL;DR\nOld\n## The Article\nOld', '## TL;DR\nLead\n## Summary\nPartial']) {
    let writes = 0;
    const env = {
      DB: { prepare: () => ({ bind() { return this; }, first: async () => ({ srt_path: 'test', video_id: 'video', duration: 60 }) }) },
      TRANSCRIPTS: {
        get: async () => ({ text: async () => '# Title\n## Full Transcript\nHello world' }),
        put: async () => { writes++; },
      },
      AI: { run: async () => ({ response: output }) },
    };
    const response = await worker.fetch(new Request('https://test.example/api/transcripts/1/summarize', { method: 'POST' }), env);
    assert.equal(response.status, 502);
    assert.equal(writes, 0);
  }
});

test('timestamp rendering and clicks preserve platform and player behavior', () => {
  const html = readFileSync(new URL('../public/transcript.html', import.meta.url), 'utf8');
  const code = html.slice(html.indexOf('    function parseMarkdown('), html.indexOf('    function showPlaceholder('));
  const classes = new Set();
  const messages = [];
  const iframe = { contentWindow: { postMessage: text => messages.push(JSON.parse(text)) } };
  let click;
  const context = vm.createContext({
    URL, window: { videoSrc: 'https://www.youtube.com/embed/abcdefghijk?autoplay=1&enablejsapi=1' },
    document: { getElementById: id => ({
      content: { addEventListener: (_, handler) => { click = handler; } },
      video: iframe,
      videoWrapper: { classList: { contains: key => classes.has(key), add: key => classes.add(key) } },
    })[id] },
  });
  vm.runInContext('let videoPlaying = false;\n' + code, context);
  const rendered = context.parseMarkdown('## The Article\n- Point [1:30]\n- Later [1:02:05]');
  assert.match(rendered, /<h2>The Article<\/h2>/);
  assert.match(rendered, /class="ts" data-t="90"/);
  assert.match(rendered, /data-t="3725"/);
  const event = { target: { closest: () => ({ dataset: { t: '90' } }) }, preventDefault() {} };
  click(event);
  const url = new URL(iframe.src);
  assert.equal(url.searchParams.get('start'), '90');
  assert.equal(url.searchParams.get('autoplay'), '1');
  assert.equal(url.searchParams.get('enablejsapi'), '1');
  click(event);
  assert.deepEqual(messages, [
    { event: 'command', func: 'seekTo', args: [90, true] },
    { event: 'command', func: 'playVideo', args: [] },
  ]);
  for (const src of [undefined, 'https://www.tiktok.com/embed/123']) {
    context.window.videoSrc = src;
    assert.doesNotMatch(context.parseMarkdown('- Point [1:30]'), /class="ts"/);
  }
});
