import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));

const analyzeOk = '{"success":true,"data":{"summarized":true,"classified":true,"word_count":900,"category":"Health"}}';
const summarizedBody = '# Title\n\n## TL;DR\nLead line\n\n## Summary\n**Bottom line:** Detail.\n\n## Full Transcript\nbody\n';
const rawBody = '# Title\n\n## Full Transcript\nbody\n';

function stub(dir, name, body) {
  const path = join(dir, 'bin', name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return path;
}

function curlStub(dir, { failures, summary, analyze, transcribe }) {
  writeFileSync(join(dir, 'raw.md'), rawBody);
  writeFileSync(join(dir, 'summarized.md'), summarizedBody);
  stub(dir, 'curl', `args="$*"
state="${dir}"
count() { cat "$state/analyze-count" 2>/dev/null || echo 0; }
case "$args" in
  *r.jina.ai*) printf '# Article\\n\\n'; printf '%0250d' 0; exit 0;;
  */api/transcript/*/content) touch "$state/content-check"
    if [ -f "$state/summary" ]; then cat "$state/summarized.md"; else cat "$state/raw.md"; fi
    exit 0;;
  */api/transcripts/*/analyze)
    n=$(( $(count) + 1 ))
    echo "$n" > "$state/analyze-count"
    if [ "$n" -le ${failures} ]; then exit 28; fi
    printf '%s' '${JSON.stringify(analyze)}'
    exit 0;;
  */api/transcribe) printf '%s' '${JSON.stringify(transcribe)}'; exit 0;;
esac
printf '%s' '{"success":true,"data":{}}'
exit 0
`);
  stub(dir, 'cmd.exe', 'exit 0');
  if (summary) writeFileSync(join(dir, 'summary'), '');
}

function prepare(name) {
  const dir = mkdtempSync(join(tmpdir(), `analyze-retry-${name}-`));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'lib'));
  mkdirSync(join(dir, 'home'));
  for (const file of ['process.sh', 'monitor.sh', 'fxtwitter_article.py', 'lib/cf_access.sh', 'lib/analyze.sh']) {
    copyFileSync(join(repo, file), join(dir, file));
  }
  writeFileSync(join(dir, 'upload_article.py'), `print(${JSON.stringify(JSON.stringify({ data: { id: 7, already_exists: false } }))})\n`);
  stub(dir, 'yt-dlp', `audio=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) audio="$2"; shift 2;;
    *) shift;;
  esac
done
printf 'audio' > "$audio"
exit 0
`);
  stub(dir, 'ffmpeg', 'exit 0');
  return dir;
}

function env(dir, extra = {}) {
  return {
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    HOME: join(dir, 'home'),
    CF_ACCESS_CLIENT_ID: 'test-id',
    CF_ACCESS_CLIENT_SECRET: 'test-secret',
    CHROMESCRIBE_ENV_FILE: join(dir, 'missing.env'),
    CHROMESCRIBE_NO_OPEN: '1',
    ANALYZE_RETRY_DELAY: '0',
    ...extra,
  };
}

function runArticle(options) {
  const dir = prepare('process');
  try {
    curlStub(dir, { transcribe: { data: { id: 7, title: 'Article title' } }, ...options });
    const result = spawnSync('bash', [join(dir, 'process.sh'), 'https://example.com/retry-article'], {
      encoding: 'utf8', timeout: 30000, env: env(dir, { REQUIRE_ANALYZE: options.required ?? '1' }),
    });
    const attempts = Number((existsSync(join(dir, 'analyze-count')) ? readFileSync(join(dir, 'analyze-count'), 'utf8') : '0').trim());
    return { ...result, attempts, checked: existsSync(join(dir, 'content-check')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runMonitor(options) {
  const dir = prepare('monitor');
  try {
    curlStub(dir, { transcribe: { data: { id: 42, title: 'Monitor video' } }, ...options });
    const result = spawnSync('bash', [join(dir, 'monitor.sh'), '--force', 'MONITOR0001', 'Monitor video'], {
      encoding: 'utf8', timeout: 30000, env: env(dir, { CHROMESCRIBE_TELEGRAM: '0' }),
    });
    const attempts = Number((existsSync(join(dir, 'analyze-count')) ? readFileSync(join(dir, 'analyze-count'), 'utf8') : '0').trim());
    return { ...result, attempts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('process.sh retries the analyze step after a failed attempt and then summarizes', () => {
  const result = runArticle({ failures: 1, analyze: analyzeOk });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.attempts, 2);
  assert.match(result.stderr, /Analyze attempt 1\/3 failed/);
  assert.ok(result.stdout.includes('Cloudflare summary complete'), result.stdout);
});

test('process.sh gives up after three failed attempts when analysis is required', () => {
  const result = runArticle({ failures: 3, analyze: analyzeOk });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.attempts, 3);
  assert.match(result.stdout, /WARNING: Cloudflare analysis failed/);
});

test('process.sh keeps one attempt when the first one succeeds', () => {
  const result = runArticle({ failures: 0, analyze: analyzeOk });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.attempts, 1);
  assert.equal(result.checked, false);
});

test('process.sh stops retrying once the server has already written the summary', () => {
  const result = runArticle({ failures: 1, analyze: analyzeOk, summary: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.attempts, 1);
  assert.equal(result.checked, true);
  assert.match(result.stderr, /server finished the summary after the client gave up/);
  assert.ok(result.stdout.includes('Cloudflare analysis had already finished on the server'), result.stdout);
  assert.doesNotMatch(result.stdout, /Classification failed/);
});

test('monitor.sh retries the analyze step and reports the hosted analysis', () => {
  const result = runMonitor({ failures: 1, analyze: analyzeOk });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.attempts, 2);
  assert.match(result.stderr, /Analyze attempt 1\/3 failed/);
  assert.ok(result.stdout.includes('Analysis complete (word_count=900, category=Health)'), result.stdout);
  assert.ok(result.stdout.includes('Transcribed and uploaded as #42'), result.stdout);
});
