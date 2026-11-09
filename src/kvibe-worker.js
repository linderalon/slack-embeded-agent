// Hosted avatar page for Slack (deployed to K-Vibe as kvibe/src/index.js by scripts/build-kvibe.mjs).
// Same job as src/embed.js, on a domain Slack accepts for inline video blocks:
//   GET /embed/avatar?u&t&exp&sig  ->  verify the signed link, mint the user's Kaltura agent token,
//                                       call appInit, return the avatar page.
// Settings (K-Vibe env): KALTURA_PARTNER_ID, KALTURA_ADMIN_SECRET, KALTURA_AGENT_ID, KALTURA_CONFIG_ID,
// EMBED_SIGNING_SECRET (must match the Slack app's), optional KALTURA_REGION ('eu' hosts), TOKEN_TTL_SECONDS.

import { FRAME_ANCESTORS, avatarPage, errorPage } from './avatar-page.js';

const AVATAR_PATH = '/embed/avatar';
const SDK_URL = 'https://cdn.jsdelivr.net/gh/kaltura/intelligent-agents-sdk@v1.37.0/src/experience/index.js';
const HOSTS = {
  us: { ovp: 'https://www.kaltura.com/api_v3', agentic: 'https://api.avatar.us.kaltura.ai/v1' },
  eu: { ovp: 'https://api.frp2.ovp.kaltura.com/api_v3', agentic: 'https://api.avatar.eu.kaltura.ai/v1' },
};

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Same scheme as src/sign.js: HMAC-SHA256 over "<path>?u=..&t=..&exp=..", base64url. */
async function verify(url, secret) {
  const q = url.searchParams;
  const p = { u: q.get('u') || '', t: q.get('t') || '', exp: q.get('exp') || '' };
  const sig = q.get('sig') || '';
  if (!p.u || !p.exp || !sig) return { ok: false, reason: 'missing' };
  if (!/^\d+$/.test(p.exp) || Number(p.exp) < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${url.pathname}?u=${p.u}&t=${p.t}&exp=${p.exp}`)));
  if (want.length !== sig.length) return { ok: false, reason: 'bad_signature' };
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { ok: true, userId: p.u, threadId: p.t || undefined } : { ok: false, reason: 'bad_signature' };
}

/** Per-user agent token, the same privileges as the SDK's sessions.createAgentToken (a user session). */
async function agentToken(env, hosts, userId) {
  const privileges = `agentid:${env.KALTURA_AGENT_ID},geniegpcid:${env.KALTURA_CONFIG_ID},setrole:PLAYBACK_BASE_ROLE`;
  const form = new URLSearchParams({
    format: '1', secret: env.KALTURA_ADMIN_SECRET, partnerId: String(env.KALTURA_PARTNER_ID),
    type: '0', expiry: String(env.TOKEN_TTL_SECONDS || 3600), privileges, userId,
  });
  const res = await fetch(`${hosts.ovp}/service/session/action/start`, { method: 'POST', body: form });
  const data = await res.json().catch(() => null);
  const ks = typeof data === 'string' ? data : data?.ks;
  if (!res.ok || typeof ks !== 'string' || !ks.startsWith('djJ8')) throw new Error(`session start failed (${res.status})`);
  return ks;
}

async function appInit(hosts, ks) {
  const res = await fetch(`${hosts.agentic}/application/appInit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `KS ${ks}` }, body: '{}',
  });
  if (!res.ok) throw new Error(`appInit failed (${res.status})`);
  const init = await res.json();
  return { ks: init.ks || ks, conversationManagerUrl: init.conversationManagerUrl, srsBaseUrl: init.srsBaseUrl, turnServerUrl: init.turnServerUrl };
}

const html = (status, body, extra = {}) => new Response(body, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': FRAME_ANCESTORS, ...extra },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    if (url.pathname === '/healthz' || url.pathname === '/') return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
    if (url.pathname !== AVATAR_PATH) return new Response('Not found', { status: 404 });

    const missing = ['KALTURA_PARTNER_ID', 'KALTURA_ADMIN_SECRET', 'KALTURA_AGENT_ID', 'KALTURA_CONFIG_ID', 'EMBED_SIGNING_SECRET'].filter((k) => !env[k]);
    if (missing.length) return html(500, errorPage('The avatar is not configured yet.'));

    const v = await verify(url, env.EMBED_SIGNING_SECRET);
    if (!v.ok) {
      return html(403, errorPage(v.reason === 'expired'
        ? 'This link has expired. Click "Talk to the avatar" in Slack again to get a fresh one.'
        : 'This link is not valid.'));
    }
    try {
      const hosts = HOSTS[env.KALTURA_REGION === 'eu' || env.KALTURA_REGION === 'frp2' ? 'eu' : 'us'];
      const init = await appInit(hosts, await agentToken(env, hosts, v.userId));
      // Where to report the transcript: the Slack app's own host (lb) + its log key (lk).
      const lb = url.searchParams.get('lb') || '';
      const lk = url.searchParams.get('lk') || '';
      const logUrl = /^https:\/\/[a-z0-9.-]+$/i.test(lb) && /^[\w-]{10,400}\.[\w-]{10,64}$/.test(lk) ? `${lb}/api/log?k=${encodeURIComponent(lk)}` : null;
      return html(200, avatarPage({ init, threadId: v.threadId, region: env.KALTURA_REGION || null, selfUrl: url.pathname + url.search, sdkUrl: SDK_URL, logUrl }), {
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'microphone=(self), camera=()',
      });
    } catch (err) {
      console.error('[avatar] start failed:', err?.message || err);
      return html(500, errorPage('The avatar could not start. Try again in a moment.'));
    }
  },
};
