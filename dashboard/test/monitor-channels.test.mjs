import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../../monitor.sh', import.meta.url), 'utf8');
const apiCall = source.slice(source.indexOf('api_call() {'), source.indexOf('\nsend_telegram()'));
const channelBlock = source.slice(source.indexOf('if api_call GET "/api/channels?active=1"'), source.indexOf('log "Checking channels for new videos'));
const id = 'UC9-XlrmeMEAdIha_XBuHp1w';

function run(payload, exit = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-channels-test-'));
  try {
    writeFileSync(join(dir, 'fallback.txt'), 'UCfallbackfallbackfallback # @fallback\n');
    writeFileSync(join(dir, 'curl'), `#!/bin/bash\nprintf '%s\\n' "$@" > "$MOCK_ARGS"\nprintf '%s' "$MOCK_PAYLOAD"\nexit "$MOCK_EXIT"\n`, { mode: 0o755 });
    const script = `set -uo pipefail
TMPDIR="$TEST_DIR"
CHANNELS_FILE="$TEST_DIR/fallback.txt"
DASHBOARD_URL="https://test.example"
CF_ACCESS_CLIENT_ID="test-id"
CF_ACCESS_CLIENT_SECRET="test-secret"
log() { echo "$*" >&2; }
${apiCall}
${channelBlock}
cat "$CHANNELS_FILE"
`;
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEST_DIR: dir,
        MOCK_ARGS: join(dir, 'args'), MOCK_PAYLOAD: typeof payload === 'string' ? payload : JSON.stringify(payload), MOCK_EXIT: String(exit) },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    return { stdout: result.stdout, stderr: result.stderr, args: readFileSync(join(dir, 'args'), 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('monitor maps API rows to channel lines and uses existing Access headers', () => {
  const result = run({ success: true, data: [
    { id, platform: 'youtube', handle: '@jaketrinder', name: 'Jake Trinder' },
    { id: 'tiktok:@some.user', platform: 'tiktok', handle: '@some.user', name: 'Some\nUser' },
  ] });
  assert.equal(result.stdout, `${id} # @jaketrinder\ntiktok:@some.user # Some User\n`);
  assert.equal(result.stderr, '');
  for (const arg of ['https://test.example/api/channels?active=1', 'CF-Access-Client-Id: test-id',
    'CF-Access-Client-Secret: test-secret', '--fail', '--max-time', '30', '-L']) {
    assert.ok(result.args.split('\n').includes(arg), arg);
  }
  assert.match(source, /done < "\$CHANNELS_FILE"/);
  assert.ok(source.indexOf('if [ -n "$FORCE_VIDEO" ]; then') < source.indexOf('if api_call GET "/api/channels?active=1"'));
});

test('monitor falls back for transport/HTTP errors, bad JSON, and malformed rows', () => {
  const valid = { success: true, data: [{ id, platform: 'youtube', handle: '@jaketrinder', name: 'Jake' }] };
  for (const [payload, exit] of [[valid, 22], [valid, 7],
    ['not JSON', 0], [{ success: false, data: valid.data }, 0], [{ success: true, data: null }, 0],
    [{ success: true, data: [{}] }, 0], [{ success: true, data: [valid.data[0], { id: 'junk', platform: 'youtube' }] }, 0]]) {
    const result = run(payload, exit);
    assert.equal(result.stdout, 'UCfallbackfallbackfallback # @fallback\n');
    assert.match(result.stderr, /using channels.txt/);
  }
});

test('monitor skips paused YouTube and TikTok rows even if returned by API', () => {
  const result = run({ success: true, data: [
    { id, platform: 'youtube', handle: '@youtube', name: 'Paused', paused: 1 },
    { id: 'tiktok:@paused', platform: 'tiktok', handle: '@paused', name: 'Paused', paused: true },
    { id: 'tiktok:@active', platform: 'tiktok', handle: '@active', name: 'Active', paused: 0 },
  ] });
  assert.equal(result.stdout, 'tiktok:@active # Active\n');
  assert.equal(result.stderr, '');
});

test('empty successful active response never falls back, including all-paused lists', () => {
  for (const data of [[], [{ id, platform: 'youtube', handle: '@paused', name: 'Paused', paused: 1 }]]) {
    const result = run({ success: true, data });
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});
