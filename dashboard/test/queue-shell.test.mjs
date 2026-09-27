// End-to-end tests for queue.sh with a mocked curl and monitor.sh.
// Proves the drainer never reports success when the API, downloader, or
// mark-done call fails, and that malformed-but-valid-JSON queue payloads abort
// instead of being silently treated as an empty queue.
//
// Run with: node --test dashboard/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const QUEUE_SH = join(REPO, 'queue.sh');

const CURL_MOCK = `#!/usr/bin/env bash
set -uo pipefail
mode="\${MOCK_CURL_MODE:-ok}"
out=""; url=""; method="GET"; data=""; platforms=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -X) method="$2"; shift 2;;
    -H) shift 2;;
    --max-time|--proto) shift 2;;
    -w) shift 2;;
    -d) data="$2"; shift 2;;
    --data-urlencode) platforms="$2"; shift 2;;
    --get) shift;;
    -sS|-f|-s|-L) shift;;
    *) url="$1"; shift;;
  esac
done
if [ -n "$platforms" ]; then url="$url?$platforms"; fi
log() { if [ -n "\${MOCK_CURL_LOG:-}" ]; then printf '%s\\t%s\\t%s\\n' "$method" "$url" "$data" >> "$MOCK_CURL_LOG"; fi; }
if [[ "$url" == *oembed* ]]; then
  printf '{"title":"Mock Video Title"}'
  exit 0
fi
body() { if [ -n "$out" ]; then printf '%s' "$1" > "$out"; fi; }
case "$mode" in
  ok)
    log
    if [ "$method" = "GET" ]; then
      body '{"success":true,"data":[{"id":7,"video_id":"abcdefghijk","url":"https://www.youtube.com/watch?v=abcdefghijk"}]}'
    else
      body '{"success":true,"data":{"id":7,"status":"done"}}'
    fi
    echo 200; exit 0;;
  mixed)
    log
    if [ "$method" = "GET" ]; then
      body '{"success":true,"data":[{"id":7,"video_id":"abcdefghijk","url":"https://www.youtube.com/watch?v=abcdefghijk"},{"id":8,"video_id":"article:abc123","url":"https://example.com/story"},{"id":9,"video_id":"tiktok:1234567890123456789","url":"https://www.tiktok.com/@user/video/1234567890123456789"},{"id":10,"video_id":"tiktok-short:ABC123","url":"https://vt.tiktok.com/ABC123/"}]}'
    else
      body '{"success":true,"data":{}}'
    fi
    echo 200; exit 0;;
  empty)
    log; body '{"success":true,"data":[]}'; echo 200; exit 0;;
  two_rows)
    log
    if [ "$method" = "GET" ]; then
      body '{"success":true,"data":[{"id":7,"video_id":"aaaaaaaaaaa","url":"https://www.youtube.com/watch?v=aaaaaaaaaaa"},{"id":8,"video_id":"bbbbbbbbbbb","url":"https://www.youtube.com/watch?v=bbbbbbbbbbb"}]}'
    else
      body '{"success":true,"data":{}}'
    fi
    echo 200; exit 0;;
  http404)
    log; echo 404; echo "not found" >&2; exit 22;;
  badjson)
    log; body 'this is not json'; echo 200; exit 0;;
  envelope_false)
    log; body '{"success":false,"error":"boom"}'; echo 200; exit 0;;
  badshape_null)
    log; body '{"success":true,"data":null}'; echo 200; exit 0;;
  baddata_row)
    log; body '{"success":true,"data":[{"id":7}]}'; echo 200; exit 0;;
  put_fail)
    log
    if [ "$method" = "GET" ]; then
      body '{"success":true,"data":[{"id":7,"video_id":"abcdefghijk","url":"https://www.youtube.com/watch?v=abcdefghijk"}]}'
      echo 200; exit 0
    else
      echo 500; echo "markdone failed" >&2; exit 22
    fi;;
  *) echo "unknown mock mode" >&2; exit 97;;
esac
`;

const MONITOR_MOCK = `#!/usr/bin/env bash
set -uo pipefail
vid="$2"
if [ -n "\${MOCK_MONITOR_LOG:-}" ]; then printf '%s\\n' "\${REQUIRE_ANALYZE:-unset}" >> "$MOCK_MONITOR_LOG"; fi
if [ "\${MOCK_ANALYZE_FAIL:-0}" = "1" ] && [ "\${REQUIRE_ANALYZE:-0}" = "1" ]; then
  echo "mock /analyze failed for $vid" >&2
  exit 1
fi
if [ -n "\${MOCK_FAIL_VIDEO:-}" ] && [ "$vid" = "$MOCK_FAIL_VIDEO" ]; then
  echo "mock monitor failure for $vid" >&2
  exit 1
fi
exit 0
`;

