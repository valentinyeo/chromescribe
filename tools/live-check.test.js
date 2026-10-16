const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const script = path.join(__dirname, 'live-check.mjs');

function run(...args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

async function site(pages) {
  const server = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://x').pathname.slice(1) || 'index.html';
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
const check = url => run(url, '--public', dir, '--tries', '2', '--wait', '10');

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

test('deploy workflow runs the live check after the deploy', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/deploy.yml'), 'utf8');
  const deploy = workflow.indexOf('run: bash deploy.sh');
  assert.ok(deploy > 0);
  assert.ok(workflow.indexOf('node tools/live-check.mjs https://chromescribe.yeoux.net') > deploy);
});
