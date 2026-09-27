import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../fxtwitter_article.py', import.meta.url));
const python = ['python3', 'python'].find(bin => spawnSync(bin, ['-c', 'pass']).status === 0);
const run = (args, input) => spawnSync(python, [helper, ...args], { input, encoding: 'utf8' });

test('FXTwitter article blocks preserve headings, lists, paragraphs and author', () => {
  const result = run([], readFileSync(new URL('./fixtures/fxtwitter-article.json', import.meta.url)));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '# Example Article\n\n**Author:** Example Author\n\n# Main heading\n\n## Subheading\n\nParagraph with café.\n\n- Bullet\n\n1. Step\n\nOther paragraph\n');
});

test('FXTwitter plain posts work even when short; empty text fails', () => {
  const result = run([], JSON.stringify({tweet: {author: {name: 'Sam'}, text: 'Hello'}}));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Author:\*\* Sam\n\nHello/);
  assert.equal(run([], '{"tweet":{"text":""}}').status, 1);
});

test('X/Twitter matching uses exact hosts and post/article paths', () => {
  for (const host of ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']) {
    assert.equal(run(['--status-id', `https://${host}/user/status/123?x=1`]).stdout.trim(), '123');
  }
  assert.equal(run(['--status-id', 'https://x.com/i/article/456']).stdout.trim(), '456');
  for (const url of ['https://x.com.evil.test/user/status/123', 'https://example.com/user/status/123', 'https://x.com/user', 'https://x.com/user/status/no']) {
    assert.equal(run(['--status-id', url]).stdout.trim(), '');
  }
});
