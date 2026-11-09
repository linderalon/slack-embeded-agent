// Tiny HTTP server for the Genie-in-Slack prototype.
//   GET /genie?u&exp&sig[&mode=js|iframe][&diag=1]  signed link -> per-user KS -> Kaltura Genie page
//   GET /healthz
//   GET /dev/harness[?mode=js|iframe]  (DEV only) frames /genie the way Slack does, side by side

import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { signUrl, verifyUrl } from './sign.js';
import { createKaltura } from './kaltura.js';
import { geniePage, callPage, errorPage } from './page.js';
import { CallManager } from './calls.js';
import { recapCall } from './recap.js';
import { kalturaUserId } from './slack-app.js';

const e = process.env;
const cfg = {
  port: Number(e.PORT || 3077),
  baseUrl: (e.PUBLIC_BASE_URL || `http://localhost:${e.PORT || 3077}`).replace(/\/+$/, ''),
  secret: e.GENIE_SIGNING_SECRET || '',
  dev: e.DEV !== '0' && /^http:\/\/(localhost|127\.0\.0\.1)/.test(e.PUBLIC_BASE_URL || 'http://localhost'),
  linkTtlSeconds: Number(e.LINK_TTL_SECONDS || 600),
  kaltura: {
    partnerId: e.KALTURA_PARTNER_ID, adminSecret: e.KALTURA_ADMIN_SECRET,
    agentId: e.KALTURA_AGENT_ID, configId: e.KALTURA_CONFIG_ID,
    ksTtlSeconds: Number(e.KS_TTL_SECONDS || 4 * 3600),
  },
};
if (cfg.secret.length < 32) throw new Error('GENIE_SIGNING_SECRET must be at least 32 characters');
for (const k of ['partnerId', 'adminSecret', 'agentId']) if (!cfg.kaltura[k]) throw new Error(`Missing Kaltura setting ${k}`);

const kaltura = createKaltura(cfg.kaltura);
export const calls = new CallManager({
  joinUrlFor: (k) => `${cfg.baseUrl}/call/${k}`,
  ttlSeconds: Number(e.CALL_TTL_SECONDS || 12 * 3600),
  file: e.CALLS_FILE || fileURLToPath(new URL('../data/calls.json', import.meta.url)),
});

// Slack's Work Object embeds require these frame-ancestors. DEV also allows this origin, for the harness.
const SLACK_ANCESTORS = 'https://*.slack.com https://*.slack-gov.com https://*.slack-mcps.com';
const ancestors = cfg.dev ? `'self' http://127.0.0.1:${cfg.port} ${SLACK_ANCESTORS}` : SLACK_ANCESTORS;

function send(res, status, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `frame-ancestors ${ancestors}`,
    ...extra,
  });
  res.end(body);
}

// The always-available "Start a call" button points here. Long-lived and signed: it names the Slack
// workspace, user and DM, and each click makes a NEW call (fresh key, fresh Kaltura KS).
const START_TTL = Number(e.START_LINK_TTL_SECONDS || 90 * 24 * 3600);
export function startUrlFor({ teamId, slackUserId, channel }) {
  return signUrl(cfg.baseUrl, '/start', { userId: `${teamId}:${slackUserId}:${channel}`, ttlSeconds: START_TTL }, cfg.secret);
}
calls.startUrlFor = startUrlFor;

export function link(userId, extra) {
  return signUrl(cfg.baseUrl, '/genie', { userId, ttlSeconds: cfg.linkTtlSeconds, extra }, cfg.secret);
}

