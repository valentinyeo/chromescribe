import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(repo, 'cli/chromescribe');
function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'chromescribe-test-'));
  const channels = [
    { id: 'UC' + 'a'.repeat(22), name: 'Zulu', handle: '@zulu', platform: 'youtube', paused: 0 },
    { id: 'UC' + 'b'.repeat(22), name: 'Jake Trinder', handle: '@jaketrinder', platform: 'youtube', paused: 1 },
  ];
  const rows = [
    { id: 1, channel: 'Jake Trinder', video_id: 'AAAAAAAAAAA', title: 'Get clients from YouTube', created_at: '2026-01-02', word_count: 200 },
    { id: 2, channel: 'Jake Trinder', video_id: 'BBBBBBBBBBB', title: 'A buyer framework', created_at: '2026-01-01', word_count: 300 },
    { id: 8, channel: 'Zulu', video_id: 'ZZZZZZZZZZZ', title: 'Unrelated', created_at: '2026-01-03', word_count: 20 },
  ];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body, accessId: req.headers['cf-access-client-id'], accessSecret: req.headers['cf-access-client-secret'] });
    const url = new URL(req.url, 'http://test');
    let data;
    if (url.pathname === '/api/channels' && req.method === 'GET') data = channels;
    else if (url.pathname === '/api/channels' && req.method === 'POST') {
      const { input } = JSON.parse(body);
      data = { id: 'UC' + 'c'.repeat(22), handle: input, name: 'New channel', platform: 'youtube', paused: 0 };
      channels.push(data);
    } else if (url.pathname.startsWith('/api/channels/')) {
      const refresh = url.pathname.endsWith('/refresh');
      const id = decodeURIComponent(url.pathname.split('/').at(refresh ? -2 : -1));
      const channel = channels.find(row => row.id === id);
      if (refresh) {
        if (channel.refreshError) { res.writeHead(400); res.end(JSON.stringify({ success: false, error: 'Resolution failed' })); return; }
        channel.name = 'Resolved ' + id;
        channel.handle = '@resolved';
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, data: channel }));
        return;
      }
      if (req.method === 'PATCH') { channel.paused = Number(JSON.parse(body).paused); data = channel; }
      else { channels.splice(channels.indexOf(channel), 1); data = { deleted: true }; }
    } else if (url.pathname === '/api/transcripts') {
      data = url.searchParams.has('video_id') ? rows.filter(row => row.video_id === url.searchParams.get('video_id')) : rows;
    } else if (/^\/api\/transcripts\/\d+$/.test(url.pathname)) {
      data = rows.find(row => row.id === Number(url.pathname.split('/').at(-1)));
    } else if (url.pathname.endsWith('/content')) {
      const id = url.pathname.split('/')[3];
      res.end(id === '1' ? 'x'.repeat(85001) + ' final-tail-marker' : 'y'.repeat(120));
      return;
    } else if (url.pathname === '/api/search') data = rows.filter(row => row.title.toLowerCase().includes(url.searchParams.get('q').toLowerCase()));
    else if (url.pathname === '/api/queue') data = { queued: true, id: 99 };
    else if (url.pathname === '/api/reports') data = { id: 'abcdef123456' };
    else { res.writeHead(404); res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'yt-dlp'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({entries:[{id:"AAAAAAAAAAA"},{id:"CCCCCCCCCCC"}]}));\n');
  await chmod(path.join(bin, 'yt-dlp'), 0o755);
  await writeFile(path.join(bin, 'hax'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.slice(0,5).join(' ') !== '--provider=codex --model=gpt-6.1-sol --effort=high --no-session -p') process.exit(9);
const prompt = args[5];
const output = prompt.match(/Write ONLY the requested artifact to ([^\\n]+)\\. Use the file tools/)[1];
const files = JSON.parse(prompt.match(/local input files in full: (\\[[^\\n]+?\\])\\./)[1]);
const contents = files.map(file => fs.readFileSync(file, 'utf8'));
fs.appendFileSync(process.env.HAX_LOG, JSON.stringify({output, files, contents}) + '\\n');
if (process.env.HAX_FAIL_KNOWLEDGE && output.endsWith('/knowledge.out')) process.exit(2);
const ids = [...new Set(contents.join('\\n').match(/(?:Transcript ID: |transcript:)(\\d+)/g)?.map(x => x.match(/\\d+/)[0]) || ['1','2'])];
let text = '# Knowledge\\n\\n## Frameworks\\n' + ids.map(id => '- Define buyer goals before planning material. [transcript:' + id + ']').join('\\n');
if (output.endsWith('/report.out') || output.endsWith('/report-paraphrased.out') || output.endsWith('/report-shortened.out')) text = '<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:16px}</style></head><body><main><h1>Clients need relevant evidence</h1><p>2 min read</p><div class="verdict"><b>Address buyer needs.</b></div><h2>Buyer questions guide production</h2><a href="https://chromescribe.yeoux.net/transcript.html?id=1">Get clients from YouTube</a></main></body></html>';
if (process.env.HAX_LONG_REPORT && output.endsWith('/report.out')) text = text.replace('</main>', ' word'.repeat(700) + '</main>');
fs.writeFileSync(output, text);
`);
  await chmod(path.join(bin, 'hax'), 0o755);
  const skill = path.join(dir, '.claude/skills/report-page');
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), 'Bottom line first. Use statement headings and reading time.');
  await writeFile(path.join(skill, 'template.html'), '<main><div class="verdict"></div></main>');
  const env = { ...process.env, HOME: dir, PATH: bin + ':' + process.env.PATH,
    CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '', CHROMESCRIBE_YEO_KEY: '', PYTHONDONTWRITEBYTECODE: '1',
    CHROMESCRIBE_API: `http://127.0.0.1:${server.address().port}`,
    CHROMESCRIBE_LENSES: path.join(dir, 'lenses-repo'), HAX_LOG: path.join(dir, 'hax.log') };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { dir, env, requests, rows, channels, call: (...args) => run('bash', [cli, ...args], env),
    log: async () => (await readFile(env.HAX_LOG, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('Access key comes from the vault reader before a stale env value, env when the vault is empty', async t => {
  const { dir, env, requests } = await setup(t);
  const reader = path.join(dir, 'fake-yeo-key');
  await writeFile(reader, '#!/usr/bin/env bash\n[ "$1" = "Chromescribe Access" ] || exit 1\n[ -n "$VAULT_EMPTY" ] && exit 1\necho "vault-$2"\n');
  await chmod(reader, 0o755);
  const base = { ...env, CF_ACCESS_CLIENT_ID: 'stale-id', CF_ACCESS_CLIENT_SECRET: 'stale-secret', CHROMESCRIBE_YEO_KEY: reader };
  const vault = await run('bash', [cli, 'channels', '--json'], base);
  assert.equal(vault.code, 0, vault.stderr);
  assert.deepEqual([requests.at(-1).accessId, requests.at(-1).accessSecret], ['vault-CF_ACCESS_CLIENT_ID', 'vault-CF_ACCESS_CLIENT_SECRET']);
  const fallback = await run('bash', [cli, 'channels', '--json'], { ...base, VAULT_EMPTY: '1' });
  assert.equal(fallback.code, 0, fallback.stderr);
  assert.deepEqual([requests.at(-1).accessId, requests.at(-1).accessSecret], ['stale-id', 'stale-secret']);
});

test('channels sort by name, preserve JSON, and show paused state', async t => {
  const { call } = await setup(t);
  const json = await call('channels', '--json');
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).map(row => row.name), ['Jake Trinder', 'Zulu']);
  const text = await call('channels');
  assert.match(text.stdout, /Jake Trinder.*paused/);
  assert.match(text.stdout, /Zulu.*active/);
});

test('channel selectors support case-insensitive names, handles, IDs and URLs', async t => {
  const { call, channels } = await setup(t);
  for (const selector of ['JAKE TRINDER', '@JakeTrinder', channels[1].id,
    'https://www.youtube.com/@JakeTrinder/videos', 'https://youtube.com/channel/' + channels[1].id]) {
    const result = await call('list', '--channel', selector, '-n', '1', '--json');
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).map(row => row.id), [1]);
  }
});

