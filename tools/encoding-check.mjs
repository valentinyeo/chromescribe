#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

function tokens(source) {
  const result = [];
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source[i] === '#') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    const start = i;
    if (source[i] === '"' || source[i] === "'") {
      const quote = source.startsWith(source[i].repeat(3), i) ? source[i].repeat(3) : source[i];
      i += quote.length;
      const valueStart = i;
      while (i < source.length && !source.startsWith(quote, i)) i += source[i] === '\\' ? 2 : 1;
      result.push({ value: source.slice(valueStart, i), kind: 'string', start });
      i += quote.length;
    } else {
      const word = /^[A-Za-z_]\w*/.exec(source.slice(i));
      const value = word ? word[0] : source[i];
      i += value.length;
      result.push({ value, kind: word ? 'word' : 'punctuation', start });
    }
  }
  return result;
}

function checkOpen(stream, index) {
  const args = [[]];
  let depth = 0;
  for (let i = index + 2; i < stream.length; i++) {
    const token = stream[i];
    if (token.kind === 'punctuation') {
      if (token.value === ')' && depth === 0) break;
      if ('([{'.includes(token.value)) depth++;
      if (')]}'.includes(token.value)) depth--;
      if (token.value === ',' && depth === 0) { args.push([]); continue; }
    }
    args.at(-1).push(token);
  }
  if (args.some(arg => arg[0]?.kind === 'word' && arg[0].value === 'encoding' && arg[1]?.value === '=')) return true;
  const modeArg = args.find(arg => arg[0]?.kind === 'word' && arg[0].value === 'mode' && arg[1]?.value === '=');
  const mode = modeArg ? modeArg.slice(2) : args[1];
  return mode?.length === 1 && mode[0].kind === 'string' && /^(?:[rwax]b\+?|[rwax]\+b|b[rwax]\+?)$/.test(mode[0].value);
}

const files = process.argv.slice(2);
if (!files.length) {
  files.push(...execFileSync('git', ['ls-files', '-z', '*.py', '*.sh', '*.bat'], { encoding: 'utf8' }).split('\0').filter(file => file && file !== 'tools/fixtures/process-before-utf8.sh'));
}
let errors = 0;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const report = (line, valid) => {
    if (valid) return;
    console.error(`${file}:${line}: open() lacks encoding= or a binary mode; use open(path, encoding='utf-8')`);
    errors++;
  };
  if (path.extname(file) === '.py') {
    const stream = tokens(source);
    for (let i = 0; i < stream.length; i++) {
      if (stream[i].kind === 'word' && stream[i].value === 'open' && stream[i + 1]?.value === '(' && !['.', 'def', 'class'].includes(stream[i - 1]?.value)) {
        report(source.slice(0, stream[i].start).split('\n').length, checkOpen(stream, i));
      }
    }
    const prints = stream.some((token, i) => token.kind === 'word' && token.value === 'print' && stream[i + 1]?.value === '(');
    const configuration = ['sys', '.', 'stdout', '.', 'reconfigure', '(', 'encoding', '=', 'utf-8'];
    const configured = stream.some((token, i) => token.kind === 'word' && configuration.every((value, j) => stream[i + j]?.value === value && stream[i + j]?.kind === (j === 8 ? 'string' : /^[a-z]/.test(value) ? 'word' : 'punctuation')));
    if (prints && !configured) {
      console.error(`${file}: add sys.stdout.reconfigure(encoding='utf-8', errors='replace')`);
      errors++;
    }
  } else if (['.sh', '.bat'].includes(path.extname(file))) {
    let offset = 0;
    source.split('\n').forEach((line, index) => {
      const start = offset;
      offset += line.length + 1;
      if (/^\s*(?:#|rem\b|::|echo\b|printf\b)/i.test(line)) return;
      for (const match of line.matchAll(/(?<![\w.$-])open\s*\(/g)) {
        const stream = tokens(source.slice(start + match.index));
        if (stream[2]?.value === ')' && /^\s*\{/.test(line.slice(match.index + stream[2].start + 1))) continue;
        report(index + 1, checkOpen(stream, 0));
      }
    });
  }
}
if (errors) process.exitCode = 1;
else console.log(`Encoding check passed (${files.length} files).`);
