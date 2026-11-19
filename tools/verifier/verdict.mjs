import { readFileSync } from 'node:fs';

export function verdictFrom(jsonl) {
  const events = jsonl.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const messages = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant');
  const content = messages.at(-1)?.message?.content || [];
  const text = content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
  const match = text.match(/^(PASS\+NOTES|PASS|FAIL)\s*$/m);
  return { verdict: match ? match[1] : null, text };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = verdictFrom(readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(JSON.stringify(result));
  process.exit(result.verdict ? 0 : 2);
}