const PROCESS_MOCK = `#!/usr/bin/env bash
printf '%s\\t%s\\t%s\\t%s\\n' "$PWD" "$CHROMESCRIBE_NO_OPEN" "$REQUIRE_ANALYZE" "$1" >> "$MOCK_PROCESS_LOG"
if [ "$1" = "\${MOCK_FAIL_URL:-}" ]; then exit 1; fi
exit 0
`;

function runQueue({ mode = 'ok', monitorExit = 0, failVideo = '', analyzeFail = false, monitorLog = true, failUrl = '', platforms, pythonStub = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'cs-queue-test-'));
  const bindir = join(tmp, 'bin');
  mkdirSync(bindir);
  writeFileSync(join(bindir, 'curl'), CURL_MOCK, { mode: 0o755 });
  writeFileSync(join(tmp, 'monitor.sh'), MONITOR_MOCK, { mode: 0o755 });
  copyFileSync(QUEUE_SH, join(tmp, 'queue.sh'));
  writeFileSync(join(tmp, 'process.sh'), PROCESS_MOCK, { mode: 0o755 });
  if (pythonStub) {
    const pythonPath = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(bindir, 'python3'), '#!/bin/bash\necho stub >> "$MOCK_PYTHON_LOG"\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bindir, 'python'), `#!/bin/bash\nexec "${pythonPath}" "$@"\n`, { mode: 0o755 });
  }

  const curlLog = join(tmp, 'curl.log');
  const monLog = join(tmp, 'monitor.log');
  const processLog = join(tmp, 'process.log');
  const pythonLog = join(tmp, 'python.log');
  const env = {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    CF_ACCESS_CLIENT_ID: 'test-id',
    CF_ACCESS_CLIENT_SECRET: 'test-secret',
    CHROMESCRIBE_ENV_FILE: join(tmp, 'does-not-exist.env'),
    MOCK_CURL_MODE: mode,
    MOCK_CURL_LOG: curlLog,
    MOCK_FAIL_VIDEO: failVideo,
    MOCK_FAIL_URL: failUrl,
    MOCK_PROCESS_LOG: processLog,
    MOCK_PYTHON_LOG: pythonLog,
    MOCK_ANALYZE_FAIL: analyzeFail ? '1' : '0',
    QUEUE_LOCK_FILE: join(tmp, 'lock'),
    MONITOR_SH: join(tmp, 'monitor.sh'),
  };
  if (monitorLog) env.MOCK_MONITOR_LOG = monLog;
  delete env.QUEUE_PLATFORMS;
  if (platforms !== undefined) env.QUEUE_PLATFORMS = platforms;

  const res = spawnSync('bash', [join(tmp, 'queue.sh')], { env, encoding: 'utf8' });
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  return {
    status: res.status,
    repo: tmp,
    processLog: existsSync(processLog) ? readFileSync(processLog, 'utf8') : '',
    pythonLog: existsSync(pythonLog) ? readFileSync(pythonLog, 'utf8') : '',
    output,
    curlLog: existsSync(curlLog) ? readFileSync(curlLog, 'utf8') : '',
    monLog: existsSync(monLog) ? readFileSync(monLog, 'utf8') : '',
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

test('valid row + successful monitor marks done and exits 0', () => {
  const r = runQueue({ mode: 'ok' });
  try {
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /Queue #7: done/);
    assert.match(r.curlLog, /PUT\t.*\/api\/queue\/7\t\{"status":"done"\}/);
    assert.match(r.monLog, /^1$/m, 'queue must set REQUIRE_ANALYZE=1 for monitor.sh');
  } finally {
    r.cleanup();
  }
});

test('empty queue exits 0 without calling monitor', () => {
  const r = runQueue({ mode: 'empty' });
  try {
    assert.equal(r.status, 0, r.output);
    assert.doesNotMatch(r.curlLog, /PUT/);
  } finally {
    r.cleanup();
  }
});

test('HTTP 404 on queue fetch aborts nonzero, no false completion', () => {
  const r = runQueue({ mode: 'http404' });
  try {
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /could not fetch pending queue/);
    assert.doesNotMatch(r.output, /: done/);
    assert.doesNotMatch(r.curlLog, /PUT/);
  } finally {
    r.cleanup();
  }
});

test('malformed JSON aborts nonzero', () => {
  const r = runQueue({ mode: 'badjson' });
  try {
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /could not fetch pending queue/);
    assert.doesNotMatch(r.output, /: done/);
  } finally {
    r.cleanup();
  }
});

test('success:false envelope aborts nonzero', () => {
  const r = runQueue({ mode: 'envelope_false' });
  try {
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /could not fetch pending queue/);
  } finally {
    r.cleanup();
  }
});

