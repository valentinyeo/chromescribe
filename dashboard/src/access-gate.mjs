export const ACCESS_TEAM_DOMAIN = 'https://vwo-analyzer.cloudflareaccess.com';

const CERTS_URL = `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

let cachedKeys = null;

export async function fetchAccessKeys() {
  if (cachedKeys && cachedKeys.expires > Date.now()) return cachedKeys.keys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const { keys } = await res.json();
  cachedKeys = { keys, expires: Date.now() + 10 * 60 * 1000 };
  return keys;
}

function decodePart(part) {
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

function decodeJson(part) {
  return JSON.parse(new TextDecoder().decode(decodePart(part)));
}

export async function verifyAccessJwt(token, aud, getKeys = fetchAccessKeys, now = Date.now()) {
  if (!aud) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  let header, payload;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    return false;
  }
  if (header.alg !== 'RS256') return false;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) return false;
  if (payload.iss !== ACCESS_TEAM_DOMAIN) return false;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return false;
  const jwk = (await getKeys()).find(key => key.kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey('jwk', jwk, ALGORITHM, false, ['verify']);
  return crypto.subtle.verify(ALGORITHM, key, decodePart(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
}

export async function accessGate(request, env, getKeys = fetchAccessKeys) {
  if (env?.CHRO10_API_GATE !== '1') return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  const allowed = token ? await verifyAccessJwt(token, env.ACCESS_AUD, getKeys).catch(() => false) : false;
  if (allowed) return null;
  return new Response(JSON.stringify({ success: false, error: 'Login required' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
