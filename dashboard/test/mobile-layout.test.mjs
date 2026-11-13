import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const home = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const video = readFileSync(new URL('../public/transcript.html', import.meta.url), 'utf8');

test('phone home renders compact rows with a category and a read time', () => {
  const code = [...home.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const context = vm.createContext({
    csTheme: { icon: () => '', label: () => '' }, addEventListener() {},
    document: { addEventListener() {}, getElementById: () => ({ textContent: '', title: '', setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} } }) },
  });
  context.window = context;
  vm.runInContext(code, context);
  context.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const row = context.renderCardTags({ category: 'AI Agents', tags: '["retrieval"]', word_count: 830 });
  assert.match(row, /class="category-pill">AI Agents</);
  assert.match(row, /class="card-readtime">4 min read</);
  assert.doesNotMatch(row, /class="tag-pill">retrieval</);
  assert.match(context.renderCardTags({ category: 'AI', tags: '[]', word_count: 0 }), /1 min read/);
});

test('phone home has a search button, an overflow menu and a floating add button', () => {
  assert.match(home, /id="mobileSearchBtn"[^>]*onclick="toggleMobileSearch\(\)"/);
  assert.match(home, /id="mobileMenuBtn"[^>]*onclick="toggleMobileMenu\(event\)"/);
  assert.match(home, /id="mobileMenu" class="mobile-menu hidden"/);
  assert.match(home, /class="fab" onclick="openAddModal\(\)"/);
  assert.match(home, /@media \(max-width: 640px\)[\s\S]*?\.header-actions \{ display: none; \}/);
  assert.match(home, /@media \(max-width: 640px\)[\s\S]*?\.card-actions \{ display: none; \}/);
});

test('phone video page starts on the summary tab with the transcript one tap away', () => {
  assert.match(video, /id="transcriptSide" data-tab="summary"/);
  assert.match(video, /class="mobile-tab active" data-tab="summary" onclick="setTab\('summary'\)">Summary</);
  assert.match(video, /class="mobile-tab" data-tab="transcript" onclick="setTab\('transcript'\)">Transcript</);
  assert.match(video, /id="mobileSummary"/);
  assert.match(video, /\.transcript-side\[data-tab="summary"\] \.transcript-content \{ display: none; \}/);
});

test('phone video page bottom bar is Prev, Chat on Claude, Next and the rest sits in the overflow menu', () => {
  assert.match(video, /class="nav-fab nav-chat" onclick="chatOnClaude\(this\)"[^>]*>Chat on Claude</);
  assert.match(video, /id="menuToggle" onclick="toggleHeaderMenu\(event\)"/);
  assert.match(video, /\.header\.menu-open \.header-btns \{ display: grid; \}/);
});

test('summary pane keeps the TL;DR and drops the full transcript', () => {
  const code = video.slice(video.indexOf('    function summarySection('), video.indexOf('    function renderMobileSummary('));
  const context = vm.createContext({});
  vm.runInContext(code, context);
  const markdown = '# Title\n\n**Source:** https://example.com\n\n## TL;DR\nLead\n\n## Summary\n**Bottom line:** Done.\n\n---\n\n## Full Transcript\n\n<details><summary>Expand</summary>\n\nBody\n\n</details>\n';
  const summary = context.summarySection(markdown);
  assert.match(summary, /^## TL;DR/);
  assert.match(summary, /Bottom line/);
  assert.doesNotMatch(summary, /Full Transcript|Body|---/);
  assert.equal(context.summarySection('## The Article\nNo summary'), '');
});
