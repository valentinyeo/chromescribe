import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const realPython = spawnSync('sh', ['-c', 'command -v python3'], {encoding:'utf8'}).stdout.trim();
function run({required = '1', exists = false, analysis = false, fallback = false, ytDlp = '', url = 'https://example.com/article'} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'process-test-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    copyFileSync(join(repo, 'process.sh'), join(dir, 'process.sh'));
    mkdirSync(join(dir, 'lib'));
    copyFileSync(join(repo, 'lib/cf_access.sh'), join(dir, 'lib/cf_access.sh'));
    copyFileSync(join(repo, 'fxtwitter_article.py'), join(dir, 'fxtwitter_article.py'));
    writeFileSync(join(dir, 'upload_article.py'), `print(${JSON.stringify(JSON.stringify({data:{id:7,already_exists:exists}}))})\n`);
    writeFileSync(join(bin, 'curl'), `#!/bin/bash
if [[ "$*" == *r.jina.ai* ]]; then
  printf '# Example\\n\\n'; printf '%0250d' 0
elif [[ "$*" == *'/api/transcripts?'* ]]; then
  printf '%s' '{"data":[]}'
elif [[ "$*" == *'/api/transcribe' ]]; then
  printf '%s' '{"data":{"id":7,"title":"Video title"}}'
else
  touch '${dir}/analyzed'
  printf '%s' '${JSON.stringify({data:{summarized:analysis,classified:analysis}})}'
fi
`, {mode:0o755});
    writeFileSync(join(bin, 'cmd.exe'), `#!/bin/bash\ntouch '${dir}/opened'\n`, {mode:0o755});
    if (ytDlp) {
      writeFileSync(join(bin, 'yt-dlp'), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${dir}/yt-dlp-calls'\n${ytDlp}\n`, {mode:0o755});
      writeFileSync(join(bin, 'ffmpeg'), `#!/bin/bash
for arg in "$@"; do
  if [[ "$arg" == */audio.mp3 ]]; then printf 'audio' > "$arg"; fi
done
`, {mode:0o755});
    }
    if (fallback) {
      writeFileSync(join(bin, 'python3'), '#!/bin/bash\nexit 1\n', {mode:0o755});
      writeFileSync(join(bin, 'python'), `#!/bin/bash\nexec '${realPython}' "$@"\n`, {mode:0o755});
    }
    const result = spawnSync('bash', [join(dir,'process.sh'), url], {
      encoding:'utf8', env:{...process.env, PATH:`${bin}:${process.env.PATH}`, CF_ACCESS_CLIENT_ID:'test-id', CF_ACCESS_CLIENT_SECRET:'test-secret', CHROMESCRIBE_ENV_FILE:join(dir,'missing.env'), CHROMESCRIBE_NO_OPEN:'1', REQUIRE_ANALYZE:required}
    });
    assert.equal(existsSync(join(dir,'opened')), false, result.stdout);
    const calls = existsSync(join(dir,'yt-dlp-calls')) ? readFileSync(join(dir,'yt-dlp-calls'), 'utf8').trim().split('\n') : [];
    return {...result, analyzed:existsSync(join(dir,'analyzed')), calls};
  } finally { rmSync(dir, {recursive:true,force:true}); }
}

test('required analysis failure fails processing; extension default remains best effort', () => {
  assert.equal(run().status, 1);
  assert.equal(run({required:''}).status, 0);
  assert.equal(run({analysis:true}).status, 0);
});
test('existing content completes without analysis and Python Store stub falls back', () => {
  const result = run({exists:true, fallback:true});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.analyzed, false);
});

