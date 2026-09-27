/**
 * Strict shared URL validation + race-free enqueue for the Android queue.
 *
 * Kept as a plain .mjs module (no TypeScript syntax) so the same code is
 * imported by the Worker and exercised directly by Node's built-in test
 * runner. Queue parsing validates each platform before enqueueing.
 */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Exact host allow-list. No subdomains other than the ones YouTube actually
// serves watch/share links from, and nothing that merely *contains* one of
// these strings (e.g. youtube.com.evil.tld).
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
]);

/**
 * Parse a URL that is safe to hand to the box running yt-dlp.
 *
 * Only https, only the allow-listed hosts, only watch/shorts/live/youtu.be
 * shapes, and only an 11-character video id. Always normalises to a canonical
 * https://www.youtube.com/watch?v=... so downstream tooling never sees an
 * attacker-controlled path or query.
 *
 * @param {unknown} rawUrl
 * @returns {{platform: 'youtube', id: string, prefixedId: string, url: string} | null}
 */
export function parseStrictYouTubeUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }

  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  // `new URL` normalises the default 443 port to '', so any non-empty port is
  // an explicit non-standard port and gets rejected.
  if (u.port) return null;

  const host = u.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/').filter(Boolean)[0] || null;
  } else if (u.pathname === '/watch') {
    id = u.searchParams.get('v');
  } else if (u.pathname.startsWith('/shorts/')) {
    id = u.pathname.slice('/shorts/'.length).split('/')[0] || null;
  } else if (u.pathname.startsWith('/live/')) {
    id = u.pathname.slice('/live/'.length).split('/')[0] || null;
  }

  if (!id || !VIDEO_ID_RE.test(id)) return null;

  return {
    platform: 'youtube',
    id,
    prefixedId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

/**
 * Enqueue a shared URL against a D1-like database.
 *
 * Relies on the partial unique index `idx_queue_pending_video`
 * (queue(video_id) WHERE status = 'pending') so two concurrent POSTs cannot
 * both insert a pending row. The INSERT ... ON CONFLICT DO NOTHING is atomic;
 * the follow-up SELECT returns the surviving row either way.
 *
 * @param {any} db D1Database-compatible handle (`prepare().bind().first()/run()`)
 * @param {unknown} rawUrl
 * @returns {Promise<{status: number, data?: any, error?: string}>}
 */
export async function enqueueSharedUrl(db, rawUrl) {
  const parsed = parseSharedUrl(rawUrl);
  if (!parsed) return { status: 400, error: 'Unsupported URL' };

  // Already transcribed? Tell the app to open it instead of queueing.
  const existing = await db
    .prepare('SELECT id FROM transcripts WHERE video_id = ?')
    .bind(parsed.prefixedId)
    .first();
  if (existing) {
    return { status: 200, data: { queued: false, transcript_id: existing.id, platform: parsed.platform } };
  }

  const inserted = await db
    .prepare(
      "INSERT INTO queue (url, video_id, status) VALUES (?, ?, 'pending') " +
        "ON CONFLICT(video_id) WHERE status = 'pending' DO NOTHING"
    )
    .bind(parsed.url, parsed.prefixedId)
    .run();

  const row = await db
    .prepare(
      "SELECT id FROM queue WHERE video_id = ? AND status = 'pending' " +
        'ORDER BY id ASC LIMIT 1'
    )
    .bind(parsed.prefixedId)
    .first();
  if (!row) return { status: 500, error: 'Failed to enqueue URL' };

  const changes = inserted && inserted.meta ? inserted.meta.changes || 0 : 0;
  const data = { queued: true, id: row.id, platform: parsed.platform };
  if (changes === 0) data.duplicate = true;
  return { status: 200, data };
}

// Stable 8-char hex hash (djb2), shared with transcript ingestion.
export function hashUrl(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function parseSharedUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const value = rawUrl.trim();
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname;
  if (YOUTUBE_HOSTS.has(host)) return parseStrictYouTubeUrl(rawUrl);
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return null;
  const full = ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'];
  const short = ['vm.tiktok.com', 'vt.tiktok.com'];
  if (full.includes(host) || short.includes(host)) {
    if (u.port) return null;
    if (short.includes(host)) {
      const match = u.pathname.match(/^\/([A-Za-z0-9]+)\/?$/);
      return match ? { platform: 'tiktok', prefixedId: `tiktok-short:${match[1]}`, url: `https://${host}/${match[1]}/` } : null;
    }
    const match = u.pathname.match(/^\/@([A-Za-z0-9_.]+)\/video\/(\d{15,21})\/?$/);
    return match ? { platform: 'tiktok', prefixedId: `tiktok:${match[2]}`, url: `https://www.tiktok.com/@${match[1]}/video/${match[2]}` } : null;
  }
  // Reject platform look-alikes and unsupported platform subdomains, rather
  // than accepting them through the article fallback.
  if (/(?:youtube\.com|youtu\.be|tiktok\.com)/i.test(host)) return null;
  const bareHost = host.replace(/\.$/, '');
  if (value.length > 2048 || host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal)$/.test(bareHost)) return null;
  // Preserve the input spelling for parity with transcript ingestion.
  const url = value.split('#')[0];
  return { platform: 'article', prefixedId: `article:${hashUrl(url)}`, url };
}

export async function listPendingQueue(db, params) {
  const values = params.getAll('platforms');
  const platforms = values.length ? values[0].split(',') : null;
  if (values.length > 1 || platforms?.some(p => !['youtube', 'article', 'tiktok'].includes(p))) {
    return { status: 400, error: 'Invalid platforms parameter' };
  }
  const platformSql = "CASE WHEN video_id GLOB 'tiktok:*' OR video_id GLOB 'tiktok-short:*' THEN 'tiktok' WHEN video_id GLOB 'article:*' THEN 'article' ELSE 'youtube' END";
  let query = db.prepare("SELECT id, url, video_id FROM queue WHERE status = 'pending'" +
    (platforms ? ` AND (${platformSql}) IN (${platforms.map(() => '?').join(',')})` : '') +
    ' ORDER BY id ASC LIMIT 10');
  if (platforms) query = query.bind(...platforms);
  const { results } = await query.all();
  return { status: 200, data: results };
}
