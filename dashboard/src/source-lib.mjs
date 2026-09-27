export function extractSourceUrl(markdown) {
  const match = markdown.match(/^\*\*Source:\*\*[ \t]+(https?:\/\/[^\s<>]+)[ \t]*\r?$/m);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export async function transcriptSourceResponse(env, id) {
  const row = await env.DB.prepare('SELECT srt_path FROM transcripts WHERE id = ?').bind(id).first();
  const object = row ? await env.TRANSCRIPTS.get(row.srt_path) : null;
  const source = object ? extractSourceUrl(await object.text()) : null;
  return source ? Response.redirect(source, 302) : new Response('Source not found', { status: 404 });
}
