import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dashboard = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const pages = readdirSync(new URL('../public/', import.meta.url)).filter(file => file.endsWith('.html')).sort();

test('every public HTML page has a Worker route and every HTML route has a file', () => {
  const routes = [...new Set([...read('../src/index.ts').matchAll(/url\.pathname === ['"]\/([^/'"]+\.html)['"]/g)].map(match => match[1]))].sort();
  const missing = [
    ...pages.filter(page => !routes.includes(page)).map(page => `${page}: add the route in dashboard/src/index.ts`),
    ...routes.filter(page => !pages.includes(page)).map(page => `${page}: add the file in dashboard/public`),
  ];
  assert.deepEqual(routes, pages, missing.join('\n'));
});

test('deployment discovers pages instead of hardcoding page names', () => {
  for (const file of ['../deploy.sh', '../../.github/workflows/deploy.yml']) {
    assert.doesNotMatch(read(file), /[\w-]+\.html\b/, 'upload pages with the public/*.html loop in dashboard/deploy.sh');
  }
  assert.match(read('../../.github/workflows/deploy.yml'), /run: bash deploy\.sh/);
  const deploy = read('../../.github/workflows/deploy.yml');
  assert.ok(deploy.indexOf('bash tools/run-checks.sh') > 0 && deploy.indexOf('bash tools/run-checks.sh') < deploy.indexOf('run: bash deploy.sh'), 'deploy.yml runs tools/run-checks.sh before deploy.sh');
  assert.match(read('../../.github/workflows/deploy.yml'), /wrangler@4\.82\.2/);
});

test('deployment uploads each public page once and always deploys the Worker', () => {
  const result = spawnSync('bash', ['deploy.sh'], { cwd: dashboard, env: { ...process.env, WRANGLER: 'echo' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split(/\r?\n/);
  const uploads = lines.filter(line => line.startsWith('r2 object put '));
  assert.deepEqual(uploads, pages.map(page => `r2 object put chromescribe-transcripts/${page} --file=./public/${page} --remote`));
  assert.equal(lines.filter(line => line === 'deploy').length, 1);
  assert.ok(lines.indexOf('deploy') > lines.indexOf(uploads.at(-1)));
});
