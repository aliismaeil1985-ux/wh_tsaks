/*
 * WH Tasks — Web Push sender (Cloudflare Pages Function, served at /api/push).
 *
 * The platform calls this endpoint when it creates a notification for a user; the
 * function encrypts the message (RFC 8291, aes128gcm) and signs it with VAPID
 * (RFC 8292), then hands it to the browser's push service (Google / Apple / Mozilla),
 * which delivers it to the phone even when the platform is closed.
 *
 * Required project secrets (Cloudflare → Pages → wh-tsaks → Settings → Variables):
 *   VAPID_PRIVATE_JWK  JSON Web Key of the P-256 private key (kept secret, never in Git)
 *   VAPID_PUBLIC       base64url public key (the same key the platform subscribes with)
 *   VAPID_SUBJECT      contact for push services, e.g. "https://wh-tsaks.pages.dev"
 */

const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?wh-tsaks\.pages\.dev$/;
const MAX_SUBS = 10;
const enc = new TextEncoder();

function b64uToBytes(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/* RFC 8291 — encrypt one payload for one subscription. `fixed` is only for test vectors. */
export async function encryptPayload(sub, plaintext, fixed) {
  const uaPublic = b64uToBytes(sub.keys.p256dh);
  const authSecret = b64uToBytes(sub.keys.auth);
  const asKeys = fixed && fixed.asKeys
    ? fixed.asKeys
    : await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = fixed && fixed.salt ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const data = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;
  const padded = concat(data, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));
  const rs = 4096;
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]), new Uint8Array([asPublic.length]), asPublic);
  return concat(header, cipher);
}

/* RFC 8292 — VAPID JWT (ES256) for the push service origin. */
export async function vapidJwt(audience, subject, privateJwk) {
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + claims));
  return header + '.' + claims + '.' + bytesToB64u(sig);
}

async function sendOne(sub, payload, env, jwk) {
  let url;
  try { url = new URL(sub.endpoint); } catch (e) { return { endpoint: sub && sub.endpoint, status: 400, error: 'bad-endpoint' }; }
  if (url.protocol !== 'https:') return { endpoint: sub.endpoint, status: 400, error: 'bad-endpoint' };
  try {
    const body = await encryptPayload(sub, payload);
    const jwt = await vapidJwt(url.origin, String(env.VAPID_SUBJECT || 'https://wh-tsaks.pages.dev').trim(), jwk);
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'high',
        Authorization: 'vapid t=' + jwt + ', k=' + String(env.VAPID_PUBLIC).trim()
      },
      body
    });
    return { endpoint: sub.endpoint, status: r.status };
  } catch (e) {
    return { endpoint: sub.endpoint, status: 0, error: String(e && e.message || e) };
  }
}

function cors(origin) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origin && ALLOWED_ORIGIN.test(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  return h;
}
const json = (obj, status, origin) => new Response(JSON.stringify(obj), { status, headers: cors(origin) });

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: cors(request.headers.get('Origin')) });
}

export async function onRequestGet({ request, env }) {
  /* health check: tells the platform whether push is configured (never returns the private key) */
  return json({ ok: true, configured: !!(env.VAPID_PRIVATE_JWK && env.VAPID_PUBLIC), publicKey: env.VAPID_PUBLIC || null }, 200, request.headers.get('Origin'));
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGIN.test(origin)) return json({ ok: false, error: 'origin' }, 403, origin);
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC) return json({ ok: false, error: 'not-configured' }, 503, origin);
  let input;
  try { input = await request.json(); } catch (e) { return json({ ok: false, error: 'bad-json' }, 400, origin); }
  const subs = (Array.isArray(input && input.subs) ? input.subs : [])
    .filter(s => s && typeof s.endpoint === 'string' && s.keys && s.keys.p256dh && s.keys.auth)
    .slice(0, MAX_SUBS);
  if (!subs.length) return json({ ok: false, error: 'no-subs' }, 400, origin);
  const payload = JSON.stringify({
    title: String(input.title || 'مهام المستودعات').slice(0, 120),
    body: String(input.body || '').slice(0, 400),
    url: String(input.url || '/').slice(0, 300),
    tag: String(input.tag || '').slice(0, 64),
    taskId: input.taskId == null ? null : String(input.taskId).slice(0, 40)
  });
  let jwk;
  try { jwk = JSON.parse(env.VAPID_PRIVATE_JWK); } catch (e) { return json({ ok: false, error: 'bad-key' }, 500, origin); }
  const results = await Promise.all(subs.map(s => sendOne(s, payload, env, jwk)));
  return json({ ok: true, results }, 200, origin);
}
