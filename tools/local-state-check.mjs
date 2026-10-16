#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const sqliteHeader = Buffer.from('SQLite format 3\0', 'latin1');

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
  return execFileSync('git', ['cat-file', 'blob', sha], { maxBuffer: 1 << 30 }).subarray(0, sqliteHeader.length);
}

const revIndex = process.argv.indexOf('--rev');
const rev = revIndex > 0 ? process.argv[revIndex + 1] : null;
const list = entries(rev);
const problems = [];
for (const { file, sha } of list) {
  if (file.split('/').includes('.wrangler')) problems.push(`${file}: local wrangler state`);
  else if (/\.(sqlite|sqlite3|db)(-shm|-wal|-journal)?$/i.test(file)) problems.push(`${file}: local database file`);
  else if (header(sha).equals(sqliteHeader)) problems.push(`${file}: SQLite database by content`);
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  console.error('Local test databases do not belong in git. Run `git rm -r --cached <path>`; .wrangler/ is ignored.');
  process.exitCode = 1;
} else console.log(`Local state check passed (${list.length} files).`);
