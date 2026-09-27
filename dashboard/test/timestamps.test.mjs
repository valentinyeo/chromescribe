import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEstimatedTimestamps } from '../src/timestamps.mjs';

test('timestamps preserve words and whitespace and select nearest word boundaries', () => {
  const text = 'one  two\nthree four five six seven';
  const result = addEstimatedTimestamps(text, 100, 'youtubeid');
  assert.equal(result, '[0:00] one  two\n[0:28] three four [0:57] five six [1:25] seven');
  assert.equal(result.replace(/\[\d+:\d{2}\] /g, ''), text);
});

test('articles and unknown durations remain unchanged', () => {
  for (const duration of [0, -1, NaN, Infinity, undefined]) {
    assert.equal(addEstimatedTimestamps('plain text', duration, 'video'), 'plain text');
  }
  assert.equal(addEstimatedTimestamps('plain text', 3600, 'article:123'), 'plain text');
  assert.equal(addEstimatedTimestamps(' \n', 30, 'video'), ' \n');
});

test('short, sparse, and hour-long transcripts use valid unique markers', () => {
  assert.equal(addEstimatedTimestamps('hello world', 10, 'video'), '[0:00] hello world');
  assert.equal(addEstimatedTimestamps('hello', 100, 'video'), '[0:00] hello');
  const result = addEstimatedTimestamps(Array(745).fill('word').join(' '), 3725, 'video');
  assert.ok(result.includes('[1:02:00]'));
  const times = [...result.matchAll(/\[([\d:]+)\]/g)].map(m =>
    m[1].split(':').reduce((sum, part) => sum * 60 + Number(part), 0));
  assert.ok(times.every((t, i) => i === 0 || t > times[i - 1]));
  assert.ok(times.at(-1) < 3725);
});
