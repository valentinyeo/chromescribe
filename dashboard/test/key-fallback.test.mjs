import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const keys = ['CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET'];
const targets = ['bash', 'python'];

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'chromescribe-key-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const name of ['bash', 'python3', 'dirname']) {
    const found = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.equal(found.status, 0, `${name} must be installed`);
    symlinkSync(found.stdout.trim(), join(bin, name));
  }
  const env = { HOME: dir, PATH: bin, PYTHONDONTWRITEBYTECODE: '1',
    CHROMESCRIBE_ENV_FILE: join(dir, 'missing.env'),
    CHROMESCRIBE_API: 'https://invalid.test',
    KEY_LOG: join(dir, 'keys.jsonl'), CURL_LOG: join(dir, 'curl.json') };
  writeFileSync(join(bin, 'curl'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.CURL_LOG, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({success:true,data:[]}));
`, { mode: 0o755 });
  function yeo() {
    writeFileSync(join(bin, 'yeo-key'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.KEY_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
console.error('fake private diagnostic');
const mode = !process.env.FAKE_KEY_FIELD || process.env.FAKE_KEY_FIELD === process.argv[3] ? process.env.FAKE_KEY_MODE : '';
if (mode === 'empty') process.exit(0);
console.log(process.argv[3] === 'CF_ACCESS_CLIENT_ID' ? 'fake-vault-id' : 'fake-vault-secret');
if (mode === 'fail') process.exit(7);
`, { mode: 0o755 });
  }
  function run(target) {
    const commands = {
      bash: ['bash', ['--noprofile', '--norc', '-euc', '. "$1"; python3 -c \'import os,json; print(json.dumps([os.environ[k] for k in ("CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET")]))\'', 'bash', join(repo, 'lib/cf_access.sh')]],
      python: ['python3', ['-c', 'import json; from cf_access import load; print(json.dumps(load()))']],
    };
    const [command, argv] = commands[target];
    const result = spawnSync(command, argv, { cwd: repo, env, encoding: 'utf8' });
    assert.ifError(result.error);
    return result;
  }
  function calls() {
    return existsSync(env.KEY_LOG) ? readFileSync(env.KEY_LOG, 'utf8').trim().split('\n').map(JSON.parse) : [];
  }
  function expectValues(target, expected) {
    const result = run(target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  return { env, yeo, run, calls, expectValues };
}

for (const target of targets) {
  test(`${target}: missing env and file use default yeo-key item`, t => {
    const s = setup(t);
    s.yeo();
    s.expectValues(target, ['fake-vault-id', 'fake-vault-secret']);
    assert.deepEqual(s.calls(), keys.map(key => ['Chromescribe Access', key]));
  });

  test(`${target}: yeo-key item override is passed as one argument`, t => {
    const s = setup(t);
    s.yeo();
    s.env.CHROMESCRIBE_KEY_ITEM = 'Fake Custom Access Item';
    s.expectValues(target, ['fake-vault-id', 'fake-vault-secret']);
    assert.deepEqual(s.calls(), keys.map(key => ['Fake Custom Access Item', key]));
  });

  test(`${target}: environment wins over both file and yeo-key`, t => {
    const s = setup(t);
    s.yeo();
    s.env.CF_ACCESS_CLIENT_ID = 'fake-env-id';
    s.env.CF_ACCESS_CLIENT_SECRET = 'fake-env-secret';
    writeFileSync(s.env.CHROMESCRIBE_ENV_FILE, 'export CF_ACCESS_CLIENT_ID="fake-file-id"\nexport CF_ACCESS_CLIENT_SECRET="fake-file-secret"\n');
    s.expectValues(target, ['fake-env-id', 'fake-env-secret']);
    assert.deepEqual(s.calls(), []);
  });

  test(`${target}: yeo-key wins over file and empty environment`, t => {
    const s = setup(t);
    s.yeo();
    s.env.CF_ACCESS_CLIENT_ID = '';
    s.env.CF_ACCESS_CLIENT_SECRET = '';
    writeFileSync(s.env.CHROMESCRIBE_ENV_FILE, 'export CF_ACCESS_CLIENT_ID="fake-file-id"\nexport CF_ACCESS_CLIENT_SECRET="fake-file-secret"\n');
    s.expectValues(target, ['fake-vault-id', 'fake-vault-secret']);
    assert.deepEqual(s.calls(), keys.map(key => ['Chromescribe Access', key]));
  });

  for (const mode of ['fail', 'empty', 'missing']) {
    test(`${target}: file is the last resort when yeo-key is ${mode}`, t => {
      const s = setup(t);
      if (mode !== 'missing') s.yeo();
      s.env.FAKE_KEY_MODE = mode;
      writeFileSync(s.env.CHROMESCRIBE_ENV_FILE, 'export CF_ACCESS_CLIENT_ID="fake-file-id"\nexport CF_ACCESS_CLIENT_SECRET="fake-file-secret"\n');
      s.expectValues(target, ['fake-file-id', 'fake-file-secret']);
      assert.deepEqual(s.calls(), mode === 'missing' ? [] : keys.map(key => ['Chromescribe Access', key]));
    });
  }

  for (const present of keys) {
    test(`${target}: partial environment only fetches the missing key before file`, t => {
      const s = setup(t);
      s.yeo();
      s.env[present] = 'fake-env-value';
      writeFileSync(s.env.CHROMESCRIBE_ENV_FILE, 'export CF_ACCESS_CLIENT_ID="fake-file-id"\nexport CF_ACCESS_CLIENT_SECRET="fake-file-secret"\n');
      s.expectValues(target, keys.map(key => key === present ? 'fake-env-value' : key.endsWith('ID') ? 'fake-vault-id' : 'fake-vault-secret'));
      assert.deepEqual(s.calls(), [['Chromescribe Access', keys.find(key => key !== present)]]);
    });

    for (const mode of ['fail', 'empty', 'missing']) {
      test(`${target}: ${mode} yeo-key preserves environment ${present} while falling back to file`, t => {
        const s = setup(t);
        if (mode !== 'missing') s.yeo();
        s.env.FAKE_KEY_MODE = mode;
        s.env[present] = 'fake-env-value';
        writeFileSync(s.env.CHROMESCRIBE_ENV_FILE, 'export CF_ACCESS_CLIENT_ID="fake-file-id"\nexport CF_ACCESS_CLIENT_SECRET="fake-file-secret"\n');
        s.expectValues(target, keys.map(key => key === present ? 'fake-env-value' : key.endsWith('ID') ? 'fake-file-id' : 'fake-file-secret'));
        assert.deepEqual(s.calls(), mode === 'missing' ? [] : [['Chromescribe Access', keys.find(key => key !== present)]]);
      });
    }

    for (const mode of ['fail', 'empty']) {
      test(`${target}: ${mode} vault field keeps the other vault value over file`, t => {
        const s = setup(t);
        s.yeo();
        s.env.FAKE_KEY_MODE = mode;
        s.env.FAKE_KEY_FIELD = present;
        writeFileSync(s.env.CHROMESCRIBE_ENV_FILE, 'export CF_ACCESS_CLIENT_ID="fake-file-id"\nexport CF_ACCESS_CLIENT_SECRET="fake-file-secret"\n');
        s.expectValues(target, keys.map(key => key === present ? key.endsWith('ID') ? 'fake-file-id' : 'fake-file-secret' : key.endsWith('ID') ? 'fake-vault-id' : 'fake-vault-secret'));
        assert.deepEqual(s.calls(), keys.map(key => ['Chromescribe Access', key]));
      });
    }
  }

  for (const mode of ['fail', 'empty', 'missing']) {
    test(`${target}: ${mode} yeo-key reports a missing secret without discarding the ID`, t => {
      const s = setup(t);
      if (mode !== 'missing') s.yeo();
      s.env.CF_ACCESS_CLIENT_ID = 'fake-env-id';
      s.env.FAKE_KEY_MODE = mode;
      const result = s.run(target);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /CF_ACCESS_CLIENT_SECRET is required \(env, yeo-key or .*missing\.env\)/);
      assert.doesNotMatch(result.stdout + result.stderr, /fake private diagnostic|fake-vault|fake-env-id/);
      assert.equal(existsSync(s.env.CURL_LOG), false);
      assert.deepEqual(s.calls(), mode === 'missing' ? [] : [['Chromescribe Access', keys[1]]]);
    });
  }

  for (const mode of ['fail', 'empty', 'missing']) {
    test(`${target}: ${mode} yeo-key fails clearly without leaking diagnostics or sending requests`, t => {
      const s = setup(t);
      if (mode !== 'missing') s.yeo();
      s.env.FAKE_KEY_MODE = mode;
      const result = s.run(target);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /CF_ACCESS_CLIENT_ID is required \(env, yeo-key or .*missing\.env\)/);
      assert.doesNotMatch(result.stdout + result.stderr, /fake private diagnostic|fake-vault/);
      assert.equal(existsSync(s.env.CURL_LOG), false);
      assert.equal(s.calls().length, mode === 'missing' ? 0 : 2);
    });
  }
}
