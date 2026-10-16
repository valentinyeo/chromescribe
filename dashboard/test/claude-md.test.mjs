import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const doc = readFileSync(new URL('CLAUDE.md', root), 'utf8');

test('CLAUDE.md stays under 80 lines', () => {
  const lines = doc.trimEnd().split('\n').length;
  assert.ok(lines < 80, `CLAUDE.md has ${lines} lines; move detail into dashboard/README.md or cli/README.md`);
});

test('every repo file CLAUDE.md points to exists', () => {
  const paths = [...doc.matchAll(/`([\w./-]+\.(?:md|sql|sh|ts|txt|yml|py))`/g)].map(m => m[1]);
  assert.ok(paths.length > 0);
  for (const path of paths) {
    const candidates = [path, `.github/workflows/${path}`, `dashboard/${path}`];
    assert.ok(candidates.some(p => existsSync(new URL(p, root))), `CLAUDE.md mentions missing file ${path}`);
  }
});