test('missing and ambiguous channels fail without writes, malformed arguments fail clearly', async t => {
  const { call, channels, requests } = await setup(t);
  channels.push({ ...channels[0], name: 'Jake Trinder' });
  let result = await call('pause', 'jake trinder');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Ambiguous channel/);
  result = await call('unsubscribe', 'missing');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Channel not found/);
  for (const args of [['list', '-n'], ['list', '-n', 'no'], ['list', '--channel'], ['channels', '--bogus'],
    ['pause'], ['learn', '@x', '--max', '0'], ['learn', '@x', '--max'], ['lens', '@x'], ['lens', '@x', '']]) {
    assert.notEqual((await call(...args)).code, 0, args.join(' '));
  }
  assert.ok(requests.every(req => req.method === 'GET'));
});

test('subscribe, pause, resume and unsubscribe send the expected JSON and encoded ID', async t => {
  const { call, requests } = await setup(t);
  assert.equal((await call('subscribe', '@new')).code, 0);
  for (const action of ['pause', 'resume', 'unsubscribe']) assert.equal((await call(action, '@new')).code, 0);
  const writes = requests.filter(req => req.method !== 'GET');
  assert.deepEqual(writes.map(req => req.method), ['POST', 'PATCH', 'PATCH', 'DELETE']);
  assert.deepEqual(JSON.parse(writes[0].body), { input: '@new' });
  assert.deepEqual(JSON.parse(writes[1].body), { paused: true });
  assert.deepEqual(JSON.parse(writes[2].body), { paused: false });
});

