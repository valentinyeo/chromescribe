const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HANDLE_RE = /^@[\p{L}\p{N}_][\p{L}\p{N}_.-]{1,28}[\p{L}\p{N}_]$/u;
const TIKTOK_HANDLE_RE = /^@[A-Za-z0-9_][A-Za-z0-9_.]{0,23}$/;

export function parseChannelInput(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value || value.length > 512 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  if (CHANNEL_ID_RE.test(value)) return { platform: 'youtube', id: value, handle: null };
  if (YOUTUBE_HANDLE_RE.test(value)) return { platform: 'youtube', id: null, handle: value };
  if (value.startsWith('tiktok:')) {
    const handle = value.slice(7).toLowerCase();
    return TIKTOK_HANDLE_RE.test(handle) && !handle.endsWith('.') ?
      { platform: 'tiktok', id: `tiktok:${handle}`, handle } : null;
  }

  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  // Reject paths that URL would silently normalize, such as /junk/../@handle.
  if (/\/(?:\.|%2e){1,2}(?:\/|$)/i.test(value)) return null;
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    const match = path.match(/^\/(channel\/(UC[A-Za-z0-9_-]{22})|@[^/]+)(?:\/videos)?\/?$/);
    if (!match) return null;
    if (match[2]) return { platform: 'youtube', id: match[2], handle: null };
    return YOUTUBE_HANDLE_RE.test(match[1]) ? { platform: 'youtube', id: null, handle: match[1] } : null;
  }
  if (['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(url.hostname)) {
    const match = path.match(/^\/(@[^/]+)\/?$/);
    if (!match) return null;
    return parseChannelInput(`tiktok:${match[1]}`);
  }
  return null;
}
