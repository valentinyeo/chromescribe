import test from 'node:test';
import assert from 'node:assert/strict';
import { verdictFrom } from './verdict.mjs';

const end = text => JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('takes the verdict line from the last assistant message', () => {
  const log = [end('FAIL\nold'), '{"type":"tool"}', end('Evidence first\nPASS+NOTES\nnote')].join('\n');
  assert.equal(verdictFrom(log).verdict, 'PASS+NOTES');
});

test('a verdict word inside a sentence is not a verdict', () => {
  assert.equal(verdictFrom(end('This should PASS once fixed')).verdict, null);
});

test('no assistant message means no verdict', () => {
  assert.equal(verdictFrom('not json\n{"type":"x"}').verdict, null);
});