test('existing list/search/get/cat/url/view commands still work and view uses the site', async t => {
  const { call } = await setup(t);
  for (const args of [['list', '--json'], ['search', 'clients', '--json'], ['get', '1', '--json'],
    ['cat', '2'], ['url', 'https://youtu.be/AAAAAAAAAAA', '--json']]) {
    const result = await call(...args);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.trim());
  }
  assert.equal((await call('view', '1')).stdout.trim(), 'https://chromescribe.yeoux.net/transcript.html?id=1');
  const help = (await call('help')).stdout;
  for (const name of ['channels', 'subscribe', 'unsubscribe', 'pause', 'resume', 'learn', 'lens', '--no-queue', '--no-publish']) assert.ok(help.includes(name));
});

test('learn queues only missing uploads, includes every transcript chunk, and incrementally skips known transcripts', async t => {
  const { call, env, requests, log, rows } = await setup(t);
  const first = await call('learn', 'Jake Trinder', '--max', '2');
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /1 transcribed, 1 queued/);
  assert.equal(requests.filter(req => req.url === '/api/queue').length, 1);
  assert.deepEqual(JSON.parse(requests.find(req => req.url === '/api/queue').body), { url: 'https://www.youtube.com/watch?v=CCCCCCCCCCC' });
  const maps = (await log()).filter(entry => /\/map-1-\d+\.out$/.test(entry.output)).sort((a,b) => a.output.localeCompare(b.output));
  assert.equal(maps.length, 3);
  const combined = maps.map(entry => entry.contents[0].split('\n\n').slice(1).join('\n\n')).join('');
  assert.equal(combined, 'x'.repeat(85001) + ' final-tail-marker');
  const lens = path.join(env.CHROMESCRIBE_LENSES, 'lenses/jaketrinder');
  for (const name of ['VIDEOS.md', 'KNOWLEDGE.md', 'SKILL.md', 'notes/1.md', 'notes/2.md']) assert.ok((await readFile(path.join(lens, name), 'utf8')).length);
  assert.match(await readFile(path.join(lens, 'VIDEOS.md'), 'utf8'), /transcript\.html\?id=2/);
  requests.length = 0;
  const count = (await log()).length;
  const second = await call('learn', '@jaketrinder', '--no-queue');
  assert.equal(second.code, 0, second.stderr);
  assert.equal((await log()).length, count);
  assert.ok(!requests.some(req => req.url.endsWith('/content') || req.method === 'POST'));
  rows.push({ ...rows[1], id: 3, video_id: 'DDDDDDDDDDD', title: 'New evidence' });
  const third = await call('learn', '@jaketrinder', '--no-queue');
  assert.equal(third.code, 0, third.stderr);
  assert.deepEqual(requests.filter(req => req.url.endsWith('/content')).map(req => req.url), ['/api/transcript/3/content']);
  const merge = (await log()).findLast(entry => entry.output.endsWith('/knowledge.out'));
  assert.ok(merge.files.some(file => file.endsWith('previous-knowledge.md')));
});

test('learn subscribes unknown channels before fetching uploads', async t => {
  const { call, rows, requests } = await setup(t);
  rows.push({ ...rows[1], id: 3, channel: 'New channel' });
  const result = await call('learn', '@newchannel', '--no-queue');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(requests.find(req => req.method === 'POST').body), { input: '@newchannel' });
  assert.ok(!requests.some(req => req.url === '/api/queue'));
});

