const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const source = readFileSync(join(__dirname, '..', 'process.sh'), 'utf8');
const start = source.indexOf('    DOWNLOAD_TEMPLATE=');
const end = source.indexOf('    case "$URL" in\n        https://vm.tiktok.com/', start);
assert.ok(start >= 0 && end > start);
const download = source.slice(start, end);

function run(mode, url = 'https://www.youtube.com/watch?v=OLqP8jxJ0Wc') {
  const dir = mkdtempSync(join(tmpdir(), 'process-blocked-'));
  try {
    const result = spawnSync('bash', ['-c', String.raw`
yt-dlp() {
    printf '%s\n' "$*" >> "$TMPDIR/calls"
    if [ "$MODE" = recovery ] && [ "$1" = -6 ]; then
        printf audio > "$TMPDIR/raw.webm"
        return 0
    fi
    if [ "$MODE" = generic ]; then
        echo 'ERROR: network unavailable' >&2
    else
        echo 'ERROR: Sign in to confirm you’re not a bot.' >&2
    fi
    return 1
}
` + download], {
      encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, TMPDIR: dir, PYTHON: 'python3', URL: url, MODE: mode },
    });
    return { ...result, calls: readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('persistent YouTube bot check reports youtube blocked after one IPv6 retry', () => {
  const result = run('blocked');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /youtube blocked/i);
  assert.equal(result.calls.length, 2);
  assert.doesNotMatch(result.calls[0], /(^| )-6( |$)/);
  assert.match(result.calls[1], /^-6 /);
});

test('successful IPv6 retry does not report youtube blocked', () => {
  const result = run('recovery');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.calls.length, 2);
  assert.doesNotMatch(result.stdout, /youtube blocked/i);
});

test('other failures are not mislabeled or retried', () => {
  for (const [mode, url] of [['generic', undefined], ['blocked', 'https://www.tiktok.com/@a/video/1234567890123456789']]) {
    const result = run(mode, url);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.calls.length, 1);
    assert.match(result.stdout, /yt-dlp failed/);
    assert.doesNotMatch(result.stdout, /youtube blocked/i);
    if (url) assert.match(result.calls[0], /^--proxy  -S /);
    else assert.doesNotMatch(result.calls[0], /--proxy/);
  }
});

test('monitor inherits the global YouTube route without browser authentication and keeps TikTok direct', () => {
  const monitor = readFileSync(join(__dirname, '..', 'monitor.sh'), 'utf8');
  const cookieOption = /--cookies(?:-from-browser)?\b/;
  assert.match('--cookies-from-browser chrome', cookieOption);
  assert.doesNotMatch(monitor, cookieOption);
  assert.match(monitor, /ids=\$\(yt-dlp --proxy "" /);
  const from = monitor.indexOf('    local yt_extra=()');
  const to = monitor.indexOf('    if ! yt-dlp', from);
  assert.ok(from >= 0 && to > from);
  for (const [url, expected] of [['https://www.youtube.com/watch?v=OLqP8jxJ0Wc', '0\n'], ['https://www.tiktok.com/@a/video/1234567890123456789', '2\n--proxy\n\n']]) {
    const script = 'route() {\n' + monitor.slice(from, to) + '\nprintf "%s\\n" "${#yt_extra[@]}"; for arg in "${yt_extra[@]}"; do printf "%s\\n" "$arg"; done\n}; route';
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, url }, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});
