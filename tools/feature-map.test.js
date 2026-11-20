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

function readmeCliCommands() {
  const readme = read('cli/README.md');
  const start = readme.indexOf('## Commands');
  const end = readme.indexOf('## Lenses');
  const section = start >= 0 && end > start ? readme.slice(start, end) : '';
  return [...new Set([...section.matchAll(/`([a-z][a-z0-9_-]*)(?![a-z0-9_/-])/g)].map(match => match[1]))].sort();
}

const DYNAMIC_API_ROUTES = [
  { marker: "path.startsWith('reports/')", route: '/api/reports/<id>' },
  { marker: "path.startsWith('thumb/')", route: '/api/thumb/<videoId>' },
  { marker: "path.startsWith('channels/') && path.endsWith('/refresh')", route: '/api/channels/<id>/refresh' },
  { marker: "path.startsWith('channels/')", route: '/api/channels/<id>' },
  { marker: '/^transcripts\\/\\d+\\/source$/', route: '/api/transcripts/<id>/source' },
  { marker: "path.startsWith('transcripts/')", route: '/api/transcripts/<id>' },
  { marker: "path.startsWith('transcript/') && path.endsWith('/content')", route: '/api/transcript/<id>/content' },
  { marker: '/^speak\\/[^/]+$/', route: '/api/speak/<id>' },
  { marker: "path.startsWith('transcripts/') && path.endsWith('/analyze')", route: '/api/transcripts/<id>/analyze' },
  { marker: "path.startsWith('transcripts/') && path.endsWith('/summarize')", route: '/api/transcripts/<id>/summarize' },
  { marker: "path.startsWith('transcripts/') && path.endsWith('/classify')", route: '/api/transcripts/<id>/classify' },
  { marker: "path.startsWith('queue/')", route: '/api/queue/<id>' },
];

function namedIn(text, command) {
  return new RegExp('`' + command + '\\b|chromescribe ' + command + '\\b').test(text);
}

function named(command) {
  return namedIn(all, command);
}

function featurePaths(feature) {
  const data = parseFrontMatter(feature.text);
  return data && Array.isArray(data.paths) ? data.paths : [];
}

function globToRegExp(glob) {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

function owns(feature, file) {
  return featurePaths(feature).some(glob => globToRegExp(glob).test(file));
}

function pageForRoute(route) {
  if (route === '/') return 'index.html';
  if (route === '/reports/<id>') return 'reports.html';
  return route.slice(1);
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

test('every public HTML page belongs to a feature file through paths', () => {
  const pages = readdirSync(join(repo, 'dashboard/public')).filter(name => name.endsWith('.html'));
  const problems = pages.filter(page => !features.some(feature => owns(feature, `dashboard/public/${page}`)));
  assert.deepEqual(problems, [], `pages with no owning feature paths: ${problems.join(', ')}`);
});

test('every page route is named by a feature that owns its page', () => {
  const { routes, reportRoute } = runnerRoutes();
  const allRoutes = [...routes, ...(reportRoute ? [reportRoute] : [])];
  const problems = allRoutes.filter(route => {
    const page = `dashboard/public/${pageForRoute(route)}`;
    return !features.some(feature => owns(feature, page) && feature.text.includes('`' + route + '`'));
  });
  assert.deepEqual(problems, [], `routes with no owning feature paths: ${problems.join(', ')}`);
});

test('every dashboard API module belongs to a feature file through paths', () => {
  const modules = readdirSync(join(repo, 'dashboard/src'))
    .filter(name => name.endsWith('.mjs') && read(`dashboard/src/${name}`).includes('/api/'));
  const problems = modules.filter(name => !features.some(feature => owns(feature, `dashboard/src/${name}`)));
  assert.deepEqual(problems, [], `API modules with no owning feature paths: ${problems.join(', ')}`);
});

const OPERATOR_ONLY_API = new Set(['debug']);

test('every literal API route is named by a feature file', () => {
  const source = read('dashboard/src/index.ts');
  const routes = [...new Set([...source.matchAll(/\bpath === ['"]([^'"]+)['"]/g)].map(match => match[1]))];
  assert.ok(routes.length > 5, 'API route scan found too few routes');
  const problems = routes.filter(route => !OPERATOR_ONLY_API.has(route) && !features.some(feature => feature.text.includes(`/api/${route}`)));
  assert.deepEqual(problems, [], `API routes no feature file names as /api/<route>: ${problems.join(', ')}`);
});

test('every dynamic API route is named by a feature file', () => {
  const source = read('dashboard/src/index.ts');
  const moved = DYNAMIC_API_ROUTES.filter(({ marker }) => !source.includes(marker));
  assert.deepEqual(moved.map(({ route }) => route), [], 'dynamic API route scan markers moved');
  const problems = DYNAMIC_API_ROUTES.filter(({ route }) => !all.includes(route)).map(({ route }) => route);
  assert.deepEqual(problems, [], `dynamic API routes no feature file names: ${problems.join(', ')}`);
});

test('every API route is named by a feature that owns dashboard/src/index.ts', () => {
  const source = read('dashboard/src/index.ts');
  const literal = [...new Set([...source.matchAll(/\bpath === ['"]([^'"]+)['"]/g)].map(match => match[1]))]
    .filter(route => !OPERATOR_ONLY_API.has(route))
    .map(route => `/api/${route}`);
  const routes = [...new Set([...literal, ...DYNAMIC_API_ROUTES.map(({ route }) => route)])];
  assert.ok(routes.length > 10, `API route scan found ${routes.length} routes`);
  const owners = features.filter(feature => owns(feature, 'dashboard/src/index.ts'));
  const problems = routes.filter(route => !owners.some(feature => feature.text.includes(route)));
  assert.deepEqual(problems, [], `API routes with no owning feature paths: ${problems.join(', ')}`);
});

test('every shell pipeline belongs to a feature file through paths', () => {
  const pipelines = ['process.sh', 'queue.sh', 'monitor.sh'];
  const problems = pipelines.filter(file => !features.some(feature => owns(feature, file)));
  assert.deepEqual(problems, [], `pipelines with no owning feature paths: ${problems.join(', ')}`);
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

test('every CLI subcommand is named by a feature that owns the CLI', () => {
  const commands = cliCommands();
  const owners = features.filter(feature => owns(feature, 'cli/chromescribe'));
  const problems = commands.filter(command => !owners.some(feature => namedIn(feature.text, command)));
  assert.deepEqual(problems, [], `CLI commands with no owning feature paths: ${problems.join(', ')}`);
});

test('every CLI command in cli/README.md exists and is named by a feature that owns the CLI', () => {
  const commands = readmeCliCommands();
  assert.ok(commands.length >= 10, `parsed ${commands.length} CLI commands from cli/README.md`);
  const known = cliCommands();
  const missing = commands.filter(command => !known.includes(command));
  assert.deepEqual(missing, [], `cli/README.md commands missing from the CLI: ${missing.join(', ')}`);
  const owners = features.filter(feature => owns(feature, 'cli/chromescribe'));
  const problems = commands.filter(command => !owners.some(feature => namedIn(feature.text, command)));
  assert.deepEqual(problems, [], `cli/README.md commands with no owning feature paths: ${problems.join(', ')}`);
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
