const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'encoding-check.mjs');
const run = (...files) => spawnSync(process.execPath, [script, ...files], { cwd: root, encoding: 'utf8' });

function fixture(extension, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encoding-check-'));
  const file = path.join(dir, `fixture${extension}`);
  try {
    fs.writeFileSync(file, source);
    return run(file);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('historical process.sh before dff8835 fails on open() without encoding', () => {
  const result = run('tools/fixtures/process-before-utf8.sh');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /process-before-utf8\.sh:\d+: open\(\).*use open\(path, encoding='utf-8'\)/);
});

test('good Python fixture has UTF-8 text IO and stdout', () => {
  const result = run('tools/fixtures/encoding-good.py');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Encoding check passed/);
});

test('repository passes the encoding checker', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Encoding check passed/);
});

test('Python calls handle nested parentheses, multiline arguments and multiple opens', () => {
  const result = fixture('.py', `with open(
    path_for('name)')
) as file:
    value = file.read()
a = open('good', encoding='utf-8'); b = open('bad')
c = open(open('inner', encoding='utf-8').read())
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fixture\.py:1: open\(\)/);
  assert.match(result.stderr, /fixture\.py:5: open\(\)/);
  assert.match(result.stderr, /fixture\.py:6: open\(\)/);
  assert.equal(result.stderr.trim().split('\n').length, 3);
});

test('binary modes and explicit encodings pass without confusing filenames with modes', () => {
  for (const mode of ['rb', 'wb', 'ab', 'xb', 'r+b', 'w+b', 'a+b', 'rb+', 'wb+', 'ab+', 'br']) {
    assert.equal(fixture('.py', `a = open('file', '${mode}')\n`).status, 0, mode);
    assert.equal(fixture('.py', `a = open('file', mode="${mode}")\n`).status, 0, mode);
  }
  assert.equal(fixture('.py', 'a = open(path_for("x)"), encoding = "utf-8")\n').status, 0);
  for (const call of ["open('rb')", "open('file', 'r')", "open('encoding=utf-8')", "open(get_path(encoding='utf-8'))", "open('file', helper('rb'))"]) {
    assert.equal(fixture('.py', call + '\n').status, 1, call);
  }
});

test('non-calls, urlopen and os.open are ignored', () => {
  const result = fixture('.py', `a = urlopen('https://example.com')
b = os.open('file', flags)
c = 'open(path)'
d = "print(value)"
`);
  assert.equal(result.status, 0, result.stderr);
});

test('printing requires a real UTF-8 stdout reconfiguration in either quote style', () => {
  assert.equal(fixture('.py', "print('hello')\n").status, 1);
  assert.match(fixture('.py', "print('hello')\n").stderr, /add sys\.stdout\.reconfigure\(encoding='utf-8', errors='replace'\)/);
  assert.equal(fixture('.py', `text = "sys.stdout.reconfigure(encoding='utf-8')"\nprint('hello')\n`).status, 1);
  for (const quote of ["'", '"']) {
    const result = fixture('.py', `import sys\nsys.stdout.reconfigure(encoding=${quote}utf-8${quote}, errors='replace')\nprint('hello')\n`);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('shell and batch embedded Python checks every open() on a line', () => {
  for (const extension of ['.sh', '.bat']) {
    const bad = fixture(extension, `python -c "a = open('good', encoding='utf-8'); b = open(path_for('bad)'))"\n`);
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stderr, /fixture\.(?:sh|bat):1: open\(\)/);
    const good = fixture(extension, `python -c "a = open('good', encoding='utf-8'); b = open('binary', 'rb'); c = urlopen(url); d = os.open(path, flags)"\n`);
    assert.equal(good.status, 0, good.stderr);
    const multiline = fixture(extension, `with open(\n    path_for('name)'),\n    encoding='utf-8'\n) as stream:\n    value = stream.read()\n`);
    assert.equal(multiline.status, 0, multiline.stderr);
  }
});

test('shell words and functions are not Python calls', () => {
  const result = fixture('.sh', `echo 'open(path)'
printf '%s' 'open(path)'
xdg-open(path)
open() { echo ok; }
`);
  assert.equal(result.status, 0, result.stderr);
});

test('default git scan excludes only the historical negative fixture, not other fixtures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encoding-check-git-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  try {
    git('init', '-q');
    fs.mkdirSync(path.join(dir, 'tools/fixtures'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures/process-before-utf8.sh'), path.join(dir, 'tools/fixtures/process-before-utf8.sh'));
    const other = path.join(dir, 'tools/fixtures/other.py');
    fs.writeFileSync(other, "open('missing-encoding')\n");
    git('add', '.');
    const bad = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stderr, /other\.py:1: open\(\)/);
    assert.doesNotMatch(bad.stderr, /process-before-utf8/);
    fs.copyFileSync(path.join(__dirname, 'fixtures/encoding-good.py'), other);
    const good = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.equal(good.status, 0, good.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
