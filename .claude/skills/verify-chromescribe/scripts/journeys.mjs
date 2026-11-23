import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const STAMP = Date.now().toString(36);
const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..');

const json = async (j, path, options = {}) => {
  const result = await j.api(path, options);
  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`${options.method || 'GET'} ${path} returned HTTP ${result.status}: ${result.text.slice(0, 300)}`);
  }
  return result.json?.data;
};

const youtubeId = suffix => ('J' + STAMP + suffix).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 11).padEnd(11, '0');

const markdown = (title, extra = '') => `# ${title}

**Source:** https://example.com/${encodeURIComponent(title)}
**Date:** 2026-01-01
**Type:** Article

---

## TL;DR
${extra || `Seed lead line for ${title}.`}

## Summary
**Bottom line:** A short article used by the verification journey.

---

## Full Article

${'The journey drives a real user path and checks the written result. '.repeat(20)}
`;

async function createArticle(j, title) {
  return json(j, '/api/transcribe', {
    method: 'POST',
    body: { url: `https://example.com/${encodeURIComponent(title)}-${STAMP}`, markdown_content: markdown(title) },
  });
}

async function removeTranscript(j, id) {
  if (!id) return;
  await j.api(`/api/transcripts/${id}`, { method: 'DELETE' });
}

function stub(j, name) {
  const dir = join(j.proofDir, 'stub', name);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  return dir;
}

function writeStub(dir, name, body) {
  const path = join(dir, 'bin', name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

function curlStub(dir, log, cases) {
  return writeStub(dir, 'curl', `#!/bin/bash
args="$*"
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -H|-F|-b|-c|-X|-d|-w|--max-time|--proto|--data-urlencode|--form-string|--retry|--connect-timeout) shift 2;;
    *) shift;;
  esac
done
printf '%s\\n' "$args" >> ${JSON.stringify(log)}
body=$(case "$args" in
${cases}
  *) printf '%s' '{"success":true,"data":{}}';;
esac
)
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; printf '200'; else printf '%s' "$body"; fi
`);
}

const REAL_CURL = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim() || '/usr/bin/curl';
  } catch {
    return '/usr/bin/curl';
  }
})();

const YT_DLP_STUB = `#!/bin/bash
file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) file="$2"; shift 2;;
    --print-to-file) printf 'Journey pipeline video\\n' > "$3"; shift 3;;
    *) shift;;
  esac
done
ffmpeg -hide_banner -loglevel error -f lavfi -i sine=frequency=440:duration=10 -c:a aac -b:a 64k -f mp4 -y "\${file//%(ext)s/m4a}"
`;

function jinaBody(title) {
  return `Title: ${title}\n\nMarkdown Content:\n# ${title}\n\n**Author:** Journey\n\n${'The pipeline drives the real scripts against the local app and checks the written result. '.repeat(6)}\n`;
}

function outsideCurl(dir, log, jinaFile) {
  return writeStub(dir, 'curl', `#!/bin/bash
argv=("$@")
target=""
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) target="$arg";;
  esac
done
printf '%s\\n' "$target" >> ${JSON.stringify(log)}
out=""
code=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -w) code="$2"; shift 2;;
    -H|-F|-b|-c|-X|-d|-u|-A|-e|--max-time|--proto|--data-urlencode|--form-string|--retry|--connect-timeout) shift 2;;
    *) shift;;
  esac
done
reply() {
  if [ -n "$out" ]; then cp "$1" "$out"; else cat "$1"; fi
  if [ -n "$code" ]; then printf '200'; fi
}
case "$target" in
  *r.jina.ai*) reply ${JSON.stringify(jinaFile)}; exit 0;;
  *api.fxtwitter.com*) printf '%s' '{"tweet":{"text":"Journey post"}}'; exit 0;;
  *youtube.com/oembed*) printf '%s' '{"title":"Journey pipeline video"}'; exit 0;;
  *api.telegram.org*) printf '%s' '{"ok":true}'; exit 0;;
esac
exec ${JSON.stringify(REAL_CURL)} "\${argv[@]}"
`);
}

function pipelineTools(j, name, scripts) {
  const dir = stub(j, name);
  const bin = join(dir, 'bin');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  copyFileSync(join(ROOT, 'lib', 'cf_access.sh'), join(dir, 'lib', 'cf_access.sh'));
  copyFileSync(join(ROOT, 'fxtwitter_article.py'), join(dir, 'fxtwitter_article.py'));
  copyFileSync(join(ROOT, 'upload_article.py'), join(dir, 'upload_article.py'));
  copyFileSync(join(ROOT, 'cf_access.py'), join(dir, 'cf_access.py'));
  for (const script of scripts) copyFileSync(join(ROOT, script), join(dir, script));
  writeStub(dir, 'yt-dlp', YT_DLP_STUB);
  const log = join(dir, 'curl.log');
  const jinaFile = join(dir, 'jina.body');
  writeFileSync(log, '');
  outsideCurl(dir, log, jinaFile);
  return {
    dir,
    log,
    jina: title => writeFileSync(jinaFile, jinaBody(title)),
    env: {
      PATH: bin + ':' + process.env.PATH,
      HOME: join(dir, 'home'),
      CHROMESCRIBE_API: j.base,
      CF_ACCESS_CLIENT_ID: 'verify-id',
      CF_ACCESS_CLIENT_SECRET: 'verify-secret',
      CHROMESCRIBE_ENV_FILE: join(dir, 'missing.env'),
      CHROMESCRIBE_NO_OPEN: '1',
    },
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
  };
}

const devLogMark = j => (existsSync(join(j.stateDir, 'dev.log')) ? readFileSync(join(j.stateDir, 'dev.log'), 'utf8').length : 0);

const devLogSince = (j, mark) => {
  const path = join(j.stateDir, 'dev.log');
  return existsSync(path) ? readFileSync(path, 'utf8').slice(mark) : '';
};

function outsideOnly(j, urls) {
  return urls.every(url => url.startsWith(j.base) || /r\.jina\.ai|api\.fxtwitter\.com|youtube\.com\/oembed/.test(url));
}

function cliEnv(j, extra = {}) {
  return {
    CHROMESCRIBE_API: j.base,
    CF_ACCESS_CLIENT_ID: 'verify-id',
    CF_ACCESS_CLIENT_SECRET: 'verify-secret',
    CHROMESCRIBE_YEO_KEY: '',
    ...extra,
  };
}

const cli = (j, args, extra) => j.run('bash', [join(ROOT, 'cli', 'chromescribe'), ...args], { env: cliEnv(j, extra) });

async function retryUntil(playwrightLocator, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await playwrightLocator.count()) return true;
    await new Promise(done => setTimeout(done, 250));
  }
  return false;
}

