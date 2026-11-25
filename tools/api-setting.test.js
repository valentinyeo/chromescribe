const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const LIVE = 'https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev';
const SHELL_SCRIPTS = ['queue.sh', 'process.sh', 'monitor.sh'];

const CURL_MOCK = `#!/usr/bin/env bash
set -uo pipefail
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -w|-X|-H|-d|-b|-c|--max-time|--proto|--data-urlencode) shift 2;;
    -sS|-f|-s|-L|--get) shift;;
    *) url="$1"; shift;;
  esac
done
printf '%s\\n' "$url" >> "$CURL_LOG"
body='{"success":true,"data":[]}'
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; printf '200'; else printf '%s' "$body"; fi
exit 0
`;

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-api-setting-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(bin, 'curl'), CURL_MOCK, { mode: 0o755 });
  for (const name of SHELL_SCRIPTS) fs.copyFileSync(path.join(REPO, name), path.join(dir, name));
  fs.copyFileSync(path.join(REPO, 'lib', 'cf_access.sh'), path.join(dir, 'lib', 'cf_access.sh'));
  fs.copyFileSync(path.join(REPO, 'lib', 'analyze.sh'), path.join(dir, 'lib', 'analyze.sh'));
  fs.copyFileSync(path.join(REPO, 'fxtwitter_article.py'), path.join(dir, 'fxtwitter_article.py'));
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CF_ACCESS_CLIENT_ID: 'test-id',
    CF_ACCESS_CLIENT_SECRET: 'test-secret',
    CHROMESCRIBE_ENV_FILE: path.join(dir, 'missing.env'),
    CHROMESCRIBE_NO_OPEN: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    QUEUE_LOCK_FILE: path.join(dir, 'queue.lock'),
    CURL_LOG: path.join(dir, 'curl.log'),
  };
  delete env.CHROMESCRIBE_API;
  return { dir, env, log: env.CURL_LOG, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function loggedUrls(log) {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

test('the shell pipelines keep the live worker as the default API address', () => {
  for (const name of SHELL_SCRIPTS) {
    const source = fs.readFileSync(path.join(REPO, name), 'utf8');
    assert.ok(source.includes(`CHROMESCRIBE_API:-${LIVE}`), `${name} does not default to ${LIVE}`);
  }
});

test('upload_article.py keeps the live worker as the default API address', () => {
  const source = fs.readFileSync(path.join(REPO, 'upload_article.py'), 'utf8');
  assert.ok(source.includes(`os.environ.get('CHROMESCRIBE_API', '${LIVE}')`), 'upload_article.py does not read CHROMESCRIBE_API against the live default');
});

test('queue.sh calls the live worker when the setting is absent', () => {
  const space = workspace();
  try {
    const result = spawnSync('bash', [path.join(space.dir, 'queue.sh')], { env: space.env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(loggedUrls(space.log), [`${LIVE}/api/queue`]);
  } finally {
    space.cleanup();
  }
});

test('queue.sh follows CHROMESCRIBE_API when it is set', () => {
  const space = workspace();
  try {
    const result = spawnSync('bash', [path.join(space.dir, 'queue.sh')], {
      env: { ...space.env, CHROMESCRIBE_API: 'http://127.0.0.1:4321/' },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(loggedUrls(space.log), ['http://127.0.0.1:4321/api/queue']);
  } finally {
    space.cleanup();
  }
});

test('process.sh calls the live worker when the setting is absent', () => {
  const space = workspace();
  try {
    spawnSync('bash', [path.join(space.dir, 'process.sh'), 'https://www.youtube.com/watch?v=abcdefghijk'], {
      env: space.env,
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.deepEqual(loggedUrls(space.log), [`${LIVE}/api/transcripts?video_id=abcdefghijk`]);
  } finally {
    space.cleanup();
  }
});

test('process.sh follows CHROMESCRIBE_API when it is set', () => {
  const space = workspace();
  try {
    spawnSync('bash', [path.join(space.dir, 'process.sh'), 'https://www.youtube.com/watch?v=abcdefghijk'], {
      env: { ...space.env, CHROMESCRIBE_API: 'http://127.0.0.1:4321' },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.deepEqual(loggedUrls(space.log), ['http://127.0.0.1:4321/api/transcripts?video_id=abcdefghijk']);
  } finally {
    space.cleanup();
  }
});

test('upload_article.py posts to CHROMESCRIBE_API', async () => {
  const space = workspace();
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end('{"success":true,"data":{"id":11}}');
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const article = path.join(space.dir, 'article.md');
    fs.writeFileSync(article, '# Setting article\n\nThe body the journey uploads.\n');
    const result = await new Promise(resolve => {
      const child = spawn('python3', [path.join(REPO, 'upload_article.py'), 'https://example.com/setting-article', article], {
        env: { ...space.env, CHROMESCRIBE_API: `http://127.0.0.1:${server.address().port}/` },
        encoding: 'utf8',
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', status => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 1, result.stdout);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/api/transcribe');
    assert.equal(requests[0].headers['cf-access-client-id'], 'test-id');
    assert.equal(JSON.parse(requests[0].body).url, 'https://example.com/setting-article');
  } finally {
    await new Promise(done => server.close(done));
    space.cleanup();
  }
});
