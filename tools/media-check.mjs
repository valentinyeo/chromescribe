#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const mediaExtensions = new Set(['.mp4', '.m4a', '.mov', '.mkv', '.webm', '.avi', '.mp3', '.wav', '.opus', '.ogg', '.flac', '.aac', '.vtt', '.srt', '.ass', '.part', '.ytdl']);
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function mediaKind(header) {
  const ascii = header.toString('latin1');
  if (ascii.slice(4, 8) === 'ftyp') return 'MP4 video';
  if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'WebM or MKV video';
  if (ascii.startsWith('WEBVTT') ||ascii.startsWith('\xef\xbb\xbfWEBVTT')) return 'subtitle file';
  if (ascii.startsWith('ID3') || ascii.startsWith('OggS') || ascii.startsWith('fLaC')) return 'audio file';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return 'audio file';
  return null;
}

function entries(rev) {
  const output = rev
    ? execFileSync('git', ['ls-tree', '-r', '-z', rev], { encoding: 'utf8' })
    : execFileSync('git', ['ls-files', '-s', '-z'], { encoding: 'utf8' });
  return output.split('\0').filter(Boolean).map(line => {
    const [meta, file] = line.split('\t');
    const fields = meta.split(' ');
    return { file, sha: rev ? fields[2] : fields[1], mode: fields[0] };
  }).filter(entry => entry.mode !== '160000');
}

function header(sha) {
  return execFileSync('git', ['cat-file', 'blob', sha], { maxBuffer: 1 << 30 }).subarray(0, 16);
}

const revIndex = process.argv.indexOf('--rev');
const rev = revIndex > 0 ? process.argv[revIndex + 1] : null;
const list = entries(rev);
const problems = [];
for (const { file, sha } of list) {
  const extension = path.extname(file).toLowerCase();
  if (mediaExtensions.has(extension)) problems.push(`${file}: media file by extension`);
  else if (!file.includes('/') && imageExtensions.has(extension)) problems.push(`${file}: image in the top folder`);
  else {
    const kind = mediaKind(header(sha));
    if (kind) problems.push(`${file}: ${kind} by content`);
  }
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  console.error('Downloaded media does not belong in git. Run `git rm --cached <file>`; process.sh and monitor.sh download into /tmp.');
  process.exitCode = 1;
} else console.log(`Media check passed (${list.length} files).`);
