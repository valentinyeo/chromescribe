import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const media = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.avif', '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.pdf', '.woff', '.woff2', '.ttf', '.eot']);
const allowlist = new Set(['dashboard/.wrangler/cache/cf.json']);
const patterns = [
  /[0-9a-f]{32}\.access/,
  /\b[0-9a-f]{64}\b/,
  /CF_ACCESS_CLIENT_(ID|SECRET):-[^}]/,
  /environ\.get\(\s*['"]CF_ACCESS_CLIENT_(ID|SECRET)['"]\s*,/,
];

function text(path) {
  if (media.has(extname(path).toLowerCase())) return null;
  const bytes = readFileSync(new URL(path, new URL('../../', import.meta.url)));
  return bytes.includes(0) ? null : bytes.toString('utf8');
}

test('tracked text files contain no hardcoded Cloudflare Access keys or defaults', () => {
  const failures = [];
  for (const path of files) {
    if (allowlist.has(path)) continue;
    const content = text(path);
    if (content === null) continue;
    content.split('\n').forEach((line, index) => {
      if (patterns.some(pattern => pattern.test(line))) failures.push(`${path}:${index + 1}`);
    });
  }
  assert.deepEqual(failures, [], `Hardcoded credentials or defaults at ${failures.join(', ')}`);
});

test('tracked shell scripts with Access headers source the shared loader', () => {
  const failures = [];
  for (const path of files.filter(path => path.endsWith('.sh'))) {
    const content = text(path);
    if (content === null || !content.includes('CF-Access-Client')) continue;
    if (!/^\s*(?:source|\.)\s+[^\n]*\/lib\/cf_access\.sh["']?\s*$/m.test(content)) failures.push(path);
  }
  assert.deepEqual(failures, [], `Missing lib/cf_access.sh source: ${failures.join(', ')}`);
});
