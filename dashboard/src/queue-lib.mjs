
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
]);

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

export async function enqueueSharedUrl(db, rawUrl) {
  const parsed = parseSharedUrl(rawUrl);
  if (!parsed) return { status: 400, error: 'Unsupported URL' };

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
    const shared = u.pathname.match(/^\/t\/([A-Za-z0-9]+)\/?$/);
    if (shared) return { platform: 'tiktok', prefixedId: `tiktok-short:${shared[1]}`, url: `https://www.tiktok.com/t/${shared[1]}/` };
    const match = u.pathname.match(/^\/@([A-Za-z0-9_.]+)\/video\/(\d{15,21})\/?$/);
    return match ? { platform: 'tiktok', prefixedId: `tiktok:${match[2]}`, url: `https://www.tiktok.com/@${match[1]}/video/${match[2]}` } : null;
  }
  if (/(?:youtube\.com|youtu\.be|tiktok\.com)/i.test(host)) return null;
  const bareHost = host.replace(/\.$/, '');
  if (value.length > 2048 || host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal)$/.test(bareHost)) return null;
  const url = value.split('#')[0];
  return { platform: 'article', prefixedId: `article:${hashUrl(url)}`, url };
}

const QUEUE_LEASE_SECONDS = 30 * 60;
const QUEUE_MAX_ATTEMPTS = 2;
const DRAINER_STOPPED_ERROR = 'Drainer stopped before finishing';
const STALE_CLAIM = "status = 'processing' AND started_at IS NOT NULL AND " +
  `started_at <= datetime('now', '-${QUEUE_LEASE_SECONDS} seconds')`;
const RECLAIM_CLAIM = "UPDATE queue SET status = 'pending', attempts = COALESCE(attempts, 0) + 1, " +
  'finished_at = NULL, error = NULL ' +
  "WHERE id = ? AND status = 'processing' AND started_at = ? " +
  'AND NOT EXISTS (SELECT 1 FROM queue other ' +
  "WHERE other.video_id = queue.video_id AND other.status = 'pending')";
const FAIL_CLAIM = "UPDATE queue SET status = 'failed', finished_at = CURRENT_TIMESTAMP, error = ? " +
  "WHERE id = ? AND status = 'processing' AND started_at = ?";

async function recoverStaleClaims(db) {
  const { results } = await db
    .prepare(`SELECT id, started_at, COALESCE(attempts, 0) AS attempts FROM queue WHERE ${STALE_CLAIM} LIMIT 25`)
    .all();
  for (const claim of results) {
    if (claim.attempts >= QUEUE_MAX_ATTEMPTS) {
      await db.prepare(FAIL_CLAIM)
        .bind(`${DRAINER_STOPPED_ERROR} (attempt ${claim.attempts} of ${QUEUE_MAX_ATTEMPTS})`, claim.id, claim.started_at)
        .run();
    } else {
      await db.prepare(RECLAIM_CLAIM).bind(claim.id, claim.started_at).run();
    }
  }
}

export async function listPendingQueue(db, params) {
  const values = params.getAll('platforms');
  const platforms = values.length ? values[0].split(',') : null;
  if (values.length > 1 || platforms?.some(p => !['youtube', 'article', 'tiktok'].includes(p))) {
    return { status: 400, error: 'Invalid platforms parameter' };
  }
  await ensureQueue(db);
  await recoverStaleClaims(db);
  const platformSql = "CASE WHEN video_id GLOB 'tiktok:*' OR video_id GLOB 'tiktok-short:*' THEN 'tiktok' WHEN video_id GLOB 'article:*' THEN 'article' ELSE 'youtube' END";
  let query = db.prepare("SELECT id, url, video_id FROM queue WHERE status = 'pending'" +
    (platforms ? ` AND (${platformSql}) IN (${platforms.map(() => '?').join(',')})` : '') +
    ' ORDER BY id ASC LIMIT 10');
  if (platforms) query = query.bind(...platforms);
  const { results } = await query.all();
  return { status: 200, data: results };
}

const queueReady = new WeakMap();