async function home(j) {
  const title = `Journey scratch card ${STAMP}`;
  let created = null;
  let page = null;
  try {
    created = await createArticle(j, title);
    j.check('scratch transcript written through the API', created?.id > 0, `id ${created?.id}`);
    page = await j.open('/');
    await page.waitForSelector('#videoGrid .card');
    await page.waitForFunction(() => {
      const stats = document.querySelector('#stats');
      return stats && /\d/.test(stats.textContent);
    });
    const total = (await j.api('/api/transcripts?limit=1')).json.total;
    const stats = (await page.textContent('#stats')).trim();
    j.check('home reports the library size', Number(stats.replace(/[^0-9]/g, '')) === total, `${stats} vs API total ${total}`);
    const categories = (await json(j, '/api/categories')).length;
    const chips = await page.locator('#categoryChips .category-chip').count();
    j.check('category chips come from the API', chips === categories + 5, `${chips} chips for ${categories} categories`);
    const scratch = page.locator('#videoGrid .card').filter({ hasText: title }).first();
    j.check('new transcript appears first on home', await scratch.count() === 1);
    await j.shot('home-phone');

    await page.locator('#mobileSearchBtn').click();
    await page.fill('#searchInput', title);
    const onlyScratch = await retryUntil(page.locator('#videoGrid .card').filter({ hasText: title }));
    const searchCount = await page.locator('#videoGrid .card').count();
    j.check('search narrows the grid to the match', onlyScratch && searchCount === 1, `${searchCount} card(s) for the query`);
    await page.fill('#searchInput', '');
    await page.locator('#mobileSearchBtn').click();

    const pill = page.locator('#videoGrid .card .category-pill').first();
    const category = (await pill.textContent()).trim();
    if (category) {
      await page.locator('#categoryChips .category-chip').filter({ hasText: category }).first().click();
      await page.waitForFunction(name => {
        const cards = [...document.querySelectorAll('#videoGrid .card')];
        return cards.length > 0 && cards.every(card => card.querySelector('.category-pill')?.textContent.trim() === name);
      }, category);
      const filtered = (await page.textContent('#stats')).trim();
      j.check('category chip filters the list', filtered.includes(' of '), filtered);
      await page.locator('#categoryChips .category-chip').filter({ hasText: /^All/ }).first().click();
    } else {
      j.check('category chip filters the list', false, 'the first card had no category pill');
    }

    const channel = (await page.locator('#videoGrid .card .card-channel-link').first().textContent()).trim();
    await page.goto(j.url('/?channel=' + encodeURIComponent(channel)), { waitUntil: 'networkidle' });
    await page.waitForFunction(() => /\d/.test(document.querySelector('#stats')?.textContent || ''));
    const channelStats = (await page.textContent('#stats')).trim();
    j.check('channel link filters home', channelStats.includes(' of '), `${channel}: ${channelStats}`);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(j.url('/'), { waitUntil: 'networkidle' });
    const card = page.locator('#videoGrid .card').filter({ hasText: title }).first();
    await card.locator('details summary').click();
    page.once('dialog', dialog => dialog.accept());
    await card.locator('button.js-delete').click();
    await page.waitForFunction(value => document.querySelector('#toastMessage')?.textContent === value, 'Deleted');
    await page.waitForFunction(value => ![...document.querySelectorAll('#videoGrid .card')].some(card => card.textContent.includes(value)), title);
    j.check('delete removes the card from the grid', true, 'card gone after the confirm dialog');
    j.check('delete is a real API call', j.apiCalls.some(call => call.startsWith(`200 DELETE /api/transcripts/${created.id}`)), `API calls: ${j.apiCalls.join(', ')}`);
    const gone = await j.api(`/api/transcripts/${created.id}`);
    j.check('deleted transcript is gone from D1', gone.status === 404, `HTTP ${gone.status}`);
    created = null;
  } finally {
    if (page) await j.shot('home-after-delete').catch(() => {});
    if (created?.id) await removeTranscript(j, created.id);
  }
}