async function handle(req, res) {
  const url = new URL(req.url, cfg.baseUrl);
  if (cfg.dev) console.log(new Date().toISOString().slice(11, 19), req.method, url.pathname, 'origin=' + (req.headers.origin || '-'), 'dest=' + (req.headers['sec-fetch-dest'] || '-'));
  if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

  if (url.pathname === '/start' && req.method === 'GET') {
    const v = verifyUrl(url, cfg.secret);
    const [teamId, slackUserId, channel] = v.ok ? v.userId.split(':') : [];
    if (!v.ok || !teamId || !slackUserId || !channel) return send(res, 403, errorPage('call'));
    const { joinUrl } = calls.reserve({ teamId, slackUserId, channel });
    res.writeHead(302, { Location: joinUrl, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    return res.end();
  }

  // Join URL from the Slack call card. Opens in a normal browser window (not framed by Slack).
  const callMatch = url.pathname.match(/^\/call\/([\w-]+)$/);
  if (callMatch && req.method === 'GET') {
    const c = calls.get(callMatch[1]);
    if (!c) return send(res, 403, errorPage('call'));
    const { ks } = await kaltura.genieKs(kalturaUserId(c.teamId, c.slackUserId));
    return send(res, 200, callPage({ ks, partnerId: kaltura.partnerId, k: callMatch[1] }), { 'Content-Security-Policy': "frame-ancestors 'none'" });
  }
  if (url.pathname === '/api/call/stats' && req.method === 'POST') {
    const c = calls.get(url.searchParams.get('k') || '');
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 8000) break; }
    if (c) { try { console.log('[stats]', new Date().toISOString().slice(11, 19), JSON.stringify(JSON.parse(body))); } catch { /* ignore bad samples */ } }
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (url.pathname === '/api/call/recap' && req.method === 'GET') {
    const c = calls.get(url.searchParams.get('k') || '');
    const body = !c ? { error: 'unknown' } : c.recap ? c.recap : { pending: Boolean(c.threadId), ready: false };
    res.writeHead(c ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(body));
  }
  const apiMatch = url.pathname.match(/^\/api\/call\/(start|end)$/);
  if (apiMatch && req.method === 'POST') {
    const k = url.searchParams.get('k') || '';
    const ok = apiMatch[1] === 'start' ? await calls.started(k) : await calls.ended(k, { threadId: url.searchParams.get('t') || undefined });
    if (ok && apiMatch[1] === 'end') {
      const c = calls.get(k);
      recapCall({ calls, kaltura, k, userId: kalturaUserId(c.teamId, c.slackUserId) })
        .catch((err) => console.warn('[recap] failed:', err?.message || err));
    }
    console.log('[call]', new Date().toISOString().slice(11, 19), apiMatch[1], ok ? 'ok' : 'unknown key');
    res.writeHead(ok ? 204 : 404, { 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (url.pathname === '/genie') {
    const v = verifyUrl(url, cfg.secret);
    if (!v.ok) return send(res, 403, errorPage(v.reason));
    const { ks, expiresAt } = await kaltura.genieKs(v.userId);
    const mode = url.searchParams.get('mode') === 'iframe' ? 'iframe' : 'js';
    return send(res, 200, geniePage({
      ks, partnerId: kaltura.partnerId, mode, expiresAt,
      diag: url.searchParams.get('diag') === '1',
      theme: url.searchParams.get('theme') === 'dark' ? 'dark' : 'light',
    }));
  }

  if (cfg.dev && url.pathname === '/dev/call') {
    const { joinUrl } = calls.reserve({ teamId: 'T0TEST', slackUserId: 'U0LOCAL' });
    res.writeHead(302, { Location: joinUrl, 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (cfg.dev && url.pathname === '/dev/harness') {
    const mode = url.searchParams.get('mode') === 'iframe' ? 'iframe' : 'js';
    const user = url.searchParams.get('u') || 'slack-T0TEST-U0HARNESS';
    const frames = [
      ['Normal browser tab (no sandbox)', 420, 720, null, ''],
      ['Slack side panel, default: sandbox="allow-scripts allow-forms"', 420, 720, 'allow-scripts allow-forms', ''],
      ['Slack side panel with "allow-same-origin" enabled in app settings', 420, 720, 'allow-scripts allow-forms allow-same-origin', ''],
      ['Slack in-message video block (350x260, autoplay only)', 350, 260, 'allow-scripts allow-same-origin', 'autoplay'],
    ];
    const only = url.searchParams.get('only');
    const html = `<!doctype html><meta charset="utf-8"><title>Genie in Slack frames: ${mode}</title>
<style>body{font:13px system-ui;margin:12px;background:#f4ede4}.row{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start}
figure{margin:0;background:#fff;border:1px solid #ccc;border-radius:8px;padding:6px}figcaption{font-weight:600;max-width:420px;margin-bottom:4px}
iframe{border:1px solid #ddd;display:block}pre{font:11px ui-monospace,Menlo,monospace;white-space:pre-wrap;max-width:420px;margin:4px 0 0;color:#333}</style>
<h3>Kaltura Genie framed like Slack does it (mode=${mode}). Each frame has its own signed link.</h3>
<div class="row">${frames.map(([cap, w, h, sb, allow], i) => (only && only !== String(i) ? '' : `<figure><figcaption>${i}. ${cap}</figcaption>
<iframe id="f${i}" width="${w}" height="${h}" src="${link(user, { mode, diag: '1', f: String(i) }).replace(/&/g, '&amp;')}"${sb === null ? ' allow="microphone; autoplay"' : ` sandbox="${sb}"`}${allow ? ` allow="${allow}"` : ''}></iframe>
<pre id="d${i}">waiting…</pre></figure>`)).join('')}</div>
<script>addEventListener('message',(e)=>{if(e.data&&e.data.type==='genie-boot'){for(const f of document.querySelectorAll('iframe'))if(f.contentWindow===e.source)document.getElementById('d'+f.id.slice(1)).textContent='booted, origin '+e.data.origin;return;}if(!e.data||e.data.type!=='genie-diag')return;for(const f of document.querySelectorAll('iframe')){if(f.contentWindow===e.source){const d=e.data.diag;document.getElementById('d'+f.id.slice(1)).textContent=
['origin '+d.origin,'storage shim '+d.storageShim,'cookies '+d.cookies,'localStorage '+d.localStorage,'mic '+d.micPolicy+' / mediaDevices '+d.mediaDevices,'autoplay '+d.autoplayPolicy,'mounted '+(d.mounted||'-'),'rendered '+(d.rendered||'-'),'errors '+d.errors.length+(d.errors.length?': '+d.errors.slice(-3).join(' | '):'')].join('\\n');}}});</script>`;
    return send(res, 200, html);
  }

  send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  http.createServer((req, res) => handle(req, res).catch((err) => {
    console.error('request failed:', err?.code || '', err?.message || err);
    if (!res.headersSent) send(res, 502, errorPage('error'));
  })).listen(cfg.port, () => {
    console.log(`Genie server on ${cfg.baseUrl} (dev=${cfg.dev})`);
    console.log('Signed test link:', link('slack-T0TEST-U0LOCAL', { diag: '1' }));
    if (cfg.dev) console.log(`Slack-frame harness: ${cfg.baseUrl}/dev/harness · test call: ${cfg.baseUrl}/dev/call`);
  });
  if (e.SLACK_BOT_TOKEN && e.SLACK_APP_TOKEN) {
    if (!cfg.baseUrl.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must be https:// for Slack');
    const { startSlack } = await import('./slack-app.js');
    await startSlack({ calls, startUrlFor });
    await calls.endOrphans(); // calls that were live when the server last stopped
  }
}