export async function ensureQueue(db) {
  let ready = queueReady.get(db);
  if (!ready) {
    ready = (async () => {
      for (const [name, type] of [
        ['started_at', 'DATETIME'], ['finished_at', 'DATETIME'], ['error', 'TEXT'],
        ['attempts', 'INTEGER DEFAULT 0'], ['transcript_id', 'INTEGER'],
      ]) {
        try {
          await db.prepare(`ALTER TABLE queue ADD COLUMN ${name} ${type}`).run();
        } catch (err) {
          if (!(err instanceof Error) || !new RegExp(`duplicate column name:\\s*${name}\\b`, 'i').test(err.message)) throw err;
        }
      }
    })().catch(err => {
      queueReady.delete(db);
      throw err;
    });
    queueReady.set(db, ready);
  }
  await ready;
}

export async function listAllQueue(db, params) {
  const limits = params.getAll('limit');
  const limit = limits[0] ?? '200';
  if (limits.length > 1 || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 1000) {
    return { status: 400, error: 'limit must be between 1 and 1000' };
  }
  await ensureQueue(db);
  const { results } = await db.prepare(`SELECT q.id, q.url, q.video_id, q.status, q.created_at,
    q.started_at, q.finished_at, q.error, q.attempts, t.title, t.channel,
    COALESCE(q.transcript_id, t.id) AS transcript_id
    FROM queue q LEFT JOIN transcripts t ON t.video_id = q.video_id
    ORDER BY q.created_at DESC, q.id DESC LIMIT ?`).bind(Number(limit)).all();
  return { status: 200, data: results };
}

export async function updateQueue(db, id, body) {
  if (!body || !['processing', 'done', 'failed', 'pending'].includes(body.status)) {
    return { status: 400, error: 'status must be processing, done, failed or pending' };
  }
  if (body.error !== undefined && typeof body.error !== 'string') {
    return { status: 400, error: 'error must be a string' };
  }
  if (body.transcript_id !== undefined && (!Number.isSafeInteger(body.transcript_id) || body.transcript_id < 1)) {
    return { status: 400, error: 'transcript_id must be a positive integer' };
  }
  await ensureQueue(db);
  const row = await db.prepare('SELECT status FROM queue WHERE id = ?').bind(id).first();
  if (!row) return { status: 404, error: 'Queue row not found' };
  const status = body.status;
  const fields = ['status = ?'];
  const values = [status];
  if (status === 'processing') {
    fields.push('started_at = CURRENT_TIMESTAMP', 'attempts = COALESCE(attempts, 0) + 1', 'finished_at = NULL', 'error = NULL');
  } else if (status === 'pending') {
    fields.push('error = NULL', 'finished_at = NULL');
  } else {
    fields.push('finished_at = CURRENT_TIMESTAMP');
  }
  if (body.error !== undefined && status !== 'pending') {
    fields.push('error = ?');
    values.push(body.error.trim().slice(0, 500));
  }
  if (body.transcript_id !== undefined) {
    fields.push('transcript_id = ?');
    values.push(body.transcript_id);
  }
  const guard = status === 'pending' ? " AND status = 'failed'" : status === 'processing' ? " AND status = 'pending'" : '';
  try {
    const result = await db.prepare(`UPDATE queue SET ${fields.join(', ')} WHERE id = ?${guard}`).bind(...values, id).run();
    if (!result.meta.changes) return { status: 409, error: status === 'pending' ? 'Only failed rows can be retried' : 'Row is no longer pending' };
  } catch (err) {
    if (status !== 'pending' || !(err instanceof Error) || !/UNIQUE constraint failed:\s*queue\.video_id\b/i.test(err.message)) throw err;
    return { status: 409, error: 'This video already has a pending row' };
  }
  return { status: 200, data: { id, status } };
}

export async function deleteQueue(db, id) {
  const result = await db.prepare("DELETE FROM queue WHERE id = ? AND status != 'processing'").bind(id).run();
  if (result.meta.changes) return { status: 200, data: { id, deleted: true } };
  const row = await db.prepare('SELECT id FROM queue WHERE id = ?').bind(id).first();
  return row ? { status: 409, error: 'Cannot remove a processing row' } : { status: 404, error: 'Queue row not found' };
}