async function video(j) {
  const first = (await json(j, '/api/transcripts?limit=1'))[0];
  const content = await j.api(`/api/transcript/${first.id}/content`);
  j.check('transcript body reads from local R2', content.status === 200 && content.text.length > 1000, `HTTP ${content.status}, ${content.text.length} bytes`);
  const tldr = content.text.split('## TL;DR')[1].split('---')[0].trim();
  const page = await j.open(`/transcript.html?id=${first.id}`);
  await page.waitForFunction(() => document.querySelector('#title')?.textContent.trim());
  j.check('title matches the API row', (await page.textContent('#title')).trim() === first.title, first.title);
  const summary = (await page.textContent('#mobileSummary')).trim();
  j.check('Summary tab renders the TL;DR', summary.includes(tldr.slice(0, 40)), summary.slice(0, 80));
  await j.shot('video-phone-summary');

  await page.locator('.mobile-tab[data-tab="transcript"]').click();
  await page.waitForFunction(() => document.querySelector('#transcriptSide')?.dataset.tab === 'transcript');
  const body = await page.textContent('#content');
  j.check('Transcript tab shows the full text', body.includes('point 1') && body.length > 1000, `${body.length} chars`);
  const counter = (await page.textContent('#navCounter')).trim();
  j.check('neighbour navigation shows a position', /^\d+ \/ \d+$/.test(counter), counter);
  j.check('older neighbour is reachable', !(await page.locator('.nav-next').first().isDisabled()));
  j.check('newer neighbour is disabled for the newest row', await page.locator('.nav-prev').first().isDisabled());
  j.check('video page API calls succeeded', j.apiCalls.some(call => call.startsWith(`200 GET /api/transcripts/${first.id}`)) && j.apiCalls.some(call => call.startsWith(`200 GET /api/transcript/${first.id}/content`)), j.apiCalls.join(', '));
  await j.shot('video-phone-transcript');

  await page.locator('#menuToggle').click();
  j.check('More menu opens', await page.locator('#pageHeader').evaluate(node => node.classList.contains('menu-open')));
  j.check('More panel links to the queue', await page.locator('#morePanel a[href="/queue.html"]').isVisible());
  const moreText = (await page.locator('#morePanel').textContent()).toLowerCase();
  j.check('More panel offers Read aloud, Download MD and Summarize', moreText.includes('read aloud') && moreText.includes('download md') && moreText.includes('summarize'), moreText.replace(/\s+/g, ' ').slice(0, 120));

  await page.locator('#morePanel button').filter({ hasText: 'Keyboard shortcuts' }).click();
  await page.waitForFunction(() => document.querySelector('#shortcuts')?.open);
  j.check('shortcuts dialog lists the key map', (await page.textContent('#shortcuts')).includes('Next video'));
  await page.locator('#shortcuts .shortcuts-close').click();
  await page.keyboard.press('Control+k');
  await page.waitForFunction(() => document.querySelector('#cmdk')?.open);
  j.check('Ctrl+K opens the command menu', true, 'cmdk open');
  await page.fill('#cmdkInput', 'download');
  j.check('command menu filters its commands', await page.locator('#cmdkList li').count() === 1, await page.textContent('#cmdkList'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#cmdk')?.open);
  j.check('Escape closes the command menu', true, 'cmdk closed');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(j.url(`/transcript.html?id=${first.id}`), { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#title')?.textContent.trim());
  j.check('desktop keeps the Summary and Transcript tabs', await page.locator('#mobileTabs').isVisible());
  await page.locator('.mobile-tab[data-tab="transcript"]').click();
  j.check('desktop shows the transcript on demand', await page.locator('#content').isVisible());
  await j.shot('video-desktop');

  await page.goto(j.url('/transcript.html'), { waitUntil: 'networkidle' });
  const error = await page.textContent('#content');
  j.check('missing id shows a clear error', error.includes('No transcript ID provided'), error.trim().slice(0, 80));
}

const FAKE_AI_LOG = '/__verify/ai-calls';
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const ANALYSIS_MODEL = '@cf/google/gemma-4-26b-a4b-it';

async function fakeAiCalls(j) {
  const result = await j.api(FAKE_AI_LOG);
  if (result.status !== 200 || !Array.isArray(result.json?.calls)) {
    throw new Error(`GET ${FAKE_AI_LOG} returned HTTP ${result.status}: ${result.text.slice(0, 200)}. The instance is not running the fake AI entry; run cs-verify doctor.`);
  }
  return result.json.calls;
}

async function uploadAudio(j, title) {
  const audio = Buffer.from(('ID3 local verification audio payload for ' + title + ' ').repeat(64));
  const form = new FormData();
  form.append('audio', new Blob([audio], { type: 'audio/mpeg' }), 'journey-audio.mp3');
  form.append('title', title);
  const response = await fetch(j.base + '/api/transcribe', { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, text, body, bytes: audio.length };
}

async function addVideo(j) {
  await j.api(FAKE_AI_LOG, { method: 'DELETE' });
  let created = null;
  let page = null;
  try {
    page = await j.open('/');
    await page.locator('#mobileMenuBtn').click();
    await page.locator('#mobileMenu button').filter({ hasText: 'Add Video' }).click();
    await page.waitForSelector('#addModal:not(.hidden)');
    j.check('Add opens the video form', await page.locator('#addForm').isVisible());
    await page.fill('#videoUrl', 'https://www.youtube.com/watch?v=JRNYADD0001');
    await page.fill('#videoTitle', 'Journey added video');
    await page.fill('#srtContent', 'Journey pasted transcript text.');
    const answered = page.waitForResponse(response => response.url().includes('/api/transcribe') && response.request().method() === 'POST');
    await page.locator('#addForm button[type="submit"]').click();
    const response = await answered;
    const body = await response.json();
    await page.waitForFunction(() => document.querySelector('#toastMessage')?.textContent === 'Added!');
    j.check('Add posts the form to the real API', response.status() === 200 && j.apiCalls.some(call => call === '200 POST /api/transcribe'), j.apiCalls.join(', '));
    j.check('the real handler answers the form', (body?.data?.instructions?.step1 || '').includes('yt-dlp'), JSON.stringify(body?.data).slice(0, 200));
    j.check('Add confirms success and closes the form', await page.locator('#addModal').evaluate(node => node.classList.contains('hidden')));
    j.check('the form path asks no AI', (await fakeAiCalls(j)).length === 0);
    await j.shot('add-video-form');

    const title = `Journey audio ${STAMP}`;
    const uploaded = await uploadAudio(j, title);
    created = uploaded.body?.data;
    j.check('the audio upload runs the real transcribe handler', uploaded.status === 201 && uploaded.body?.success === true && created?.id > 0, `HTTP ${uploaded.status} ${uploaded.text.slice(0, 200)}`);
    const calls = await fakeAiCalls(j);
    const whisper = calls.filter(call => call.model === WHISPER_MODEL);
    const gemma = calls.filter(call => call.model === ANALYSIS_MODEL);
    j.check('the fake AI was asked to transcribe the upload', whisper.length === 1 && whisper[0].input_size === uploaded.bytes && whisper[0].input_unit === 'audio_bytes', `${JSON.stringify(whisper)} for ${uploaded.bytes} bytes`);
    j.check('the fake AI was asked to summarize and classify', gemma.length === 2 && new Set(gemma.map(call => call.task)).size === 2, JSON.stringify(gemma));
    j.check('the handler stored the fake summary and category', created?.summarized === true && created?.classified === true && created?.category === 'Journey Verification', JSON.stringify({ summarized: created?.summarized, classified: created?.classified, category: created?.category }));
    const proofLog = join(j.proofDir, 'ai-calls.json');
    writeFileSync(proofLog, JSON.stringify(calls, null, 2));
    j.proof.push(proofLog);

    const row = await j.api(`/api/transcripts/${created.id}`);
    j.check('the new transcript row is in the API', row.status === 200 && row.json?.data?.title === title, `HTTP ${row.status} ${row.text.slice(0, 120)}`);
    const stored = j.d1(`SELECT title, category, word_count FROM transcripts WHERE id = ${Number(created.id)}`)[0];
    j.check('the new transcript row is in D1', stored?.title === title && stored?.category === 'Journey Verification' && stored?.word_count > 0, JSON.stringify(stored));
    const content = await j.api(`/api/transcript/${created.id}/content`);
    j.check('the stored markdown carries the fake summary', content.status === 200 && content.text.includes('## TL;DR') && content.text.includes('local verification fake'), `HTTP ${content.status} ${content.text.length} bytes`);

    await page.goto(j.url('/'), { waitUntil: 'networkidle' });
    const card = page.locator('#videoGrid .card').filter({ hasText: title }).first();
    j.check('the new transcript reaches the home list', await retryUntil(card), title);
    await j.shot('add-video-home');
  } finally {
    if (created?.id) await removeTranscript(j, created.id);
    await j.api(FAKE_AI_LOG, { method: 'DELETE' }).catch(() => {});
  }
}

async function queue(j) {
  const one = youtubeId('A');
  const two = youtubeId('B');
  const created = [];
  try {
    const first = await json(j, '/api/queue', { method: 'POST', body: { url: `https://www.youtube.com/watch?v=${one}` } });
    created.push(first.id);
    j.check('share API queues a YouTube link', first.queued === true && first.platform === 'youtube', JSON.stringify(first));
    const second = await json(j, '/api/queue', { method: 'POST', body: { url: `https://www.youtube.com/watch?v=${two}` } });
    created.push(second.id);
    const failed = await json(j, `/api/queue/${second.id}`, { method: 'PUT', body: { status: 'failed', error: 'Journey failure reason' } });
    j.check('queue row can fail with a reason', failed.status === 'failed', failed.error);

    const page = await j.open('/queue.html');
    await page.waitForFunction(() => /queue entries/.test(document.querySelector('#count')?.textContent || ''));
    const all = await json(j, '/api/queue/all?limit=200');
    const shown = Number((await page.textContent('#count')).replace(/[^0-9]/g, ''));
    j.check('queue page lists every row from the API', shown === all.length, `${shown} shown, ${all.length} in the API`);
    j.check('waiting column shows the new link', (await page.textContent('#pending')).includes(one));
    j.check('waiting row says where it runs', (await page.textContent('#pending')).includes('runs on the server'));
    j.check('failed column shows the failure reason', (await page.textContent('#failed')).includes('Journey failure reason'));
    await j.shot('queue-phone');

    await page.locator(`#failed button[data-action="retry"][data-id="${second.id}"]`).click();
    await page.waitForFunction(value => document.querySelector('#pending')?.textContent.includes(value), two);
    j.check('Retry moves the row back to Waiting', true, 'row left Failed and appeared in Waiting');
    const row = (await json(j, '/api/queue/all?limit=200')).find(item => item.id === second.id);
    j.check('Retry wrote pending to D1', row?.status === 'pending', row?.status);
    await j.shot('queue-after-retry');

    await j.api(`/api/queue/${first.id}`, { method: 'DELETE' });
    await j.api(`/api/queue/${second.id}`, { method: 'DELETE' });
    created.length = 0;
  } finally {
    for (const id of created) await j.api(`/api/queue/${id}`, { method: 'DELETE' }).catch(() => {});
  }
}

async function subscriptions(j) {
  const handle = `journey${STAMP}`.toLowerCase();
  let id = null;
  try {
    const created = await json(j, '/api/channels', { method: 'POST', body: { input: `https://www.tiktok.com/@${handle}` } });
    id = created.id;
    j.check('subscribe adds a channel', id === `tiktok:@${handle}`, id);
    const page = await j.open('/subscriptions.html');
    await page.waitForFunction(() => /subscriptions/.test(document.querySelector('#count')?.textContent || ''));
    const channels = await json(j, '/api/channels');
    const count = Number((await page.textContent('#count')).replace(/[^0-9]/g, ''));
    j.check('subscription count matches the API', count === channels.length, `${count} shown, ${channels.length} in the API`);
    const row = page.locator('.channel-row').filter({ hasText: `@${handle}` }).first();
    j.check('new subscription appears in the list', await row.count() === 1);
    await page.fill('#filter', handle);
    await page.waitForFunction(value => (document.querySelector('#count')?.textContent || '').startsWith('1 of'), handle);
    j.check('filter narrows the list and reports the slice', (await page.textContent('#count')).startsWith('1 of '), await page.textContent('#count'));
    await page.fill('#filter', '');
    await j.shot('subscriptions-phone');

    await row.locator('button[data-action="pause"]').click();
    await page.waitForFunction(value => {
      const row = [...document.querySelectorAll('.channel-row')].find(item => item.textContent.includes(value));
      return row && row.textContent.includes('Paused');
    }, `@${handle}`);
    const paused = (await json(j, '/api/channels')).find(channel => channel.id === id);
    j.check('Pause writes paused to D1', paused?.paused === 1, String(paused?.paused));
    await row.locator('button[data-action="pause"]').click();
    await page.waitForFunction(value => {
      const row = [...document.querySelectorAll('.channel-row')].find(item => item.textContent.includes(value));
      return row && row.textContent.includes('Active');
    }, `@${handle}`);
    const resumed = (await json(j, '/api/channels')).find(channel => channel.id === id);
    j.check('Resume clears paused', resumed?.paused === 0, String(resumed?.paused));

    page.once('dialog', dialog => dialog.accept());
    await row.locator('button[data-action="remove"]').click();
    await page.waitForFunction(value => ![...document.querySelectorAll('.channel-row')].some(item => item.textContent.includes(value)), `@${handle}`);
    j.check('Remove takes the channel out of the list', true, handle);
    j.check('Remove deletes the D1 row', !(await json(j, '/api/channels')).some(channel => channel.id === id));
    await j.shot('subscriptions-after-remove');
    id = null;
  } finally {
    if (id) await j.api(`/api/channels/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }
}

async function reports(j) {
  const title = `Journey report ${STAMP}`;
  const html = `<!doctype html><html><head><title>${title}</title></head><body><h1>${title} body</h1></body></html>`;
  let id = null;
  try {
    const created = await json(j, '/api/reports', { method: 'POST', body: { title, channel: 'Journey Lens Channel', topic: 'verification', html } });
    id = created.id;
    j.check('report publish returns a 12 hex id', /^[a-f0-9]{12}$/.test(id), id);
    const page = await j.open('/reports.html');
    await page.waitForFunction(() => /reports/.test(document.querySelector('#count')?.textContent || ''));
    const link = page.locator(`a[href="/reports/${id}"]`);
    j.check('reports page lists the new report', await retryUntil(link), title);
    await j.shot('reports-list');
    await link.click();
    await page.waitForLoadState('networkidle');
    j.check('public report page opens', page.url().endsWith(`/reports/${id}`), page.url());
    j.check('public report shows its own HTML', (await page.textContent('h1')).trim() === `${title} body`, await page.textContent('h1'));
    await j.shot('public-report');
    await j.api(`/api/reports/${id}`, { method: 'DELETE' });
    const gone = await j.api(`/reports/${id}`);
    j.check('deleted report page is gone', gone.status === 404, `HTTP ${gone.status}`);
    j.check('deleted report leaves the API list', !(await json(j, '/api/reports')).some(report => report.id === id));
    id = null;
  } finally {
    if (id) await j.api(`/api/reports/${id}`, { method: 'DELETE' }).catch(() => {});
  }
}

async function stats(j) {
  const total = (await j.api('/api/transcripts?limit=1')).json.total;
  const categories = (await json(j, '/api/categories')).length;
  const page = await j.open('/stats.html');
  await page.waitForFunction(() => /\d/.test(document.querySelector('#transcript-count')?.textContent || ''));
  const count = Number((await page.textContent('#transcript-count')).replace(/[^0-9]/g, ''));
  j.check('stats shows the transcript count', count === total, `${count} shown, ${total} in the API`);
  const rows = await page.locator('#category-groups tr').count();
  j.check('stats lists every category', rows === categories, `${rows} rows for ${categories} categories`);
  j.check('stats groups R2 objects by prefix', (await page.textContent('#r2-groups')).includes('content/'));
  j.check('stats shows a storage total', /\d/.test(await page.textContent('#storage-total')));
  j.check('stats shows no media files', (await page.textContent('#media-banner')).toLowerCase().includes('no video or audio'));
  await j.shot('stats-desktop');
}

async function settings(j) {
  const page = await j.open('/settings.html');
  await page.waitForSelector('h1');
  j.check('settings page renders', (await page.textContent('h1')).trim() === 'Settings');
  const body = await page.textContent('body');
  j.check('settings documents cat', body.includes('chromescribe cat 141'));
  j.check('settings documents the transcripts API', body.includes('GET /api/transcripts'));
  j.check('settings documents the search and update APIs', body.includes('GET /api/search') && body.includes('PUT /api/transcripts'));
  j.check('settings documents the env overrides', body.includes('CHROMESCRIBE_API'));
  await page.locator('button.copy').first().click();
  await page.waitForFunction(() => document.querySelector('button.copy')?.textContent === 'copied');
  j.check('copy button copies a recipe', true, 'button read copied');
  await j.shot('settings-desktop');
}

async function theme(j) {
  const page = await j.open('/');
  await page.waitForSelector('#mobileMenuBtn');
  const state = () => page.evaluate(() => ({
    choice: document.documentElement.getAttribute('data-theme-choice'),
    theme: document.documentElement.getAttribute('data-theme'),
    stored: localStorage.getItem('cs-theme'),
  }));
  let current = await state();
  j.check('theme starts on the system choice', current.choice === 'system', JSON.stringify(current));
  j.check('system resolves to a concrete theme', ['dark', 'light'].includes(current.theme), current.theme);
  await page.locator('#mobileMenuBtn').click();
  await page.locator('#mobileMenu button').filter({ hasText: 'Theme' }).click();
  current = await state();
  j.check('theme cycles system to dark', current.choice === 'dark' && current.theme === 'dark', JSON.stringify(current));
  j.check('theme choice is stored', current.stored === 'dark', current.stored);
  await page.locator('#mobileMenuBtn').click();
  await j.shot('theme-home-dark');
  await page.reload({ waitUntil: 'domcontentloaded' });
  current = await state();
  j.check('theme choice survives a reload', current.choice === 'dark' && current.theme === 'dark' && current.stored === 'dark', JSON.stringify(current));
  const newest = (await j.api('/api/transcripts?limit=1')).json.data[0];
  await page.goto(j.url(`/transcript.html?id=${newest.id}`), { waitUntil: 'networkidle' });
  current = await state();
  j.check('video page reads the saved theme', current.choice === 'dark' && current.theme === 'dark', JSON.stringify(current));
  await page.locator('#menuToggle').click();
  const toggle = page.locator('#themeToggle');
  j.check('video page offers the theme control', await toggle.isVisible(), 'More panel theme button');
  await toggle.click();
  current = await state();
  j.check('video page cycles dark to light', current.choice === 'light' && current.theme === 'light' && current.stored === 'light', JSON.stringify(current));
  await j.shot('theme-video-light');
  await toggle.click();
  current = await state();
  j.check('video page cycles light back to system', current.choice === 'system' && ['dark', 'light'].includes(current.theme) && current.stored === 'system', JSON.stringify(current));
}

async function cliQuery(j) {
  const list = await cli(j, ['list', '-n', '3', '--json']);
  j.check('list exits 0', list.code === 0, list.stderr.trim());
  const rows = JSON.parse(list.stdout || '[]');
  const api = await json(j, '/api/transcripts?limit=3');
  j.check('list prints the newest rows', rows.length === 3 && rows[0].id === api[0].id, `${rows.map(row => row.id).join(',')}`);
  const target = rows[0];
  const search = await cli(j, ['search', target.title.split(' ')[0], '--json']);
  j.check('search returns a match', search.code === 0 && JSON.parse(search.stdout || '[]').some(row => row.id === target.id), target.title);
  const get = await cli(j, ['get', String(target.id), '--json']);
  j.check('get returns the row', get.code === 0 && JSON.parse(get.stdout).id === target.id);
  const cat = await cli(j, ['cat', String(target.id)]);
  j.check('cat prints the markdown', cat.code === 0 && cat.stdout.length > 1000 && cat.stdout.includes(target.video_id), `${cat.stdout.length} bytes`);
  const catLink = await cli(j, ['cat', `https://chromescribe.yeoux.net/transcript.html?id=${target.id}`]);
  j.check('cat accepts a pasted dashboard link', catLink.code === 0 && catLink.stdout.includes(target.video_id), catLink.stderr.trim() || `${catLink.stdout.length} bytes`);
  const catBad = await cli(j, ['cat', 'https://chromescribe.yeoux.net/']);
  j.check('cat refuses a link with no id', catBad.code !== 0 && catBad.stderr.includes('no id='), catBad.stderr.trim().slice(0, 80));
  const url = await cli(j, ['url', `https://www.youtube.com/watch?v=${target.video_id}`, '--json']);
  j.check('url finds the row by source link', url.code === 0 && JSON.parse(url.stdout || '[]')[0]?.id === target.id);
  const view = await cli(j, ['view', String(target.id)]);
  j.check('view prints the dashboard link', view.stdout.trim() === `https://chromescribe.yeoux.net/transcript.html?id=${target.id}`, view.stdout.trim());
  const missing = await cli(j, ['get', '999999']);
  j.check('missing row fails with a clear error', missing.code !== 0 && missing.stderr.includes('error:'), missing.stderr.trim().slice(0, 80));
  const help = await cli(j, ['--help']);
  j.check('help lists every command', ['list', 'cat', 'channels', 'subscribe', 'learn', 'lens'].every(name => help.stdout.includes(name)));
}

async function cliChannels(j) {
  const handle = `journeyc${STAMP}`.toLowerCase();
  let id = null;
  try {
    const channels = await cli(j, ['channels', '--json']);
    const api = await json(j, '/api/channels');
    j.check('channels prints every subscription', channels.code === 0 && JSON.parse(channels.stdout).length === api.length, `${JSON.parse(channels.stdout || '[]').length} vs ${api.length}`);
    const added = await cli(j, ['subscribe', `https://www.tiktok.com/@${handle}`]);
    id = `tiktok:@${handle}`;
    j.check('subscribe exits 0', added.code === 0, added.stderr.trim());
    j.check('subscribe creates the channel', (await json(j, '/api/channels')).some(channel => channel.id === id));
    const paused = await cli(j, ['pause', handle]);
    j.check('pause by name exits 0', paused.code === 0, paused.stderr.trim());
    j.check('pause writes paused to D1', (await json(j, '/api/channels')).find(channel => channel.id === id)?.paused === 1);
    const resumed = await cli(j, ['resume', handle.toUpperCase()]);
    j.check('resume accepts a case-insensitive name', resumed.code === 0, resumed.stderr.trim());
    j.check('resume clears paused', (await json(j, '/api/channels')).find(channel => channel.id === id)?.paused === 0);
    const removed = await cli(j, ['unsubscribe', handle]);
    j.check('unsubscribe exits 0', removed.code === 0, removed.stderr.trim());
    j.check('unsubscribe deletes the channel', !(await json(j, '/api/channels')).some(channel => channel.id === id));
    id = null;
    const missing = await cli(j, ['pause', 'definitely-not-a-channel']);
    j.check('unknown channel fails without a write', missing.code !== 0 && missing.stderr.includes('Channel not found'), missing.stderr.trim().slice(0, 80));
  } finally {
    if (id) await j.api(`/api/channels/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }
}

function homeFor(dir) {
  const home = join(dir, 'home');
  mkdirSync(join(home, '.claude', 'skills', 'report-page'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'report-page', 'SKILL.md'), 'Bottom line first. Use statement headings and reading time.');
  writeFileSync(join(home, '.claude', 'skills', 'report-page', 'template.html'), '<main><div class="verdict"></div></main>');
  return home;
}

function learnStubs(j, name, existingId, transcriptIds) {
  const dir = stub(j, name);
  writeStub(dir, 'yt-dlp', `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({entries:[{id:${JSON.stringify(existingId)}},{id:"NEWUPLOAD01"}]}));\n`);
  writeStub(dir, 'hax', `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = args[args.length - 1] || '';
const target = (prompt.match(/Write ONLY the requested artifact to (\\S+)\\./) || [])[1];
if (!target) process.exit(9);
const listed = (prompt.match(/local input files in full: (\\[[^\\n]+?\\])/) || [])[1];
const files = listed ? JSON.parse(listed) : [];
const contents = files.map(file => fs.readFileSync(file, 'utf8')).join('\\n');
const ids = [...new Set((contents.match(/(?:Transcript ID: |transcript:)(\\d+)/g) || []).map(value => value.match(/\\d+/)[0]))];
const first = ids[0] || ${JSON.stringify(String(transcriptIds[0]))};
if (target.endsWith('report.out')) {
  const html = '<!doctype html><html><head><title>Journey lens report</title></head><body><main><h1>Buyer questions guide production</h1><p>2 min read</p><div class="verdict"><b>Ask buyers before you build.</b></div><h2>Start with the evidence</h2><a href="https://chromescribe.yeoux.net/transcript.html?id=' + first + '">Journey lens source one</a></main></body></html>';
  fs.writeFileSync(target, html);
} else {
  fs.writeFileSync(target, '# Notes\\n\\n- Define buyer goals before planning. [transcript:' + first + ']\\n');
}
`);
  const home = homeFor(dir);
  return { dir, home, env: { HOME: home, PATH: join(dir, 'bin') + ':' + process.env.PATH, CHROMESCRIBE_LENSES: join(dir, 'lenses') } };
}

async function cliLearn(j) {
  const channels = await json(j, '/api/channels');
  const channel = channels.find(item => item.name === 'Journey Lens Channel');
  const rows = (await json(j, '/api/transcripts')).filter(row => row.channel === 'Journey Lens Channel');
  j.check('the seeded lens channel exists', Boolean(channel) && rows.length >= 2, `${rows.length} transcripts`);
  const existing = rows[0];
  const stubs = learnStubs(j, 'learn', existing.video_id, rows.map(row => row.id));
  const result = await cli(j, ['learn', channel.name, '--max', '2', '--no-queue'], stubs.env);
  j.check('learn exits 0', result.code === 0, result.stderr.trim().slice(0, 200));
  j.check('learn reports what it transcribed', /\d+ transcribed, 0 queued/.test(result.stdout), result.stdout.trim().split('\n')[0]);
  const lens = join(stubs.dir, 'lenses', 'lenses', 'journeylenschannel');
  const knowledge = existsSync(join(lens, 'KNOWLEDGE.md')) ? readFileSync(join(lens, 'KNOWLEDGE.md'), 'utf8') : '';
  const index = existsSync(join(lens, 'VIDEOS.md')) ? readFileSync(join(lens, 'VIDEOS.md'), 'utf8') : '';
  j.check('learn writes cited knowledge', knowledge.includes('[transcript:'), knowledge.slice(0, 120));
  j.check('learn indexes the source transcripts', rows.every(row => index.includes(`transcript.html?id=${row.id}`)), `${index.length} bytes`);
  j.check('learn installs the lens skill', existsSync(join(stubs.home, '.claude', 'skills', 'lens-journeylenschannel', 'SKILL.md')));
}

async function cliLens(j) {
  const channels = await json(j, '/api/channels');
  const channel = channels.find(item => item.name === 'Journey Lens Channel');
  const rows = (await json(j, '/api/transcripts')).filter(row => row.channel === 'Journey Lens Channel');
  const stubs = learnStubs(j, 'lens', rows[0].video_id, rows.map(row => row.id));
  const learned = await cli(j, ['learn', channel.name, '--max', '2', '--no-queue'], stubs.env);
  j.check('lens precondition learn succeeds', learned.code === 0, learned.stderr.trim().slice(0, 200));
  const local = await cli(j, ['lens', channel.name, 'buyer questions', '--no-publish'], stubs.env);
  j.check('lens --no-publish exits 0', local.code === 0, local.stderr.trim().slice(0, 200));
  const path = local.stdout.trim().split('\n').at(-1);
  j.check('lens prints a local HTML path', path?.endsWith('.html') && existsSync(path), path);
  const html = path && existsSync(path) ? readFileSync(path, 'utf8') : '';
  j.check('lens HTML carries a cited verdict', html.includes('class="verdict"') && html.includes('transcript.html?id='), html.slice(0, 120));
  const published = await cli(j, ['lens', channel.name, 'buyer questions'], stubs.env);
  j.check('lens publish exits 0', published.code === 0, published.stderr.trim().slice(0, 200));
  const url = published.stdout.trim().split('\n').at(-1);
  const match = /\/reports\/([a-f0-9]{12})$/.exec(url || '');
  j.check('lens print a public report link', Boolean(match), url);
  if (match) {
    j.check('published report is in the API', (await json(j, '/api/reports')).some(report => report.id === match[1]));
    await j.api(`/api/reports/${match[1]}`, { method: 'DELETE' });
  }
}

async function processPipeline(j) {
  const tools = pipelineTools(j, 'process', ['process.sh']);
  const articleUrl = `https://example.com/journey-process-${STAMP}`;
  const articleTitle = `Journey process article ${STAMP}`;
  const videoId = youtubeId('PROC');
  let articleId = 0;
  let audioId = 0;
  try {
    tools.jina(articleTitle);
    const articleMark = devLogMark(j);
    const article = j.run('bash', [join(tools.dir, 'process.sh'), articleUrl], { cwd: tools.dir, env: tools.env, timeout: 180000 });
    await j.sleep(800);
    const articleLog = devLogSince(j, articleMark);
    articleId = Number((/Article #(\d+)/.exec(article.stdout) || [])[1] || 0);
    const row = articleId ? j.d1(`SELECT id, video_id, channel FROM transcripts WHERE id = ${articleId}`)[0] : null;
    j.check('process.sh finishes the article path', article.code === 0 && articleId > 0, `${article.code} ${article.stdout.trim().split('\n').slice(-2).join(' | ')}`);
    j.check('the article upload reaches the real local /api/transcribe handler', articleLog.includes('POST /api/transcribe 201'), articleLog.split('\n').filter(line => line.includes('/api/transcribe')).slice(-1).join(' | '));
    j.check('the article becomes a row in local D1', Boolean(row) && row.video_id.startsWith('article:'), row ? `${row.video_id} ${row.channel}` : 'no row');
    const body = articleId ? await j.api(`/api/transcript/${articleId}/content`) : { status: 0, text: '' };
    j.check('the article body reads back from local R2', body.status === 200 && body.text.includes(articleTitle), `HTTP ${body.status} ${body.text.length} bytes`);
    j.check('the analysis request reaches the real local analyze handler', articleLog.includes(`POST /api/transcripts/${articleId}/analyze`), articleLog.split('\n').filter(line => line.includes('/analyze')).slice(-1).join(' | '));
    j.check('process.sh summarizes the article through the real analyze handler and the fake AI', article.stdout.includes('Cloudflare summary complete'), article.stdout.trim().split('\n').filter(line => line.includes('summary') || line.includes('analysis')).slice(-1).join(' | '));
    j.check('process.sh never opened a browser', !article.stdout.includes('Opening http'));

    const audioMark = devLogMark(j);
    const audio = j.run('bash', [join(tools.dir, 'process.sh'), `https://www.youtube.com/watch?v=${videoId}`], {
      cwd: tools.dir,
      env: { ...tools.env, REQUIRE_ANALYZE: '1' },
      timeout: 180000,
    });
    await j.sleep(800);
    const audioLog = devLogSince(j, audioMark);
    audioId = Number((/Transcript #(\d+)/.exec(audio.stdout) || [])[1] || 0);
    const transcribed = /Transcribing audio with Cloudflare AI, buffer size: \d+/.test(audioLog);
    const accepted = audio.code === 0 && audio.stdout.includes('Phase 1 complete');
    j.check('process.sh extracts the audio before uploading', audio.stdout.includes('Audio extracted'), audio.stdout.trim().split('\n').slice(0, 3).join(' | '));
    j.check('the audio upload reaches the real local /api/transcribe handler', transcribed && audioLog.includes(`Video ID: ${videoId}`), audioLog.split('\n').filter(line => line.includes('Video ID') || line.includes('buffer size')).join(' | '));
    j.check('the real handler accepts the audio and writes a transcript', accepted && audioId > 0, accepted ? 'accepted, transcript written' : audio.stdout.trim().split('\n').filter(line => line.includes('ERROR')).slice(-1).join(' | '));
    j.check('the outside network is faked only for Jina Reader', outsideOnly(j, tools.calls()), tools.calls().slice(0, 3).join(' | '));
  } finally {
    await removeTranscript(j, articleId);
    await removeTranscript(j, audioId);
  }
}

async function queueDrain(j) {
  const tools = pipelineTools(j, 'queue-drain', ['queue.sh', 'process.sh', 'monitor.sh']);
  const env = { ...tools.env, MONITOR_SH: join(tools.dir, 'monitor.sh'), QUEUE_LOCK_FILE: join(tools.dir, 'queue.lock') };
  const freshUrl = `https://example.com/journey-drain-${STAMP}`;
  const freshTitle = `Journey drain article ${STAMP}`;
  const settledUrl = `https://example.com/journey-drain-settled-${STAMP}`;
  const settledTitle = `Journey drain settled article ${STAMP}`;
  const created = [];
  const transcripts = [];
  let drained = [];
  const floor = j.d1('SELECT COALESCE(MAX(id), 0) AS n FROM transcripts')[0].n;
  try {
    const fresh = await json(j, '/api/queue', { method: 'POST', body: { url: freshUrl } });
    created.push(fresh.id);
    const settled = await json(j, '/api/queue', { method: 'POST', body: { url: settledUrl } });
    created.push(settled.id);
    const existing = await json(j, '/api/transcribe', { method: 'POST', body: { url: settledUrl, markdown_content: markdown(settledTitle) } });
    transcripts.push(existing.id);
    j.check('the queue holds two waiting article rows before the drain', fresh.id > 0 && settled.id > 0, `rows ${fresh.id} and ${settled.id}`);

    tools.jina(freshTitle);
    const articleMark = devLogMark(j);
    const run = j.run('bash', [join(tools.dir, 'queue.sh')], { cwd: tools.dir, env: { ...env, QUEUE_PLATFORMS: 'article' }, timeout: 240000 });
    await j.sleep(800);
    const articleLog = devLogSince(j, articleMark);
    const rows = await json(j, '/api/queue/all?limit=1000');
    const freshRow = rows.find(row => row.id === fresh.id) || {};
    const settledRow = rows.find(row => row.id === settled.id) || {};
    const written = j.d1(`SELECT id, video_id FROM transcripts WHERE title = '${freshTitle}'`);
    transcripts.push(...written.map(row => row.id));
    j.check('queue.sh claims both rows through the real API before work', freshRow.attempts >= 1 && settledRow.attempts >= 1 && Boolean(freshRow.started_at) && Boolean(settledRow.started_at), `attempts ${freshRow.attempts} and ${settledRow.attempts}`);
    j.check('queue.sh runs the real process.sh for the article rows', run.stdout.includes('Uploading raw article to dashboard'), run.stdout.trim().split('\n').slice(-2).join(' | '));
    j.check('the row whose transcript exists ends done', settledRow.status === 'done' && run.stdout.includes('Already transcribed'), `${settledRow.status} ${settledRow.error || ''}`.trim());
    j.check('the fresh row writes a transcript through the real /api/transcribe handler', written.length === 1 && articleLog.includes('POST /api/transcribe 201'), written.map(row => row.video_id).join(' | '));
    j.check('the fresh row is no longer waiting', freshRow.status !== 'pending' && Boolean(freshRow.finished_at), `${freshRow.status} ${freshRow.error || ''}`.trim());
    j.check('the fresh row ends done', freshRow.status === 'done', `${freshRow.status}: ${(freshRow.error || '').slice(0, 120)}`);

    const waiting = await json(j, '/api/queue?platforms=youtube');
    drained = waiting;
    j.check('the queue holds waiting video rows for the hand-off', waiting.length > 0, `${waiting.length} waiting`);
    const videoMark = devLogMark(j);
    const handoff = j.run('bash', [join(tools.dir, 'queue.sh')], { cwd: tools.dir, env: { ...env, QUEUE_PLATFORMS: 'youtube' }, timeout: 240000 });
    await j.sleep(800);
    const videoLog = devLogSince(j, videoMark);
    const after = await json(j, '/api/queue/all?limit=1000');
    const first = waiting[0] || {};
    const videoRow = after.find(row => row.id === first.id) || {};
    j.check('queue.sh hands the waiting video to the real monitor.sh', handoff.stdout.includes(`Force mode: processing video ${first.video_id}`), handoff.stdout.trim().split('\n').find(line => line.includes('Force mode')) || 'no hand-off');
    j.check('the hand-off uploads the audio to the real local handler', videoLog.includes(`Video ID: ${first.video_id}`) && /Transcribing audio with Cloudflare AI, buffer size: \d+/.test(videoLog), videoLog.split('\n').filter(line => line.includes('Video ID') || line.includes('buffer size')).slice(-2).join(' | '));
    j.check('the drained video row leaves the waiting state', videoRow.status !== 'pending' && videoRow.attempts >= 1, `${videoRow.status} attempts ${videoRow.attempts}`);
    j.check('the drained video row ends done', videoRow.status === 'done', `${videoRow.status}: ${(videoRow.error || '').slice(0, 120)}`);
    j.check('every call the scripts made went to the local instance or a faked outside host', outsideOnly(j, tools.calls()), tools.calls().filter(url => !url.startsWith(j.base)).join(' | '));
  } finally {
    for (const id of created) await j.api(`/api/queue/${id}`, { method: 'DELETE' }).catch(() => {});
    for (const id of transcripts) await removeTranscript(j, id);
    const videos = drained.map(row => `'${row.video_id}'`).join(',');
    if (videos) {
      for (const row of j.d1(`SELECT id FROM transcripts WHERE id > ${floor} AND video_id IN (${videos})`)) await removeTranscript(j, row.id);
    }
    for (const row of drained) await j.api(`/api/queue/${row.id}`, { method: 'PUT', body: { status: 'pending' } }).catch(() => {});
  }
}

async function monitor(j) {
  const dir = stub(j, 'monitor');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'monitor.sh'), readFileSync(join(ROOT, 'monitor.sh')));
  writeFileSync(join(dir, 'lib', 'cf_access.sh'), readFileSync(join(ROOT, 'lib', 'cf_access.sh')));
  writeFileSync(join(dir, 'channels.txt'), 'UC00000000000000000000 # fallback\n');
  const log = join(dir, 'curl.log');
  curlStub(dir, log, `  *analyze*) printf '%s' '{"success":true,"data":{"summarized":true,"word_count":900,"category":"Health"}}';;
  *transcribe*) printf '%s' '{"success":true,"data":{"id":42,"title":"Journey monitor video"}}';;
  `);;
  writeStub(dir, 'yt-dlp', `#!/bin/bash
file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) file="$2"; shift 2;;
    *) shift;;
  esac
done
printf 'audio' > "$file"
`);
  writeStub(dir, 'ffmpeg', '#!/bin/bash\nexit 0\n');
  const video = 'MONITOR0001';
  mkdirSync(join(dir, 'home'), { recursive: true });
  const result = j.run('bash', [join(dir, 'monitor.sh'), '--force', video, 'Journey monitor video'], {
    cwd: dir,
    env: { HOME: join(dir, 'home'), PATH: join(dir, 'bin') + ':' + process.env.PATH, CF_ACCESS_CLIENT_ID: 'verify-id', CF_ACCESS_CLIENT_SECRET: 'verify-secret', CHROMESCRIBE_TELEGRAM: '0' },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const processed = existsSync(join(dir, '.processed_videos')) ? readFileSync(join(dir, '.processed_videos'), 'utf8') : '';
  j.check('monitor.sh exits 0', result.code === 0, result.stderr.trim().slice(0, 120));
  j.check('monitor.sh transcribes the forced video', calls.includes('/api/transcribe') && result.stdout.includes('Transcribed and uploaded as #42'), result.stdout.includes('#42') ? 'uploaded as #42' : result.stdout.trim().split('\n').slice(-2).join(' | '));
  j.check('monitor.sh reports hosted analysis', result.stdout.includes('Analysis complete (word_count=900, category=Health)'), result.stdout.trim().split('\n').filter(line => line.includes('Analysis')).join(' | '));
  j.check('monitor.sh records the video as processed', processed.includes(video), processed.trim());
  j.check('monitor.sh sends no Telegram message by default', !calls.includes('api.telegram.org'));
}

async function extension(j) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  j.check('extension manifest is MV3 with a service worker', manifest.manifest_version === 3 && manifest.background?.service_worker === 'background.js');
  j.check('extension runs on YouTube pages', manifest.content_scripts?.some(entry => entry.matches.includes('*://*.youtube.com/*')));
  const background = readFileSync(join(ROOT, 'extension', 'background.js'), 'utf8');
  j.check('extension sends the page to the local terminal', background.includes('const TERMINAL_BASE = "http://localhost:7681/"') && background.includes('process.bat'));
  j.check('extension queues TikTok saves to the share API', readFileSync(join(ROOT, 'extension', 'tiktok-saves.js'), 'utf8').includes('/api/queue'));
  const page = await j.open('/');
  await page.addInitScript(() => {
    window.close = () => {};
    window.chrome = {
      tabs: { query: (_query, done) => done([{ url: 'https://www.youtube.com/watch?v=JOURNEYEXT1' }]) },
      runtime: { sendMessage: message => { window.__sent = message; } },
    };
  });
  await page.goto('file://' + join(ROOT, 'extension', 'popup.html'));
  await page.locator('#btn-pi').click();
  const sent = await page.evaluate(() => window.__sent);
  j.check('popup sends the process action for the active tab', sent?.action === 'process' && sent?.tab?.url === 'https://www.youtube.com/watch?v=JOURNEYEXT1', JSON.stringify(sent));
  await j.shot('extension-popup');
}

async function phoneShare(j) {
  const created = [];
  try {
    const link = `https://www.youtube.com/watch?v=${youtubeId('P')}`;
    const first = await json(j, '/api/queue', { method: 'POST', body: { url: link } });
    created.push(first.id);
    j.check('share returns queued true with the platform', first.queued === true && first.platform === 'youtube', JSON.stringify(first));
    const again = await json(j, '/api/queue', { method: 'POST', body: { url: link } });
    j.check('a second share does not duplicate the pending row', again.id === first.id && again.duplicate === true, JSON.stringify(again));
    const pending = await json(j, '/api/queue/all?limit=1000');
    j.check('the shared link is pending once', pending.filter(row => row.video_id === youtubeId('P')).length === 1, `${pending.length} queue rows`);
    const bad = await j.api('/api/queue', { method: 'POST', body: { url: 'not a link' } });
    j.check('an unsupported link is refused with a reason', bad.status === 400 && bad.text.includes('Unsupported URL'), `HTTP ${bad.status} ${bad.text}`);
    const local = await j.api('/api/queue', { method: 'POST', body: { url: 'https://localhost/watch' } });
    j.check('a local link is refused', local.status === 400, `HTTP ${local.status} ${local.text}`);
    const credentialed = await j.api('/api/queue', { method: 'POST', body: { url: 'https://user:pass@example.com/journey' } });
    j.check('a credentialed link is refused', credentialed.status === 400, `HTTP ${credentialed.status} ${credentialed.text}`);
    const tiktokId = String(Date.now()).padEnd(19, '0');
    const tiktok = await json(j, '/api/queue', { method: 'POST', body: { url: `https://www.tiktok.com/@journey/video/${tiktokId}` } });
    created.push(tiktok.id);
    j.check('full TikTok links are queued', tiktok.platform === 'tiktok' && tiktok.queued === true, JSON.stringify(tiktok));
    const tiktokShort = await json(j, '/api/queue', { method: 'POST', body: { url: `https://www.tiktok.com/t/${STAMP}/` } });
    created.push(tiktokShort.id);
    j.check('short TikTok links are queued', tiktokShort.platform === 'tiktok' && tiktokShort.queued === true, JSON.stringify(tiktokShort));
    const article = await json(j, '/api/queue', { method: 'POST', body: { url: `https://example.com/journey-share-${STAMP}` } });
    created.push(article.id);
    j.check('article links are queued for the worker', article.platform === 'article', JSON.stringify(article));
    j.check('queued rows are visible to the drain script', (await json(j, '/api/queue?platforms=article')).some(row => row.id === article.id));
  } finally {
    for (const id of created) await j.api(`/api/queue/${id}`, { method: 'DELETE' }).catch(() => {});
  }
}

async function articleSource(j) {
  const title = `Journey article source ${STAMP}`;
  let created = null;
  try {
    created = await createArticle(j, title);
    j.check('scratch article written through the API', created?.id > 0, `id ${created?.id}`);
    const source = `https://example.com/${encodeURIComponent(title)}`;
    const route = `/api/transcripts/${created.id}/source`;
    const redirect = await j.api(route, { redirect: 'manual' });
    j.check('article source route redirects to the stored link', redirect.status === 302 && redirect.headers.location === source, `HTTP ${redirect.status} ${redirect.headers.location}`);
    const missing = await j.api('/api/transcripts/999999999/source', { redirect: 'manual' });
    j.check('missing transcript source is a 404', missing.status === 404, `HTTP ${missing.status}`);
    const page = await j.open('/');
    const card = page.locator('#videoGrid .card').filter({ hasText: title }).first();
    await retryUntil(card);
    const original = card.locator('a', { hasText: 'Open original' }).first();
    j.check('article card links Open original to the source route', (await original.getAttribute('href')) === route, await original.getAttribute('href'));
    await j.shot('article-source-card');
  } finally {
    if (created?.id) await removeTranscript(j, created.id);
  }
}

async function androidUpdates(j) {
  const latest = await j.api('/api/android/latest');
  j.check('latest update metadata is served', latest.status === 200 && latest.json?.versionCode === 7, `HTTP ${latest.status} ${latest.text.slice(0, 120)}`);
  j.check('latest metadata is uncached JSON', (latest.headers['content-type'] || '').includes('application/json') && latest.headers['cache-control'] === 'no-store', `${latest.headers['content-type']} ${latest.headers['cache-control']}`);
  const apk = await j.api('/api/android/releases/7/app.apk');
  j.check('APK download is served from R2', apk.status === 200 && apk.text.includes('CS-VERIFY-APK-7'), `HTTP ${apk.status} ${apk.text.length} bytes`);
  j.check('APK download is an attachment', apk.headers['content-type'] === 'application/vnd.android.package-archive' && /attachment; filename="app\.apk"/.test(apk.headers['content-disposition'] || ''), `${apk.headers['content-type']} ${apk.headers['content-disposition']}`);
  const missing = await j.api('/api/android/releases/8/app.apk');
  j.check('missing release is a JSON 404', missing.status === 404 && missing.json?.error === 'not_found', `HTTP ${missing.status} ${missing.text}`);
  const file = join(j.proofDir, 'android-update.json');
  writeFileSync(file, JSON.stringify({ latest, apk, missing }, null, 2));
  j.proof.push(file);
}

async function homeCommands(j) {
  const page = await j.open('/');
  await page.waitForSelector('#videoGrid .card');
  await page.waitForFunction(() => /\d/.test(document.querySelector('#stats')?.textContent || ''));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#videoGrid .card');

  await page.keyboard.press('j');
  await page.waitForFunction(() => document.querySelectorAll('#videoGrid .card.kb-selected').length === 1);
  j.check('j selects a card', await page.locator('#videoGrid .card.kb-selected').count() === 1, 'one card selected');
  await page.keyboard.press('k');
  j.check('k keeps a card selected', await page.locator('#videoGrid .card.kb-selected').count() === 1, 'one card selected');

  await page.keyboard.press('/');
  j.check('slash focuses the search box', await page.evaluate(() => document.activeElement?.id === 'searchInput'), 'search input focused');
  await page.keyboard.press('Escape');

  await page.keyboard.press('?');
  await page.waitForFunction(() => document.querySelector('#shortcuts')?.open);
  j.check('question mark opens the shortcut list', (await page.textContent('#shortcuts')).includes('Go to queue'), 'shortcut dialog open');
  await page.locator('#shortcuts .shortcuts-close').click();
  await page.waitForFunction(() => !document.querySelector('#shortcuts')?.open);

  await page.keyboard.press('Control+k');
  await page.waitForFunction(() => document.querySelector('#cmdk')?.open);
  await page.fill('#cmdkInput', 'stats');
  j.check('the command menu filters commands', (await page.textContent('#cmdkList')).includes('Stats'), await page.textContent('#cmdkList'));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/stats\.html$/);
  j.check('Enter runs the selected command', page.url().endsWith('/stats.html'), page.url());

  await page.goto(j.url('/'), { waitUntil: 'networkidle' });
  await page.waitForSelector('#videoGrid .card');
  await page.keyboard.press('a');
  await page.waitForSelector('#addModal:not(.hidden)');
  j.check('a opens the Add form', await page.locator('#addModal').evaluate(node => !node.classList.contains('hidden')), 'modal visible');
  await page.keyboard.press('Escape');
  j.check('Escape closes the Add form', await page.locator('#addModal').evaluate(node => node.classList.contains('hidden')), 'modal hidden');

  await page.keyboard.press('g');
  await page.keyboard.press('q');
  await page.waitForURL(/\/queue\.html$/);
  j.check('g then q navigates to the queue page', page.url().endsWith('/queue.html'), page.url());
  await j.shot('home-commands');
}

export const journeys = {
  home,
  'home-commands': homeCommands,
  video,
  'add-video': addVideo,
  queue,
  subscriptions,
  reports,
  stats,
  settings,
  theme,
  'cli-query': cliQuery,
  'cli-channels': cliChannels,
  'cli-learn': cliLearn,
  'cli-lens': cliLens,
  process: processPipeline,
  'queue-drain': queueDrain,
  monitor,
  extension,
  'phone-share': phoneShare,
  'article-source': articleSource,
  'android-updates': androidUpdates,
};
