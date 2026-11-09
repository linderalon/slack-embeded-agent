// Short-lived HMAC-signed links. Slack loads the Genie page in an iframe from a URL the
// client can see, so the URL itself must prove who it was issued to and until when.

import crypto from 'node:crypto';

const mac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');
const payload = (path, u, exp) => `${path}?u=${u}&exp=${exp}`;

/** @returns {string} absolute signed URL for `path` on `baseUrl`, valid `ttlSeconds` */
export function signUrl(baseUrl, path, { userId, ttlSeconds, extra = {} }, secret, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const url = new URL(path, baseUrl);
  url.searchParams.set('u', userId);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('sig', mac(secret, payload(url.pathname, userId, exp)));
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v); // unsigned display options
  return url.toString();
}

/** @returns {{ok:true, userId:string} | {ok:false, reason:string}} */
export function verifyUrl(url, secret, now = Date.now()) {
  const q = url.searchParams;
  const u = q.get('u') || '';
  const exp = q.get('exp') || '';
  const sig = q.get('sig') || '';
  if (!u || !exp || !sig) return { ok: false, reason: 'missing' };
  if (!/^[\w.@:-]{1,128}$/.test(u)) return { ok: false, reason: 'bad_user' };
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(now / 1000)) return { ok: false, reason: 'expired' };
  const want = Buffer.from(mac(secret, payload(url.pathname, u, exp)));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, userId: u };
}