test('lens requires learning, then generates local HTML without publishing and can publish to mocked API', async t => {
  const { call, requests, env, log } = await setup(t);
  const missing = await call('lens', 'Jake Trinder', 'clients', '--no-publish');
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /Run chromescribe learn/);
  assert.equal((await call('learn', 'Jake Trinder', '--no-queue')).code, 0);
  const local = await call('lens', 'Jake Trinder', 'how to get clients from YouTube', '--no-publish');
  assert.equal(local.code, 0, local.stderr);
  assert.match(await readFile(local.stdout.trim(), 'utf8'), /1 min read/);
  assert.match(await readFile(local.stdout.trim(), 'utf8'), /https:\/\/chromescribe\.yeoux\.net\/transcript.html\?id=1/);
  assert.ok(!requests.some(req => req.url === '/api/reports'));
  assert.ok(!(await log()).some(entry => /evidence-\d+-\d+\.out$/.test(entry.output)), 'reports should reuse learned per-video notes');
  const published = await call('lens', 'Jake Trinder', 'clients');
  assert.equal(published.code, 0, published.stderr);
  assert.equal(published.stdout.trim(), 'https://chromescribe.yeoux.net/reports/abcdef123456');
  const body = JSON.parse(requests.find(req => req.url === '/api/reports').body);
  assert.equal(body.channel, 'Jake Trinder');
  assert.equal(body.topic, 'clients');
  assert.ok(body.html.startsWith('<!doctype html>'));
  assert.equal((await readdir(path.join(env.CHROMESCRIBE_LENSES, 'reports'))).length, 2);
});

test('Python unit controls prove RSS fallback, exact chunk coverage, and copied-text rejection', async t => {
  const { env } = await setup(t);
  const result = await run('python3', ['-c', `
import importlib.util, io, unittest.mock as m
spec = importlib.util.spec_from_file_location('lenses', ${JSON.stringify(path.join(repo, 'cli/lenses.py'))})
l = importlib.util.module_from_spec(spec); spec.loader.exec_module(l)
text = 'abc xyz ' * 20000 + 'TAIL'
assert ''.join(l.chunks(text)) == text
assert all(len(part) <= l.CHUNK_SIZE for part in l.chunks(text))
assert l.copied_run('one two three four five six seven eight', ['one two three four five six seven eight nine'])
assert not l.copied_run('independently expressed guidance here', ['one two three four five six seven eight nine'])
feed = b'<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>AAAAAAAAAAA</yt:videoId></entry><entry><yt:videoId>BBBBBBBBBBB</yt:videoId></entry></feed>'
with m.patch.object(l.shutil, 'which', return_value=None), m.patch.object(l.urllib.request, 'urlopen', return_value=io.BytesIO(feed)) as fetch:
 assert l.uploads({'id':'UCtest'}, 1) == ['AAAAAAAAAAA']
 assert fetch.call_args.args[0] == 'https://www.youtube.com/feeds/videos.xml?channel_id=UCtest'
legacy = {'id': 'UC' + 'a'*22, 'handle': 'UC' + 'a'*22, 'name':'Jake Trinder', 'platform':'youtube'}
page = ('{"channelId":"UC' + 'z'*22 + '","canonicalBaseUrl":"/@wrong","externalId":"' + legacy['id'] + '","vanityChannelUrl":"https://www.youtube.com/@jaketrinder"}').encode()
with m.patch.object(l.urllib.request, 'urlopen', side_effect=lambda *a, **k: io.BytesIO(page)):
 assert l.resolve([legacy], '@JakeTrinder')['id'] == legacy['id']
 assert l.slug_for(legacy) == 'jaketrinder'
for bad in ['<div class="verdict">1 min read</div><script>alert(1)</script>', '<div>no verdict</div>', '<div class="verdict">1 min read &mdash;</div><a href="https://chromescribe.yeoux.net/transcript.html?id=1">Source</a>']:
 try: l.validate_report(bad, {'1'})
 except ValueError: pass
 else: raise AssertionError('invalid report accepted')
with l.tempfile.TemporaryDirectory() as directory:
 work = l.Path(directory)
 original = work / 'large.md'
 original.write_text(text)
 seen = {}
 def fake_codex(work, label, instruction, inputs):
  seen.update({p.name: p.read_text() for p in inputs if '-input-' in p.name})
  out = work / (label + '.out')
  out.write_text('Condensed independent evidence. [transcript:1]')
  return out
 with m.patch.object(l, 'codex', side_effect=fake_codex):
  l.reduce_notes(work, [original], 'bounded', 'Merge all evidence')
 assert ''.join(seen[name] for name in sorted(seen)) == text
parser = l.ReportParser()
parser.feed('<head><style>hidden words here</style><title>Hidden</title></head><body>Visible words</body>')
assert ' '.join(parser.text) == 'Visible words'
valid = '<div class="verdict">1 min read</div><a href="https://chromescribe.yeoux.net/transcript.html?id=1">Source</a>'
l.validate_report(valid, {'1'})
try: l.validate_report(valid + 'word '*601, {'1'})
except ValueError as err: assert 'reading budget' in str(err)
else: raise AssertionError('overlong report accepted')
print('python controls verified')
`], env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /python controls verified/);
});


