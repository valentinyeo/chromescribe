const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'media-check.mjs');
const run = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('master at eab0c26 fails on the ten downloaded media files, including the one without an extension', () => {
  const result = run(root, '--rev', 'eab0c26');
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stderr.trim().split('\n').slice(0, -1);
  assert.equal(lines.length, 10, result.stderr);
  assert.match(result.stderr, /tiktok_video\.mp4: media file by extension/);
  assert.match(result.stderr, /output_temp\.en\.vtt: media file by extension/);
  assert.match(result.stderr, /debug_screenshot\.png: image in the top folder/);
  assert.match(result.stderr, /Undo Them？: MP4 video by content/);
  assert.doesNotMatch(result.stderr, /extension\/icons/);
});

test('repository passes the media check', () => {
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Media check passed/);
});

test('staged media is caught by extension and by content, nested images are allowed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-check-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  try {
    git('init', '-q');
    fs.mkdirSync(path.join(dir, 'icons'));
    fs.writeFileSync(path.join(dir, 'icons/icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(dir, 'notes.md'), '# notes\n');
    git('add', '.');
    assert.equal(run(dir).status, 0);
    fs.writeFileSync(path.join(dir, 'clip'), Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom')]));
    fs.writeFileSync(path.join(dir, 'captions.txt'), 'WEBVTT\n\n');
    fs.writeFileSync(path.join(dir, 'song.webm'), 'x');
    fs.writeFileSync(path.join(dir, 'shot.jpg'), 'x');
    git('add', '.');
    const bad = run(dir);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /clip: MP4 video by content/);
    assert.match(bad.stderr, /captions\.txt: subtitle file by content/);
    assert.match(bad.stderr, /song\.webm: media file by extension/);
    assert.match(bad.stderr, /shot\.jpg: image in the top folder/);
    assert.doesNotMatch(bad.stderr, /icon\.png|notes\.md/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