test('article URL mentioning YouTube remains in article flow', () => {
  const result = run({analysis:true, url:'https://example.com/?link=youtube.com'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.analyzed, true);
});

const botCheck = `echo "ERROR: [youtube] x: Sign in to confirm you're not a bot." >&2`;
const videoDownload = `while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) file="$2"; shift 2 ;;
    --print-to-file) printf 'Video title\n' > "$3"; shift 3 ;;
    *) shift ;;
  esac
done
printf 'video' > "\${file//%(ext)s/webm}"`;
const retryLine = '>>> YouTube asked for a bot check; retrying over IPv6...';
const blockedLine = `>>> ERROR: YouTube blocked this download with a bot check ("Sign in to confirm you're not a bot"). Try again later or from another network.`;

test('IPv6 retry recovers a YouTube bot check and finishes processing', () => {
  const result = run({analysis:true, url:'https://www.youtube.com/watch?v=OLqP8jxJ0Wc', ytDlp:`
if [[ " $* " != *" -6 "* ]]; then
  ${botCheck}
  exit 1
fi
${videoDownload}`});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(retryLine), result.stdout);
  assert.match(result.stdout, /Downloaded:/);
  assert.equal(result.calls.length, 2);
  assert.doesNotMatch(result.calls[0], /(^| )-6( |$)/);
  assert.match(result.calls[1], /^-6 /);
  assert.equal(result.calls[1].slice(3), result.calls[0]);
  assert.equal(result.analyzed, true);
});

test('IPv6 retry reports a persistent YouTube bot check after exactly two attempts', () => {
  const result = run({url:'https://www.youtube.com/watch?v=OLqP8jxJ0Wc', ytDlp:`${botCheck}\nexit 1`});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.split('\n').includes(blockedLine), result.stdout);
  assert.equal(result.calls.length, 2);
  assert.match(result.calls[1], /^-6 /);
  assert.doesNotMatch(result.stdout, /yt-dlp produced no file|>>> Downloaded:/);
});

test('IPv6 retry never runs for a TikTok bot check', () => {
  const result = run({url:'https://www.tiktok.com/@a/video/1234567890123456789', ytDlp:`${botCheck}\nexit 1`});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.calls.length, 1);
  assert.doesNotMatch(result.calls[0], /(^| )-6( |$)/);
  assert.ok(result.stdout.includes('>>> ERROR: yt-dlp failed'), result.stdout);
  assert.ok(!result.stdout.includes(retryLine), result.stdout);
});

test('IPv6 retry also handles missing or empty raw files with a zero exit status', () => {
  for (const raw of ['', 'while [ "$1" != "-o" ]; do shift; done; touch "${2//%(ext)s/webm}"']) {
    const result = run({analysis:true, url:'https://youtu.be/OLqP8jxJ0Wc', ytDlp:`
if [[ " $* " != *" -6 "* ]]; then
  ${botCheck}
  ${raw}
  exit 0
fi
${videoDownload}`});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.calls.length, 2);
    assert.match(result.stdout, /Downloaded:/);
    assert.ok(result.stdout.includes(retryLine), result.stdout);
  }
});

test('IPv6 retry uses the last attempt output for non-bot failures', () => {
  const result = run({url:'https://music.youtube.com/watch?v=OLqP8jxJ0Wc', ytDlp:`
if [[ " $* " != *" -6 "* ]]; then
  ${botCheck}
else
  echo 'ERROR: network unavailable' >&2
fi
exit 1`});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.calls.length, 2);
  assert.ok(result.stdout.includes('>>> ERROR: yt-dlp failed'), result.stdout);
  assert.ok(!result.stdout.includes(blockedLine), result.stdout);
});

test('IPv6 retry does not hide other download failures behind a successful tail or a raw file', () => {
  for (const ytDlp of ['exit 1', 'exit 0', `${videoDownload}\nexit 1`]) {
    const result = run({url:'https://m.youtube.com/watch?v=OLqP8jxJ0Wc', ytDlp});
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.calls.length, 1);
    assert.ok(result.stdout.includes('>>> ERROR: yt-dlp failed'), result.stdout);
    assert.doesNotMatch(result.stdout, />>> Downloaded:/);
    assert.ok(!result.stdout.includes(retryLine), result.stdout);
  }
});
