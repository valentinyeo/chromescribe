const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'local-state-check.mjs');
const run = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('a committed dashboard/.wrangler state folder fails with --rev', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-state-rev-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  try {
    git('init', '-q');
    const state = path.join(dir, 'dashboard/.wrangler/state/v3/d1');
    fs.mkdirSync(state, { recursive: true });
    for (const name of ['db.sqlite', 'db.sqlite-shm', 'db.sqlite-wal']) fs.writeFileSync(path.join(state, name), 'x');
    fs.writeFileSync(path.join(dir, 'dashboard/wrangler.toml'), 'name = "x"\n');
    git('add', '-f', '.');
    git('-c', 'user.name=T', '-c', 'user.email=1+t@users.noreply.github.com', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'state');
    const result = run(dir, '--rev', 'HEAD');
    assert.equal(result.status, 1, result.stderr);
    const lines = result.stderr.trim().split('\n').slice(0, -1);
    assert.equal(lines.length, 3, result.stderr);
    assert.ok(lines.every(line => line.startsWith('dashboard/.wrangler/')), result.stderr);
    assert.doesNotMatch(result.stderr, /wrangler\.toml/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('repository passes the local state check', () => {
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Local state check passed/);
});

test('staged local state is caught by folder, name and content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-state-check-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'wrangler.toml'), 'name = "x"\n');
    fs.writeFileSync(path.join(dir, 'schema.sql'), 'CREATE TABLE t (id INTEGER);\n');
    git('add', '.');
    assert.equal(run(dir).status, 0);
    fs.mkdirSync(path.join(dir, 'app/.wrangler/cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app/.wrangler/cache/cf.json'), '{}');
    fs.writeFileSync(path.join(dir, 'local.sqlite-wal'), 'x');
    fs.writeFileSync(path.join(dir, 'blob'), Buffer.from('SQLite format 3\0rest', 'latin1'));
    git('add', '-f', '.');
    const bad = run(dir);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /app\/\.wrangler\/cache\/cf\.json: local wrangler state/);
    assert.match(bad.stderr, /local\.sqlite-wal: local database file/);
    assert.match(bad.stderr, /blob: SQLite database by content/);
    assert.doesNotMatch(bad.stderr, /wrangler\.toml|schema\.sql/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