test('blocked skill installation prints an exact final ln command without failing learning', async t => {
  const { call, dir, env } = await setup(t);
  await mkdir(path.join(dir, '.claude/skills/lens-jaketrinder'));
  const result = await call('learn', 'Jake Trinder', '--no-queue');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').at(-1), `ln -s ${env.CHROMESCRIBE_LENSES}/lenses/jaketrinder ${dir}/.claude/skills/lens-jaketrinder`);
});

test('failed Codex output does not install a partial lens or leave a lock behind', async t => {
  const { call, dir, env } = await setup(t);
  await writeFile(path.join(dir, 'bin/hax'), '#!/usr/bin/env node\nprocess.exit(2);\n');
  const result = await call('learn', 'Jake Trinder', '--no-queue');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Codex failed/);
  const files = await readdir(path.join(env.CHROMESCRIBE_LENSES, 'lenses/jaketrinder'));
  assert.ok(!files.includes('VIDEOS.md') && !files.includes('KNOWLEDGE.md') && !files.includes('.learn-lock'));
});


test('failed merges resume checksum-matched notes and re-distill only a mismatched source cache', async t => {
  const { call, env, log } = await setup(t);
  env.HAX_FAIL_KNOWLEDGE = '1';
  assert.notEqual((await call('learn', 'Jake Trinder', '--no-queue')).code, 0);
  const maps = entries => entries.filter(entry => /map-\d+-\d+\.out$/.test(entry.output));
  assert.equal(maps(await log()).length, 4);
  assert.notEqual((await call('learn', 'Jake Trinder', '--no-queue')).code, 0);
  assert.equal(maps(await log()).length, 4, 'matching cached notes must not be distilled again');
  await writeFile(path.join(env.CHROMESCRIBE_LENSES, 'lenses/jaketrinder/notes/1.sha256'), 'mismatched');
  delete env.HAX_FAIL_KNOWLEDGE;
  const completed = await call('learn', 'Jake Trinder', '--no-queue');
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(maps(await log()).length, 7);
  assert.equal(maps(await log()).filter(entry => /map-2-/.test(entry.output)).length, 1);
});


test('overlong reports are shortened before installation and publish validation', async t => {
  const { call, env, log } = await setup(t);
  env.HAX_LONG_REPORT = '1';
  assert.equal((await call('learn', 'Jake Trinder', '--no-queue')).code, 0);
  const result = await call('lens', 'Jake Trinder', 'clients', '--no-publish');
  assert.equal(result.code, 0, result.stderr);
  assert.ok((await log()).some(entry => entry.output.endsWith('/report-shortened.out')));
  assert.match(await readFile(result.stdout.trim(), 'utf8'), /1 min read/);
});

test('channels --refresh repairs only broken YouTube rows and prints old -> new metadata', async t => {
  const { call, channels, requests } = await setup(t);
  const missingHandle = { id: 'UC' + 'c'.repeat(22), name: 'Known name', handle: 'UC' + 'c'.repeat(22), platform: 'youtube' };
  const missingName = { id: 'UC' + 'd'.repeat(22), name: 'UC' + 'd'.repeat(22), handle: '@known', platform: 'youtube' };
  channels.push(missingHandle, missingName, { id: 'tiktok:@user', name: 'UC' + 'e'.repeat(22), handle: 'broken', platform: 'tiktok' });
  const result = await call('channels', '--refresh');
  assert.equal(result.code, 0, result.stderr);
  const writes = requests.filter(request => request.method !== 'GET');
  assert.deepEqual(writes.map(request => request.url).sort(), [missingHandle, missingName].map(row => '/api/channels/' + row.id + '/refresh').sort());
  assert.ok(writes.every(request => request.method === 'POST'));
  assert.ok(result.stdout.includes(`Known name (${missingHandle.id}) -> Resolved ${missingHandle.id} (@resolved)`));
  assert.ok(result.stdout.includes(`${missingName.id} (@known) -> Resolved ${missingName.id} (@resolved)`));
  assert.equal(result.stdout.trim().split('\n').length, 2);
  const again = await call('channels', '--refresh');
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, '');
  assert.equal(requests.filter(request => request.method !== 'GET').length, 2);
});

test('channels --refresh continues past failed rows and returns a failing exit code', async t => {
  const { call, channels, requests } = await setup(t);
  channels[0].handle = channels[0].id;
  channels[1].handle = channels[1].id;
  channels[1].refreshError = true;
  const result = await call('channels', '--refresh');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /could not refresh/);
  assert.ok(result.stdout.includes('Zulu (' + channels[0].id + ') -> Resolved'));
  assert.equal(requests.filter(request => request.method === 'POST').length, 2);
});
