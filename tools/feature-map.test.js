import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const skill = join(repo, '.claude/skills/verify-chromescribe');
const featuresDir = join(skill, 'features');
const names = readdirSync(featuresDir).filter(name => name.endsWith('.md') && name !== 'README.md').sort();
const features = names.map(name => ({ name, text: readFileSync(join(featuresDir, name), 'utf8') }));
const all = features.map(feature => feature.text).join('\n');
const read = path => readFileSync(join(repo, path), 'utf8');

const h2s = ['Sub-features', 'How to get to it (user POV)', 'Driving it with cs-verify', 'Gotchas'];

function parseFrontMatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const data = {};
  let list = null;
  for (const line of match[1].split('\n')) {
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (item && list) {
      data[list].push(item[1].trim());
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    if (!pair[2].trim()) {
      data[pair[1]] = [];
      list = pair[1];
      continue;
    }
    list = null;
    data[pair[1]] = pair[2].trim();
  }
  return data;
}

function runnerRoutes() {
  const source = read('dashboard/src/index.ts');
  const routes = [...new Set([...source.matchAll(/url\.pathname === ['"](\/[^'"]*)['"]/g)].map(match => match[1]))];
  const reportRoute = source.includes('/^\\/reports') ? '/reports/<id>' : null;
  return { routes, reportRoute };
}

function cliCommands() {
  const source = read('cli/chromescribe');
  const block = source.slice(source.indexOf('main() {'), source.indexOf('main "$@"'));
  const commands = new Set();
  for (const match of block.matchAll(/^\s{4}([A-Za-z0-9_|:-]+)\)/gm)) {
    for (const name of match[1].split('|')) {
      if (name && !name.startsWith('-')) commands.add(name);
    }
  }
  return [...commands].sort();
}

function named(command) {
  return new RegExp('`' + command + '\\b|chromescribe ' + command + '\\b').test(all);
}

test('every feature file declares front matter with paths and a journey', async () => {
  const { journeys } = await import(pathToFileURL(join(skill, 'scripts', 'journeys.mjs')).href);
  assert.ok(features.length > 0, 'no feature files found');
  const problems = [];
  for (const feature of features) {
    const data = parseFrontMatter(feature.text);
    if (!data) {
      problems.push(`${feature.name}: missing YAML front matter`);
      continue;
    }
    if (!data.name) problems.push(`${feature.name}: front matter has no name`);
    if (!data.journey) problems.push(`${feature.name}: front matter has no journey`);
    else if (typeof journeys[data.journey] !== 'function') problems.push(`${feature.name}: journey ${data.journey} is not defined in scripts/journeys.mjs`);
    if (!Array.isArray(data.paths) || data.paths.length === 0) problems.push(`${feature.name}: front matter has no paths list`);
  }
  assert.deepEqual(problems, []);
});

test('every feature file has the four H2 sections in order', () => {
  const problems = [];
  for (const feature of features) {
    const found = [...feature.text.matchAll(/^## (.+)$/gm)].map(match => match[1].trim());
    if (JSON.stringify(found) !== JSON.stringify(h2s)) {
      problems.push(`${feature.name}: expected ${h2s.join(', ')}, found ${found.join(', ') || 'none'}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every dashboard page route is named in the feature map', () => {
  const { routes, reportRoute } = runnerRoutes();
  const expected = routes.filter(route => route !== '/');
  if (reportRoute) expected.push(reportRoute);
  const problems = expected.filter(route => !all.includes('`' + route + '`'));
  assert.deepEqual(problems, [], `unnamed routes: ${problems.join(', ')}`);
  assert.ok(features.some(feature => feature.text.includes('`/`') || feature.text.includes('home page')), 'the root route is not named');
});

test('every public HTML page is named in the feature map', () => {
  const pages = readdirSync(join(repo, 'dashboard/public')).filter(name => name.endsWith('.html')).sort();
  const problems = pages.filter(page => !all.includes(page));
  assert.deepEqual(problems, [], `unnamed pages: ${problems.join(', ')}`);
});

test('every CLI subcommand is named in the feature map', () => {
  const commands = cliCommands();
  assert.ok(commands.length >= 10, `parsed ${commands.length} CLI commands; the case block moved`);
  const problems = commands.filter(command => !named(command));
  assert.deepEqual(problems, [], `unnamed CLI commands: ${problems.join(', ')}`);
});

test('the feature README indexes every feature file and states coverage', () => {
  const readme = readFileSync(join(featuresDir, 'README.md'), 'utf8');
  const missing = names.filter(name => !readme.includes(`(./${name})`));
  assert.deepEqual(missing, [], `features missing from the README index: ${missing.join(', ')}`);
  const coverage = /Coverage: (\d+) of (\d+) features mapped/.exec(readme);
  assert.ok(coverage, 'README has no "Coverage: N of N features mapped" line');
  assert.equal(Number(coverage[1]), names.length);
  assert.equal(Number(coverage[2]), names.length);
});
