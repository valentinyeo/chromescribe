#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const clientFile = /^(extension|dashboard\/public)\/|\.(gradle|gradle\.kts|kt|java)$|(^|\/)AndroidManifest\.xml$/;
const secretName = /cfSecret|CF_SECRET|CF-Access-Client-Secret/i;

function entries(rev) {
  const output = rev
    ? execFileSync('git', ['ls-tree', '-r', '-z', rev], { encoding: 'utf8' })
    : execFileSync('git', ['ls-files', '-s', '-z'], { encoding: 'utf8' });
  return output.split('\0').filter(Boolean).map(line => {
    const [meta, file] = line.split('\t');
    const fields = meta.split(' ');
    return { file, sha: rev ? fields[2] : fields[1], mode: fields[0] };
  }).filter(entry => entry.mode !== '160000' && clientFile.test(entry.file));
}

const revIndex = process.argv.indexOf('--rev');
const rev = revIndex > 0 ? process.argv[revIndex + 1] : null;
const list = entries(rev);
const problems = [];
for (const { file, sha } of list) {
  const lines = execFileSync('git', ['cat-file', 'blob', sha], { encoding: 'utf8', maxBuffer: 1 << 30 }).split('\n');
  const hits = lines.flatMap((line, i) => secretName.test(line) ? [`${file}:${i + 1}: mentions the Access client secret`] : []);
  problems.push(...hits);
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  console.error('Apps people install must not carry the Access service key. Sign users in instead; only server scripts read the key, from 1Password via yeo-key.');
  process.exitCode = 1;
} else console.log(`Client key check passed (${list.length} client files).`);
