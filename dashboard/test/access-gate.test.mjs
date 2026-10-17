import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accessGate, verifyAccessJwt, ACCESS_TEAM_DOMAIN } from '../src/access-gate.mjs';
import worker from '../src/index.ts';

const ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
const pair = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
const getKeys = async () => [jwk];
const ACCESS_AUD = 'test-audience';
const ON = { CHRO10_API_GATE: '1', ACCESS_AUD };

const b64 = bytes => Buffer.from(bytes).toString('base64url');
async function sign(payload, { key = pair.privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const head = b64(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = b64(JSON.stringify(payload));
  const sig = await crypto.subtle.sign(ALGORITHM, key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(new Uint8Array(sig))}`;
}
const good = () => ({ aud: [ACCESS_AUD], iss: ACCESS_TEAM_DOMAIN, exp: Math.floor(Date.now() / 1000) + 600 });
const request = token => new Request('https://chromescribe.yeoux.net/api/transcripts', token ? { headers: { 'Cf-Access-Jwt-Assertion': token } } : {});

test('switch off lets every request through', async () => {
  assert.equal(await accessGate(request(), {}, getKeys), null);
  assert.equal(await accessGate(request(), { CHRO10_API_GATE: '0' }, getKeys), null);
});

test('switch on refuses a request without a login', async () => {
  const res = await accessGate(request(), ON, getKeys);
  assert.equal(res.status, 401);
});

test('switch on accepts a valid Access login', async () => {
  assert.equal(await accessGate(request(await sign(good())), ON, getKeys), null);
});

test('forged, expired, foreign or malformed logins are refused', async () => {
  const cases = [
    await sign(good(), { key: other.privateKey }),
    await sign({ ...good(), exp: Math.floor(Date.now() / 1000) - 1 }),
    await sign({ ...good(), aud: ['someone-else'] }),
    await sign({ ...good(), iss: 'https://evil.cloudflareaccess.com' }),
    await sign(good(), { kid: 'unknown' }),
    await sign(good(), { alg: 'none' }),
    'not.a.jwt',
    'garbage',
  ];
  for (const token of cases) {
    assert.equal(await verifyAccessJwt(token, ACCESS_AUD, getKeys), false, token.slice(0, 40));
    assert.equal((await accessGate(request(token), ON, getKeys)).status, 401);
  }
});

test('missing audience setting refuses even a valid login', async () => {
  const res = await accessGate(request(await sign(good())), { CHRO10_API_GATE: '1' }, getKeys);
  assert.equal(res.status, 401);
});

test('certificate fetch failure refuses instead of letting through', async () => {
  const res = await accessGate(request(await sign(good())), ON, async () => { throw new Error('down'); });
  assert.equal(res.status, 401);
});

test('worker refuses API calls without a login when the switch is on, report pages stay reachable', async () => {
  const res = await worker.fetch(request(), ON);
  assert.equal(res.status, 401);
  const report = await worker.fetch(new Request('https://chromescribe.yeoux.net/reports/abcdefabcdef'), {
    ...ON, TRANSCRIPTS: { get: async () => null },
  });
  assert.equal(report.status, 404);
});

test('production config ships the switch', () => {
  assert.match(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'), /^CHRO10_API_GATE = "[01]"$/m);
});