test('valid JSON but data:null aborts nonzero, not treated as empty', () => {
  const r = runQueue({ mode: 'badshape_null' });
  try {
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /malformed row payload/);
    assert.doesNotMatch(r.curlLog, /PUT/);
  } finally {
    r.cleanup();
  }
});

test('valid JSON but malformed row aborts nonzero', () => {
  const r = runQueue({ mode: 'baddata_row' });
  try {
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /malformed row payload/);
    assert.doesNotMatch(r.curlLog, /PUT/);
  } finally {
    r.cleanup();
  }
});

test('downloader failure marks failed, continues to next row, exits nonzero', () => {
  const r = runQueue({ mode: 'two_rows', failVideo: 'aaaaaaaaaaa' });
  try {
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /Queue #7: FAILED/);
    assert.match(r.output, /Queue #8: done/);
    assert.match(r.curlLog, /PUT\t.*\/api\/queue\/7\t\{"status":"failed"\}/);
    assert.match(r.curlLog, /PUT\t.*\/api\/queue\/8\t\{"status":"done"\}/);
  } finally {
    r.cleanup();
  }
});

test('mark-done failure is not reported as success and exits nonzero', () => {
  const r = runQueue({ mode: 'put_fail' });
  try {
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /marking done failed/);
    assert.doesNotMatch(r.output, /Queue #7: done/);
  } finally {
    r.cleanup();
  }
});

test('analyze failure in the force path is reported as a failed row', () => {
  const r = runQueue({ mode: 'ok', analyzeFail: true });
  try {
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /Queue #7: FAILED/);
    assert.match(r.curlLog, /PUT\t.*\/api\/queue\/7\t\{"status":"failed"\}/);
    assert.doesNotMatch(r.output, /Queue #7: done/);
  } finally {
    r.cleanup();
  }
});

test('service token is never printed', () => {
  const r = runQueue({ mode: 'ok' });
  try {
    assert.doesNotMatch(r.output, /test-secret/);
    assert.doesNotMatch(r.output, /test-id/);
  } finally {
    r.cleanup();
  }
});

test('default queue filter leaves TikTok for the residential drainer', () => {
  const r = runQueue();
  try {
    assert.equal(r.status, 0, r.output);
    assert.match(r.curlLog, /GET\t.*\/api\/queue\?platforms=youtube,article\t/);
  } finally { r.cleanup(); }
});

test('QUEUE_PLATFORMS selects the Windows TikTok drainer', () => {
  const r = runQueue({ platforms: 'tiktok', mode: 'empty' });
  try {
    assert.equal(r.status, 0, r.output);
    assert.match(r.curlLog, /GET\t.*\/api\/queue\?platforms=tiktok\t/);
  } finally { r.cleanup(); }
});

test('article and both TikTok ID forms run process.sh in the repo without opening a browser', () => {
  const r = runQueue({ mode: 'mixed', platforms: 'youtube,article,tiktok' });
  try {
    assert.equal(r.status, 0, r.output);
    assert.equal(r.monLog, '1\n', 'only YouTube should call monitor.sh');
    assert.deepEqual(r.processLog.trim().split('\n'), [
      `${r.repo}\t1\t1\thttps://example.com/story`,
      `${r.repo}\t1\t1\thttps://www.tiktok.com/@user/video/1234567890123456789`,
      `${r.repo}\t1\t1\thttps://vt.tiktok.com/ABC123/`,
    ]);
    assert.equal((r.curlLog.match(/"status":"done"/g) || []).length, 4);
  } finally { r.cleanup(); }
});

for (const [id, url] of [[8, 'https://example.com/story'], [9, 'https://www.tiktok.com/@user/video/1234567890123456789'], [10, 'https://vt.tiktok.com/ABC123/']]) {
  test(`process.sh failure marks row ${id} failed and drains remaining rows`, () => {
    const r = runQueue({ mode: 'mixed', failUrl: url });
    try {
      assert.notEqual(r.status, 0, r.output);
      assert.match(r.curlLog, new RegExp(`/api/queue/${id}\\t\\{"status":"failed"\\}`));
      assert.equal((r.curlLog.match(/"status":"done"/g) || []).length, 3);
    } finally { r.cleanup(); }
  });
}

test('broken python3 Store stub falls back to python once for the entire drain', () => {
  const r = runQueue({ mode: 'mixed', pythonStub: true });
  try {
    assert.equal(r.status, 0, r.output);
    assert.equal(r.pythonLog, 'stub\n');
    assert.equal((r.curlLog.match(/"status":"done"/g) || []).length, 4);
  } finally { r.cleanup(); }
});
