import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';

const summary = '## TL;DR\nLead\n- **Point**: Detail.\n## Summary\n**Bottom line:** Detail.\n## Talking Points\n- Point';
const stored = (id) => `# Transcript ${id}\n\n## Full Transcript\none two three four five six\n`;
const summarized = '# Transcript\n\n## TL;DR\nLead\n## Summary\nBody\n\n## Full Transcript\none two three\n';

function envFor({ candidates, bodies = {}, missing = [], fails = [] }) {
  const writes = [];
  const updates = [];
  const aiCalls = [];
  const queries = [];
  const rows = new Map(candidates.map(row => [String(row.id), row]));
  const store = new Map(Object.entries(bodies));
  const db = {
    prepare(query) {
      const statement = {
        query,
        args: [],
        bind(...args) {
          statement.args = args;
          return statement;
        },
        all: async () => {
          if (query.includes('created_at >=')) return { results: candidates };
          if (query.includes('SELECT DISTINCT category')) return { results: [] };
          return { results: [] };
        },
        first: async () => rows.get(String(statement.args[0])) || null,
        run: async () => {
          updates.push({ query, args: statement.args });
          return { meta: {} };
        },
      };
      queries.push(statement);
      return statement;
    },
  };
  const transcripts = {
    get: async (path) => (missing.includes(path) ? null : { text: async () => store.get(path) ?? '' }),
    put: async (path, text) => {
      writes.push(path);
      store.set(path, text);
    },
  };
  const ai = {
    run: async (_model, options) => {
      const prompt = (options?.messages || []).map(message => String(message?.content ?? '')).join('\n');
      aiCalls.push(prompt);
      if (/Classify the content/.test(prompt)) return { response: '{"category":"Repaired","tags":["repair"]}' };
      if (fails.some(marker => prompt.includes(marker))) throw new Error('Workers AI timed out');
      return { response: summary };
    },
  };
  return { env: { DB: db, TRANSCRIPTS: transcripts, AI: ai }, writes, updates, aiCalls, queries, store };
}

function recentRows(count) {
  return Array.from({ length: count }, (_, index) => ({ id: String(100 + index), srt_path: `content/${100 + index}.md`, video_id: 'video', duration: 60 }));
}

function bodiesFor(rows) {
  return Object.fromEntries(rows.map(row => [row.srt_path, stored(row.id)]));
}

test('the schedule repairs recent transcripts that carry no TL;DR', async () => {
  const candidates = recentRows(7);
  const context = envFor({ candidates, bodies: bodiesFor(candidates) });

  await worker.scheduled({ cron: '23 4 * * *' }, context.env);

  assert.equal(context.writes.length, 5);
  for (const path of context.writes) assert.match(context.store.get(path), /^## TL;DR$/m);
  const window = context.queries.find(statement => statement.query.includes('created_at >='));
  assert.deepEqual(window.args, ['-14 days', 200]);
  assert.equal(context.aiCalls.filter(prompt => !/Classify the content/.test(prompt)).length, 5);
});

test('already summarized and unreadable transcripts are left alone', async () => {
  const candidates = [
    { id: '1', srt_path: 'content/1.md', video_id: 'video', duration: 60 },
    { id: '2', srt_path: 'content/2.md', video_id: 'video', duration: 60 },
    { id: '3', srt_path: 'content/3.md', video_id: 'video', duration: 60 },
  ];
  const context = envFor({
    candidates,
    bodies: { 'content/1.md': summarized, 'content/2.md': summarized },
    missing: ['content/3.md'],
  });

  await worker.scheduled({}, context.env);

  assert.deepEqual(context.writes, []);
  assert.equal(context.aiCalls.length, 0);
});

test('one failed repair does not stop the others and never rejects the schedule', async () => {
  const candidates = [
    { id: '11', srt_path: 'content/11.md', video_id: 'video', duration: 60 },
    { id: '12', srt_path: 'content/12.md', video_id: 'video', duration: 60 },
  ];
  const bodies = { 'content/11.md': stored('11'), 'content/12.md': `${stored('12')}\nBOOM\n` };
  const context = envFor({ candidates, bodies, fails: ['BOOM'] });

  await worker.scheduled({}, context.env);

  assert.deepEqual(context.writes, ['content/11.md']);
  assert.equal(context.store.get('content/12.md'), bodies['content/12.md']);
});

test('an empty recent window writes nothing', async () => {
  const context = envFor({ candidates: [] });

  await worker.scheduled({}, context.env);

  assert.deepEqual(context.writes, []);
  assert.equal(context.aiCalls.length, 0);
});
