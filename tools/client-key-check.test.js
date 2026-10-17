const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'client-key-check.mjs');
const run = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('master at 278a5ca fails on the Android prototype that baked the Access key into the app', () => {
  const result = run(root, '--rev', '278a5ca');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /android\/app\/build\.gradle:\d+: mentions the Access client secret/);
  assert.match(result.stderr, /android\/app\/src\/main\/java\/org\/crolab\/chromescribe\/Api\.kt:\d+/);
  assert.doesNotMatch(result.stderr, /cli\/|cf_access|backfill|deploy\.yml/);
});

test('repository passes the client key check', () => {
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Client key check passed/);
  assert.match(result.stdout, /extension\/tiktok-saves\.js: known, removed by CHRO-13/);
});

test('staged client files with the secret fail, server scripts with it pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-key-check-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
  try {
    git('init', '-q');
    write('cli/chromescribe', 'curl -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"\n');
    write('dashboard/public/settings.html', '<code>export CF_ACCESS_CLIENT_SECRET=...</code>\n');
    write('extension/background.js', 'fetch(url)\n');
    git('add', '.');
    assert.equal(run(dir).status, 0);
    write('extension/background.js', 'fetch(url, { headers: { "CF-Access-Client-Secret": s } })\n');
    write('dashboard/public/index.html', '<script>const CF_SECRET = "x"</script>\n');
    write('app/build.gradle.kts', 'buildConfigField("String", "K", props["cs.cfSecret"])\n');
    git('add', '.');
    const bad = run(dir);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /extension\/background\.js:1/);
    assert.match(bad.stderr, /dashboard\/public\/index\.html:1/);
    assert.match(bad.stderr, /app\/build\.gradle\.kts:1/);
    assert.doesNotMatch(bad.stderr, /cli\/chromescribe/);
    write('extension/tiktok-saves.js', 'fetch(url)\n');
    git('add', '.');
    assert.match(run(dir).stderr, /extension\/tiktok-saves\.js: clean now, remove it from knownUntilFixed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
