import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scripts = readdirSync(root).filter(f => f.endsWith('.sh') || f.endsWith('.bat'));

test('no background script asks for read-aloud audio, which Deepgram bills per character', () => {
  assert.ok(scripts.includes('monitor.sh'));
  for (const f of scripts) {
    assert.doesNotMatch(readFileSync(join(root, f), 'utf8'), /\/speak\//, f);
  }
});
