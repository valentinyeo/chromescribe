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
  console.error('Usage: node tools/live-check.mjs <base-url> [--public <dir>] [--tries <n>] [--wait <ms>] [--version <id>] [--require-login]');
  console.error('Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to check a site behind the login.');
  process.exit(2);
}
const publicDir = option('--public', fileURLToPath(new URL('../dashboard/public/', import.meta.url)));
const tries = Number(option('--tries', '6'));
const wait = Number(option('--wait', '10000'));
const version = option('--version', String(Date.now()));
const pages = readdirSync(publicDir).filter(file => file.endsWith('.html')).sort();
const clientId = process.env.CF_ACCESS_CLIENT_ID;
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const login = clientId && clientSecret ? { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret } : null;
const signedIn = login || {};
if (args.includes('--require-login') && !login) {
  console.error('--require-login needs CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in the environment.');
  process.exit(2);
}

async function problem(page) {
  const expected = readFileSync(path.join(publicDir, page), 'utf8');
  const url = `${base}/${page === 'index.html' ? '' : page}?v=${encodeURIComponent(version)}`;
  try {
    const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache', ...signedIn }, redirect: 'manual' });
    const body = await response.text();
    if (response.status !== 200) return `${url}: HTTP ${response.status}`;
    if (body !== expected) return `${url}: live page differs from dashboard/public/${page}`;
    return null;
  } catch (error) {
    return `${url}: ${error.cause?.code || error.message}`;
  }
}

async function status(pathname, headers = {}) {
  try {
    const response = await fetch(`${base}${pathname}`, { headers: { 'Cache-Control': 'no-cache', ...headers }, redirect: 'manual' });
    await response.arrayBuffer();
    return response.status;
  } catch (error) {
    return error.cause?.code || error.message;
  }
}

async function loginProblems() {
  if (!login) return [];
  const found = [];
  const anonymous = await status('/api/transcripts?limit=1');
  if (![302, 401, 403].includes(anonymous)) found.push(`${base}/api/transcripts: answered ${anonymous} without a login, expected a login redirect or 401`);
  const withKey = await status('/api/transcripts?limit=1', login);
  if (withKey !== 200) found.push(`${base}/api/transcripts: answered ${withKey} with the service key, expected 200`);
  const report = await status('/reports/000000000000');
  if (report !== 404) found.push(`${base}/reports/000000000000: answered ${report} without a login, expected 404 because report pages stay open`);
  return found;
}

let problems = [];
for (let attempt = 1; attempt <= tries; attempt++) {
  problems = [...(await Promise.all(pages.map(problem))).filter(Boolean), ...await loginProblems()];
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
} else console.log(`Live check passed: ${pages.length} pages on ${base} match dashboard/public${login ? ', the API refuses calls without a login and report pages stay open' : ''}.`);
