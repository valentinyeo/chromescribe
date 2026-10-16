const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'local-state-check.mjs');
const run = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('master at b504747 fails on the nine dashboard/.wrangler files', () => {
  const result = run(root, '--rev', 'b504747');
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stderr.trim().split('\n').slice(0, -1);
  assert.equal(lines.length, 9, result.stderr);
  assert.ok(lines.every(line => line.startsWith('dashboard/.wrangler/')), result.stderr);
  assert.doesNotMatch(result.stderr, /wrangler\.toml/);
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
