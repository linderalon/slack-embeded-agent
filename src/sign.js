// Short-lived HMAC-signed links for the avatar embed (Slack loads them in an iframe,
// so the URL is visible to the client and must carry its own proof of access).

import crypto from 'node:crypto';

const FIELDS = ['u', 't', 'exp']; // Kaltura userId, Kaltura threadId (optional), expiry (unix s)

const mac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');
const payload = (path, p) => `${path}?${FIELDS.map((k) => `${k}=${p[k] ?? ''}`).join('&')}`;

/** @returns {string} absolute signed URL */
export function signUrl(baseUrl, path, { userId, threadId, ttlSeconds }, secret, now = Date.now()) {
  const p = { u: userId, t: threadId || '', exp: Math.floor(now / 1000) + ttlSeconds };
  const url = new URL(path, baseUrl);
  for (const k of FIELDS) url.searchParams.set(k, String(p[k]));
  url.searchParams.set('sig', mac(secret, payload(path, p)));
  return url.toString();
}

/** @returns {{ok:true, userId:string, threadId?:string} | {ok:false, reason:string}} */
export function verifyUrl(url, secret, now = Date.now()) {
  const q = url.searchParams;
  const p = { u: q.get('u') || '', t: q.get('t') || '', exp: q.get('exp') || '' };
  const sig = q.get('sig') || '';
  if (!p.u || !p.exp || !sig) return { ok: false, reason: 'missing' };
  if (!/^\d+$/.test(p.exp) || Number(p.exp) < Math.floor(now / 1000)) return { ok: false, reason: 'expired' };
  const want = Buffer.from(mac(secret, payload(url.pathname, p)));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, userId: p.u, threadId: p.t || undefined };
}
