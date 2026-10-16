#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const base = args[0]?.replace(/\/$/, '');
if (!base || base.startsWith('--')) {
  console.error('Usage: node tools/live-check.mjs <base-url> [--public <dir>] [--tries <n>] [--wait <ms>] [--version <id>]');
  process.exit(2);
}
const publicDir = option('--public', fileURLToPath(new URL('../dashboard/public/', import.meta.url)));
const tries = Number(option('--tries', '6'));
const wait = Number(option('--wait', '10000'));
const version = option('--version', String(Date.now()));
const pages = readdirSync(publicDir).filter(file => file.endsWith('.html')).sort();

async function problem(page) {
  const expected = readFileSync(path.join(publicDir, page), 'utf8');
  const url = `${base}/${page === 'index.html' ? '' : page}?v=${encodeURIComponent(version)}`;
  try {
    const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, redirect: 'manual' });
    const body = await response.text();
    if (response.status !== 200) return `${url}: HTTP ${response.status}`;
    if (body !== expected) return `${url}: live page differs from dashboard/public/${page}`;
    return null;
  } catch (error) {
    return `${url}: ${error.cause?.code || error.message}`;
  }
}

let problems = [];
for (let attempt = 1; attempt <= tries; attempt++) {
  problems = (await Promise.all(pages.map(problem))).filter(Boolean);
  if (!problems.length) break;
  if (attempt < tries) {
    console.log(`Attempt ${attempt}/${tries}: ${problems.length} page(s) not live yet, retrying in ${wait}ms.`);
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}
if (problems.length) {
  for (const line of problems) console.error(line);
  console.error('The deploy finished but the live site does not serve these pages as committed.');
  process.exitCode = 1;
} else console.log(`Live check passed: ${pages.length} pages on ${base} match dashboard/public.`);
