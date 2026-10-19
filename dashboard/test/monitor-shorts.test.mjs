import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = readFileSync(join(root, 'monitor.sh'), 'utf8');
const recent = new Date(Date.now() - 2 * 3600000).toISOString();
const old = new Date(Date.now() - 72 * 3600000).toISOString();
const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
  <link rel="alternate" href="https://www.youtube.com/channel/UCtest"/>
  <entry>
    <id>yt:video:ShortID0001</id><yt:videoId>ShortID0001</yt:videoId>
    <title>Short café</title>
    <link rel="alternate" href="https://www.youtube.com/shorts/ShortID0001"/>
    <published>${recent}</published><updated>${recent}</updated>
    <media:group><media:title>Short café</media:title></media:group>
  </entry>
  <entry>
    <id>yt:video:VideoID0001</id><yt:videoId>VideoID0001</yt:videoId>
    <title>Normal café &amp; résumé</title>
    <link href="https://www.youtube.com/watch?v=VideoID0001" rel="alternate"/>
    <published>${recent}</published><updated>${recent}</updated>
  </entry>
  <entry>
    <id>yt:video:OlderID0001</id><yt:videoId>OlderID0001</yt:videoId>
    <title>Older video</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=OlderID0001"/>
    <published>${old}</published><updated>${recent}</updated>
  </entry>
</feed>`;
const normalLine = 'VideoID0001\tNormal café &amp; résumé\n';

function block(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing source block: ${start}`);
  return source.slice(a, b);
}

function functionBody(name) {
  return source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] || '';
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 10000, ...options });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

const autoLoop = block("    while IFS=$'\\t' read -r video_id title; do", '\ndone < "$CHANNELS_FILE"');

