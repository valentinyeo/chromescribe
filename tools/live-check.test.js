const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const script = path.join(__dirname, 'live-check.mjs');

function run(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

const KEY = { CF_ACCESS_CLIENT_ID: 'id-1', CF_ACCESS_CLIENT_SECRET: 'secret-1' };
const signedIn = request => request.headers['cf-access-client-id'] === 'id-1' && request.headers['cf-access-client-secret'] === 'secret-1';

function gated({ apiOpen = false, reportsGated = false } = {}) {
  return (request, response) => {
    const name = new URL(request.url, 'http://x').pathname;
    if (name.startsWith('/reports/')) {
      if (reportsGated && !signedIn(request)) return response.writeHead(302, { Location: 'https://login.example/' }).end();
      return response.writeHead(404).end('Report not found');
    }
    if (!apiOpen && !signedIn(request)) return response.writeHead(302, { Location: 'https://login.example/' }).end();
    return null;
  };
}

async function site(pages, guard = () => null) {
  const server = http.createServer((request, response) => {
    if (guard(request, response) !== null) return;
    const name = new URL(request.url, 'http://x').pathname.slice(1) || 'index.html';
    if (name === 'api/transcripts') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      return response.end('{"success":true,"data":[]}');
    }
    if (!(name in pages)) {
      response.writeHead(404);
      return response.end('Not found');
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(pages[name]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-check-'));
const local = { 'index.html': '<title>Home</title>', 'queue.html': '<title>Queue</title>' };
for (const [name, body] of Object.entries(local)) fs.writeFileSync(path.join(dir, name), body);
const check = (url, env, ...extra) => run([url, '--public', dir, '--tries', '2', '--wait', '10', ...extra], env);

test('passes when every committed page is live', async () => {
  const live = await site(local);
  try {
    const result = await check(live.url);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Live check passed: 2 pages/);
  } finally { live.close(); }
});

test('fails when a page is missing from the live site', async () => {
  const live = await site({ 'index.html': local['index.html'] });
  try {
    const result = await check(live.url);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /queue\.html\?v=\S+: HTTP 404/);
  } finally { live.close(); }
});

test('fails when the live page is an old or broken copy', async () => {
  const live = await site({ ...local, 'queue.html': '<title>Queue</title><p>old</p>' });
  try {
    const result = await check(live.url);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /live page differs from dashboard\/public\/queue\.html/);
  } finally { live.close(); }
});

test('fails when the site cannot be reached', async () => {
  const result = await check('http://127.0.0.1:9');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /127\.0\.0\.1:9\/queue\.html\?v=\S+: \S/);
});

test('passes behind the login when the API refuses anonymous calls and reports stay open', async () => {
  const live = await site(local, gated());
  try {
    const result = await check(live.url, KEY, '--require-login');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /refuses calls without a login/);
  } finally { live.close(); }
});

test('fails when the API answers without a login', async () => {
  const live = await site(local, gated({ apiOpen: true }));
  try {
    const result = await check(live.url, KEY, '--require-login');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /api\/transcripts: answered 200 without a login/);
  } finally { live.close(); }
});

test('fails when the service key is refused', async () => {
  const live = await site(local, gated());
  try {
    const result = await check(live.url, { CF_ACCESS_CLIENT_ID: 'id-1', CF_ACCESS_CLIENT_SECRET: 'wrong' }, '--require-login');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /answered 302 with the service key, expected 200/);
  } finally { live.close(); }
});

test('fails when report pages are put behind the login', async () => {
  const live = await site(local, gated({ reportsGated: true }));
  try {
    const result = await check(live.url, KEY, '--require-login');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /reports\/000000000000: answered 302 without a login/);
  } finally { live.close(); }
});

test('refuses to run without the service key when the login is required', async () => {
  const result = await check('http://127.0.0.1:9', {}, '--require-login');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--require-login needs CF_ACCESS_CLIENT_ID/);
});

test('deploy workflow runs the live check after the deploy, with the login required', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/deploy.yml'), 'utf8');
  const deploy = workflow.indexOf('run: bash deploy.sh');
  assert.ok(deploy > 0);
  const check = workflow.indexOf('node tools/live-check.mjs https://chromescribe.yeoux.net');
  assert.ok(check > deploy);
  assert.match(workflow.slice(check), /^.*--require-login/);
  assert.match(workflow, /CF_ACCESS_CLIENT_ID: \$\{\{ secrets\.CF_ACCESS_CLIENT_ID \}\}/);
  assert.match(workflow, /CF_ACCESS_CLIENT_SECRET: \$\{\{ secrets\.CF_ACCESS_CLIENT_SECRET \}\}/);
});
