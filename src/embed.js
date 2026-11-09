// HTTPS-facing server for the avatar page that Slack shows in the Work Object side panel.
// Put it behind a public HTTPS URL (PUBLIC_BASE_URL) — for local dev, `ngrok http 3000`
// or `cloudflared tunnel --url http://localhost:3000`.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyUrl } from './sign.js';

export const AVATAR_PATH = '/embed/avatar';

// Slack requires all three origins, or the embed fails to load.
import { FRAME_ANCESTORS, avatarPage, errorPage } from './avatar-page.js';

// Serve the SDK's browser runtime from the installed package, so the page runs the same
// pinned version as the server. Module scripts in a sandboxed (Origin: null) iframe are
// CORS requests, hence the Access-Control-Allow-Origin header on these files.
// '<pkg>/src/experience/index.js' -> '<pkg>/src/'
const SDK_SRC = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('@kaltura/intelligent-agents/experience')))) + path.sep;

/**
 * @param {{bridge: import('./kaltura.js').KalturaBridge, cfg: ReturnType<import('./config.js').loadConfig>, calls?: import('./calls.js').CallManager, avatarLog?: import('./avatar-log.js').AvatarLog, inbox?: import('./inbox.js').AvatarInbox, log?: Console}} deps
 */
export function createEmbedServer({ bridge, cfg, calls, avatarLog, inbox, log = console }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      // Avatar transcript: the avatar page (here, or the hosted copy) reports each finished exchange.
      // CORS-open on purpose: the pages run in Slack's sandboxed frames or on another host; the
      // random log key is the credential.
      if (url.pathname === '/api/log') {
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
        if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method not allowed', cors);
        const k = url.searchParams.get('k') || '';
        if (!avatarLog || !avatarLog.has(k)) return send(res, 404, 'text/plain', 'Unknown log key', cors);
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 16_384) return send(res, 413, 'text/plain', 'Too large', cors); }
        let turn;
        try { turn = JSON.parse(body); } catch { return send(res, 400, 'text/plain', 'Bad JSON', cors); }
        const ok = await avatarLog.post(k, { user: String(turn?.user || ''), agent: String(turn?.agent || '') });
        res.writeHead(ok ? 204 : 400, cors); return res.end();
      }
      // Voice clips for an open avatar: the page long-polls here; a clip's transcript is handed over.
      if (url.pathname === '/api/inbox') {
        const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
        if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed', cors);
        const ac = new AbortController();
        req.on('close', () => ac.abort());
        const waiting = inbox ? inbox.poll(url.searchParams.get('k') || '', { signal: ac.signal }) : null;
        if (!waiting) return send(res, 404, 'text/plain', 'Unknown key', cors);
        const items = await waiting;
        if (ac.signal.aborted && !items.length) return;
        return send(res, 200, 'application/json', JSON.stringify({ items }), cors);
      }
      // Live calls: the call page reports start / end (key k = the call's random key).
      if (req.method === 'POST' && (url.pathname === '/api/call/start' || url.pathname === '/api/call/end')) {
        const k = url.searchParams.get('k') || '';
        if (!calls || !calls.get(k)) return send(res, 404, 'text/plain', 'Unknown call');
        const ok = url.pathname.endsWith('/start') ? await calls.started(k) : await calls.ended(k);
        res.writeHead(ok ? 204 : 409); return res.end();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
      if (url.pathname === '/healthz') return send(res, 200, 'text/plain', 'ok');
      if (url.pathname.startsWith('/sdk/')) return await serveSdk(res, url.pathname.slice('/sdk/'.length));
      if (url.pathname === AVATAR_PATH) {
        if (!cfg.avatar.enabled) return send(res, 404, 'text/plain', 'Avatar panel is not configured');
        const v = verifyUrl(url, cfg.avatar.signingSecret);
        if (!v.ok) return send(res, 403, 'text/html', errorPage(v.reason === 'expired'
          ? 'This link has expired. Click the avatar card in Slack again to get a fresh one.'
          : 'This link is not valid.'), { 'Content-Security-Policy': FRAME_ANCESTORS });
        // A call link (k) only turns into the call page for the user the call was reserved for.
        const k = url.searchParams.get('k');
        const c = k && calls ? calls.get(k) : null;
        const call = c && v.userId.endsWith(`-${c.slackUserId}`) ? { k } : null;
        const lk = url.searchParams.get('lk');
        const logUrl = lk && avatarLog?.has(lk) ? `/api/log?k=${encodeURIComponent(lk)}` : null;
        const init = await bridge.avatarInit(v.userId);
        return send(res, 200, 'text/html', avatarPage({ init, threadId: v.threadId, region: cfg.kaltura.region, selfUrl: url.pathname + url.search, call, logUrl }), {
          'Content-Security-Policy': FRAME_ANCESTORS,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Permissions-Policy': 'microphone=(self), camera=()',
        });
      }
      return send(res, 404, 'text/plain', 'Not found');
    } catch (err) {
      log.error('[embed] request failed:', err?.code || '', err?.message || err);
      return send(res, 500, 'text/html', errorPage('The avatar could not start. Try again in a moment.'), { 'Content-Security-Policy': FRAME_ANCESTORS });
    }
  });
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

async function serveSdk(res, rel) {
  const file = path.resolve(SDK_SRC, rel);
  if (!file.startsWith(SDK_SRC) || !file.endsWith('.js')) return send(res, 404, 'text/plain', 'Not found');
  let body;
  try { body = await fs.readFile(file); } catch { return send(res, 404, 'text/plain', 'Not found'); }
  return send(res, 200, 'application/javascript', body, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300',
  });
}
