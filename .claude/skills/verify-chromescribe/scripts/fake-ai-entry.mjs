import worker from '../../../../dashboard/src/index.ts';

const TRANSCRIPTION_MODEL = '@cf/openai/whisper-large-v3-turbo';
const ANALYSIS_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const LOG_PATH = '/__verify/ai-calls';
const SLOW_MARKER = '[[verify:slow-summary]]';
const SLOW_MS = 3000;

const calls = [];

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const audioBytes = input => {
  const audio = typeof input?.audio === 'string' ? input.audio : '';
  const padding = audio.endsWith('==') ? 2 : audio.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((audio.length * 3) / 4) - padding);
};

const promptText = input => {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  return messages.map(message => String(message?.content ?? '')).join('\n');
};

const whisper = input => {
  const bytes = audioBytes(input);
  const lines = [
    'The local verification fake transcribed this audio.',
    `The upload carried ${bytes} bytes.`,
    'Every line is deterministic so the journey can compare it.'
  ];
  const segments = lines.map((text, index) => ({ start: index * 4, end: index * 4 + 3, text: ` ${text}` }));
  const text = lines.join(' ');
  return { text, word_count: text.split(/\s+/).filter(Boolean).length, segments };
};

const summary = () => [
  '## TL;DR',
  '',
  'The local verification fake wrote this summary, so the real handler ran end to end.',
  '',
  '- **Fake AI**: every word here came from the verify skill, not Workers AI.',
  '- **Real handler**: the Worker stored the row, the markdown and the category.',
  '',
  '---',
  '',
  '## Summary',
  '',
  '**Bottom line:** the journey reached the fake AI through the real transcribe handler.',
  '',
  '## Talking Points',
  '',
  '- [0:00] The upload arrives as base64 audio.',
  '- [0:04] The fake returns transcript segments.',
  '- [0:08] The fake returns this summary.'
].join('\n');

const classification = input => {
  const forbidden = /FORBIDDEN category: "([^"]+)"/.exec(promptText(input));
  const category = forbidden && forbidden[1].toLowerCase() === 'journey verification' ? 'Local Verification' : 'Journey Verification';
  return JSON.stringify({ category, tags: ['fake ai', 'local verification', 'add video'] });
};

const fakeAI = {
  async run(model, input = {}, options = {}) {
    const transcription = model === TRANSCRIPTION_MODEL;
    const prompt = transcription ? '' : promptText(input);
    calls.push({
      sequence: calls.length + 1,
      model,
      task: options?.gateway?.metadata?.task || '',
      input_unit: transcription ? 'audio_bytes' : 'prompt_chars',
      input_size: transcription ? audioBytes(input) : prompt.length,
    });
    if (transcription) return whisper(input);
    if (model === ANALYSIS_MODEL) {
      if (/Classify the content/.test(prompt)) return { response: classification(input) };
      if (prompt.includes(SLOW_MARKER)) await new Promise(done => setTimeout(done, SLOW_MS));
      return { response: summary() };
    }
    throw new Error(`The local verification fake AI has no answer for ${model}`);
  },
};

const withFakeAI = env => ({ ...env, AI: fakeAI });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === LOG_PATH) {
      if (request.method === 'DELETE') {
        calls.length = 0;
        return json({ cleared: true, calls: [] });
      }
      if (request.method !== 'GET') return json({ error: 'Use GET or DELETE' }, 405);
      return json({ calls });
    }
    return worker.fetch(request, withFakeAI(env), ctx);
  },
  ...(typeof worker.scheduled === 'function'
    ? {
      async scheduled(controller, env, ctx) {
        return worker.scheduled(controller, withFakeAI(env), ctx);
      },
    }
    : {}),
};