test('feed parser excludes Shorts, respects hours, and is wired into monitor RSS fetching', () => {
  const env = { ...process.env, LC_ALL: 'C', PYTHONIOENCODING: 'ascii' };
  const parse = (xml, args = []) => run('python3', ['lib/youtube_feed.py', '-', ...args], { input: xml, env }).stdout;
  assert.equal(parse(fixture), normalLine);
  assert.equal(parse(fixture.replace('/channel/UCtest', '/shorts/feed-level-link')), normalLine);
  assert.equal(parse(fixture, ['--hours', '100']), `${normalLine}OlderID0001\tOlder video\n`);
  const malformed = `<feed>
<entry><yt:videoId>Fallback001</yt:videoId><published>${recent}</published></entry>
<entry><title>Missing ID</title><published>${recent}</published></entry>
<entry><yt:videoId>MissingDate</yt:videoId></entry>
<entry><yt:videoId>InvalidDate</yt:videoId><published>not-a-date</published></entry>
<entry><yt:videoId>NaiveDate01</yt:videoId><published>2026-01-01T00:00:00</published></entry>
<entry><yt:videoId>ShortID0002</yt:videoId><published>${recent}</published><link href='/shorts/ShortID0002' rel='alternate'/></entry>
</feed>`;
  assert.equal(parse(malformed), 'Fallback001\tUnknown\n');

  const dir = mkdtempSync(join(tmpdir(), 'monitor-feed-test-'));
  try {
    writeFileSync(join(dir, 'feed.xml'), fixture);
    writeFileSync(join(dir, 'sitecustomize.py'), `import io, os, urllib.request

def urlopen(url, **kwargs):
    with open(os.environ['MOCK_REQUEST'], 'w', encoding='utf-8') as f:
        f.write(url)
    if os.environ.get('MOCK_FETCH_ERROR'):
        raise OSError('mock unavailable')
    with open(os.environ['MOCK_FEED'], encoding='utf-8') as f:
        return io.BytesIO(f.read().encode('utf-8'))

urllib.request.urlopen = urlopen
`);
    const fetchEnv = { ...process.env, PYTHONPATH: dir, MOCK_FEED: join(dir, 'feed.xml'), MOCK_REQUEST: join(dir, 'request') };
    const script = `set -uo pipefail\nSCRIPT_DIR="$TEST_ROOT"\n${functionBody('get_todays_videos')}\nget_todays_videos UCtest\n`;
    const fetched = run('bash', ['-c', script], { env: { ...fetchEnv, TEST_ROOT: root } });
    assert.equal(fetched.stdout, normalLine);
    assert.equal(readFileSync(join(dir, 'request'), 'utf8'), 'https://www.youtube.com/feeds/videos.xml?channel_id=UCtest');
    const error = spawnSync('python3', ['lib/youtube_feed.py', 'UCtest'], {
      cwd: root, env: { ...fetchEnv, MOCK_FETCH_ERROR: '1' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(error.status, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /^RSS fetch error: mock unavailable\n$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('YouTube auto loop probes and skips Shorts without processing or marking them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-shorts-test-'));
  try {
    writeFileSync(join(dir, 'processed'), 'AlreadyDone\n');
    writeFileSync(join(dir, 'calls'), '');
    writeFileSync(join(dir, 'curl'), `#!/bin/bash
printf '%s\\n' "$*" >> "$PROBE_ARGS"
case "\${!#}" in
  */ShortID0001) printf 200 ;;
  */Unavailable) printf 000; exit 7 ;;
  */NotFound001) printf 404 ;;
  *) printf 303 ;;
esac
`, { mode: 0o755 });
    const script = `set -uo pipefail
PROCESSED_FILE="$TEST_DIR/processed"
NEW_COUNT=0
TODAY=2026-01-01
channel_id=UCtest
log() { echo "$*"; }
get_todays_videos() { printf 'ShortID0001\\tShort café\\nVideoID0001\\tNormal café\\nAlreadyDone\\tProcessed video\\n'; }
process_video() { echo "$1" >> "$TEST_DIR/calls"; }
${functionBody('is_youtube_short')}
${autoLoop}
printf 'New count: %s\\n' "$NEW_COUNT"
`;
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEST_DIR: dir, PROBE_ARGS: join(dir, 'probes') };
    const result = run('bash', ['-c', script], { env });
    assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), 'VideoID0001\n', result.stdout + result.stderr);
    assert.equal(readFileSync(join(dir, 'processed'), 'utf8'), 'AlreadyDone\nVideoID0001\n');
    assert.match(result.stdout, /Skipping Short: ShortID0001 \(Short café\)/);
    assert.match(result.stdout, /Already processed: AlreadyDone/);
    assert.match(result.stdout, /New count: 1\n/);
    const probes = readFileSync(join(dir, 'probes'), 'utf8').trim().split('\n');
    assert.equal(probes.length, 2);
    for (const [i, id] of ['ShortID0001', 'VideoID0001'].entries()) {
      assert.equal(probes[i], `-s --max-time 15 -o /dev/null -w %{http_code} https://www.youtube.com/shorts/${id}`);
    }
    for (const id of ['VideoID0001', 'Unavailable', 'NotFound001']) {
      const probe = run('bash', ['-c', `${functionBody('is_youtube_short')}\nif is_youtube_short "${id}"; then exit 1; fi`], { env });
      assert.equal(probe.stdout, '');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Shorts guard is auto-only: force and process_video keep accepting Shorts', () => {
  const force = block('if [ -n "$FORCE_VIDEO" ]; then', '\nif api_call GET "/api/channels?active=1"');
  const processVideo = functionBody('process_video');
  assert.ok(processVideo);
  assert.doesNotMatch(force, /is_youtube_short/);
  assert.doesNotMatch(processVideo, /is_youtube_short/);
  assert.match(force, /process_video "\$FORCE_VIDEO" "\$FORCE_TITLE"/);
  assert.match(autoLoop, /if is_youtube_short "\$video_id"; then/);
  assert.ok(functionBody('is_youtube_short'));
});
