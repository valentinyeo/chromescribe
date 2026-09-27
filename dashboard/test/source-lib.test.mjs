import worker from '../src/index.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSourceUrl } from '../src/source-lib.mjs';

test('source extraction permits only a complete http(s) source line', () => {
  for (const url of ['https://example.com/a?q=1#x', 'http://example.com/']) {
    assert.equal(extractSourceUrl(`# Title\n\n**Source:** ${url}\r\n**Date:** today`), url);
  }
  for (const value of ['javascript:alert(1)', '//example.com', 'https://', 'https://example.com extra', 'file:///tmp/a']) {
    assert.equal(extractSourceUrl(`**Source:** ${value}`), null);
  }
  assert.equal(extractSourceUrl('No source'), null);
});

test('stored source redirects, missing transcript/content/source returns 404', async () => {
  for (const [row, content, status] of [[null, null, 404], [{srt_path:'a'}, null, 404], [{srt_path:'a'}, 'No source', 404], [{srt_path:'a'}, '**Source:** https://example.com/', 302]]) {
    const env = {
      DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
      TRANSCRIPTS: { get: async () => content === null ? null : { text: async () => content } },
    };
    const response = await worker.fetch(new Request('https://test.example/api/transcripts/1/source'), env);
    assert.equal(response.status, status);
    if (status === 302) assert.equal(response.headers.get('Location'), 'https://example.com/');
  }
});
