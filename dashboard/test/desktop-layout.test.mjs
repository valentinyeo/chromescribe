import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const home = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const video = readFileSync(new URL('../public/transcript.html', import.meta.url), 'utf8');

function homeContext() {
  const code = [...home.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const context = vm.createContext({
    csTheme: { icon: () => '', label: () => '' }, addEventListener() {},
    document: { addEventListener() {}, querySelectorAll: () => [], getElementById: () => ({ textContent: '', title: '', setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} } }) },
  });
  context.window = context;
  vm.runInContext(code, context);
  context.escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  return context;
}

test('desktop home puts search, add and the overflow menu in the header and drops the sort menu', () => {
  assert.equal((home.match(/id="searchInput"/g) || []).length, 1);
  assert.match(home, /class="search-pill"/);
  assert.match(home, /placeholder="Search transcripts"/);
  assert.match(home, /class="search-hint">\/</);
  assert.match(home, /class="btn btn-primary add-btn"/);
  assert.match(home, /class="overflow" id="headerMenu"/);
  assert.doesNotMatch(home, /id="sortSelect"/);
  assert.doesNotMatch(home, /Newest First/);
});

test('desktop home shows five category chips plus More', () => {
  assert.match(home, /\.category-filters:not\(\.expanded\) \.category-chip:nth-child\(n \+ 6\) \{\s*display: none;/);
  assert.match(home, /label: 'AI'/);
  assert.match(home, /label: 'Health'/);
  assert.match(home, /label: 'Russia'/);
  assert.match(home, /label: 'SEO'/);
  assert.match(home, /btn\.textContent = open \? 'Less' : 'More'/);
});

test('desktop rows show a summary and a read time and keep Open and Delete in the row menu', () => {
  const context = homeContext();
  const row = context.cardHtml({
    id: 7, video_id: 'XDUP63i58ac', title: 'A video', channel: 'Jaymin West',
    category: 'AI', tags: '["one","two"]', word_count: 830, duration_formatted: '16:24',
    created_at: new Date().toISOString(),
  });
  assert.match(row, /class="card-summary" data-summary-id="7"/);
  assert.match(row, /class="card-readtime">4 min read</);
  assert.match(row, /class="category-pill">AI</);
  assert.doesNotMatch(row, /class="tag-pill"/);
  assert.match(row, /class="card-actions">/);
  assert.match(row, /Open original/);
  assert.match(row, /class="js-delete"/);
  assert.doesNotMatch(row, />View</);
  assert.match(context.summaryLine('## TL;DR\nLead line here.\n\n- point [0:29]\n'), /^Lead line here\./);
});

test('desktop home opens the full key list and moves with j and k', () => {
  assert.match(home, /id="shortcuts" class="shortcuts-dialog"/);
  assert.match(home, /<h3>List<\/h3>/);
  assert.match(home, /<h3>Video page<\/h3>/);
  assert.match(home, /function kbSelect\(/);
  assert.match(home, /k === 'j'/);
  assert.match(home, /k === 'k'/);
  assert.match(home, /k === '\?'/);
});

test('desktop video page starts on the summary with the transcript one tab away', () => {
  assert.match(video, /id="transcriptSide" data-tab="summary"/);
  assert.match(video, /\.transcript-side\[data-tab="summary"\] \.transcript-content \{ display: none; \}/);
  assert.match(video, /\.transcript-side\[data-tab="transcript"\] \.mobile-summary \{ display: none; \}/);
  assert.match(video, /class="mobile-tab active" data-tab="summary"/);
  assert.match(video, /class="mobile-tab" data-tab="transcript"/);
  assert.match(video, /id="mobileSummary"/);
});

test('desktop video top bar keeps prev, next, Chat on Claude, Copy and the rest in the overflow menu', () => {
  assert.match(video, /class="btn nav-btn nav-prev desktop-only"/);
  assert.match(video, /class="btn nav-btn nav-next desktop-only"/);
  assert.match(video, /class="btn btn-chat" onclick="chatOnClaude\(this\)"[^>]*>Chat on Claude</);
  assert.match(video, /<button class="btn" onclick="copyText\(this\)">Copy<\/button>/);
  assert.match(video, /class="overflow" id="moreMenu"/);
  assert.match(video, /id="moreToggle"/);
  assert.match(video, /Keyboard shortcuts/);
});
