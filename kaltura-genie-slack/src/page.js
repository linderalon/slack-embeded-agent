// The Genie page Slack frames. It loads Kaltura's own Genie chat UI (the Unisphere `genieChat`
// embed) with a per-user KS, so the whole conversation runs in Kaltura's UI and Slack is only the frame.
//
// mode=js      (default) mount genieChat.contained() with the Unisphere ES-module loader
// mode=iframe  nest Kaltura's hosted page https://unisphere.../apps/embeds/conversational-agents/
// diag=1       show a strip with what the host frame allows (origin, storage, mic) and errors

export const UNISPHERE = 'https://unisphere.nvp1.ovp.kaltura.com';
const LOADER = `${UNISPHERE}/v1/loader/index.esm.js`;
const HOSTED = `${UNISPHERE}/apps/embeds/conversational-agents/`;

const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function geniePage({ ks, partnerId, mode = 'js', diag = false, theme = 'light', expiresAt = 0 }) {
  const hostedSrc = `${HOSTED}?${new URLSearchParams({ partnerId: String(partnerId), ks, verbose: 'warning' })}`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Kaltura Genie</title>
<style>
  html,body{margin:0;height:100%;font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;background:${theme === 'dark' ? '#06101e' : '#fff'}}
  body{display:flex;flex-direction:column}
  #genie{flex:1;min-height:0;display:flex;width:100%}
  #genie iframe{flex:1;border:0;width:100%;height:100%}
  #diag{display:${diag ? 'block' : 'none'};font:11px/1.35 ui-monospace,Menlo,monospace;background:#111;color:#cfe;padding:4px 6px;max-height:34%;overflow:auto;white-space:pre-wrap}
  #diag b{color:#fd6}
</style>
</head><body>
<div id="genie">${mode === 'iframe' ? `<iframe title="Kaltura Genie" src="${esc(hostedSrc)}" allow="microphone; autoplay; clipboard-write"></iframe>` : ''}</div>
<div id="diag"></div>
<script>
// Slack's default side panel frame is sandboxed without allow-same-origin, so the page has an opaque
// ("null") origin and localStorage / sessionStorage / document.cookie throw SecurityError. Unisphere
// needs storage to start, so give it in-memory stand-ins (lost when the panel closes).
(function () {
  var blocked = false;
  try { window.localStorage.getItem('x'); } catch (e) { blocked = true; }
  window.__genieStorageShim = blocked;
  if (!blocked) return;
  function MemoryStorage() { var m = new Map(); return {
    get length() { return m.size; }, key: function (i) { return Array.from(m.keys())[i] ?? null; },
    getItem: function (k) { return m.has(String(k)) ? m.get(String(k)) : null; },
    setItem: function (k, v) { m.set(String(k), String(v)); }, removeItem: function (k) { m.delete(String(k)); },
    clear: function () { m.clear(); } }; }
  var ls = MemoryStorage(), ss = MemoryStorage(), jar = {};
  try { Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return ls; } }); } catch (e) {}
  try { Object.defineProperty(window, 'sessionStorage', { configurable: true, get: function () { return ss; } }); } catch (e) {}
  try { Object.defineProperty(Document.prototype, 'cookie', { configurable: true,
    get: function () { return Object.keys(jar).map(function (k) { return k + '=' + jar[k]; }).join('; '); },
    set: function (v) { var kv = String(v).split(';')[0]; var i = kv.indexOf('='); if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); } }); } catch (e) {}
})();
</script>
<script>try{parent.postMessage({type:"genie-boot",origin:location.origin},"*")}catch(e){}</script>
<script type="module">
const MODE = ${json(mode)}, KS = ${json(mode === 'js' ? ks : '')}, PID = ${json(Number(partnerId))}, EXP = ${json(expiresAt)};
const diag = { storageShim: window.__genieStorageShim ? 'in-memory (opaque origin)' : 'not needed', mode: MODE, origin: self.origin, inFrame: window.top !== window, size: innerWidth + 'x' + innerHeight, errors: [], logs: [] };
const box = document.getElementById('diag');
const report = () => {
  box.innerHTML = Object.entries(diag).map(([k, v]) => '<b>' + k + '</b> ' + (typeof v === 'string' ? v : JSON.stringify(v))).join('\\n')
    .replace(/[<>](?!\\/?b>)/g, '');
  try { parent.postMessage({ type: 'genie-diag', diag }, '*'); } catch {}
};
const probe = (fn) => { try { return fn(); } catch (e) { return 'blocked: ' + (e && e.name); } };
const SHIM = window.__genieStorageShim;
diag.cookies = SHIM ? 'blocked by sandbox (shimmed in memory)' : probe(() => { document.cookie = 'g=1; SameSite=None; Secure'; return document.cookie.includes('g=1') ? 'ok' : 'not stored'; });
diag.localStorage = SHIM ? 'blocked by sandbox (shimmed in memory)' : probe(() => { localStorage.setItem('g', '1'); return localStorage.getItem('g') === '1' ? 'ok' : 'not stored'; });
diag.sessionStorage = SHIM ? 'shimmed' : probe(() => { sessionStorage.setItem('g', '1'); return 'ok'; });
diag.indexedDB = probe(() => (window.indexedDB ? 'present' : 'absent'));
diag.mediaDevices = navigator.mediaDevices ? 'present' : 'absent';
diag.micPolicy = probe(() => (document.featurePolicy ? (document.featurePolicy.allowsFeature('microphone') ? 'allowed' : 'blocked by frame') : 'unknown'));
diag.autoplayPolicy = probe(() => (document.featurePolicy ? (document.featurePolicy.allowsFeature('autoplay') ? 'allowed' : 'blocked by frame') : 'unknown'));
const str = (x) => { if (x && x.message) return x.message; if (x && typeof x === 'object') { try { return JSON.stringify(x, (k, v) => (v instanceof Error ? { message: v.message, stack: String(v.stack).slice(0, 300) } : v)).slice(0, 700); } catch { } } return String(x); };
const push = (k, a) => { diag[k].push(a.map(str).join(' ').slice(0, 300)); if (diag[k].length > 12) diag[k].shift(); report(); };
const ce = console.error.bind(console); console.error = (...a) => { push('errors', a); ce(...a); };
addEventListener('error', (e) => push('errors', [e.message || 'error']));
addEventListener('unhandledrejection', (e) => push('errors', [e.reason]));
addEventListener('message', (e) => { if (e.data && e.data.type === 'conversational-agents:logs') push('logs', [e.data.level, e.data.message]); });
report();

if (MODE === 'js') {
  try {
    const t0 = performance.now();
    const { embeds } = await import(${json(LOADER)});
    const { apis } = await embeds.workspace({ apis: ['genieChat'], session: { ks: KS, partnerId: PID } });
    apis.genieChat.contained({ elementId: 'genie', avatar: { stage: 'contained' } });
    diag.mounted = Math.round(performance.now() - t0) + ' ms';
  } catch (e) { push('errors', ['mount failed:', e]); }
  report();
}
// Tell the host when Genie has drawn something (helps the Slack-sandbox harness).
setTimeout(() => { const g = document.getElementById('genie'); diag.rendered = g.querySelector('iframe') ? 'nested iframe' : (g.innerText.trim().slice(0, 80) || (g.children.length + ' elements, no text')); report(); }, 6000);
</script>
</body></html>`;
}

export function errorPage(reason) {
  if (reason === 'call') {
    return `<!doctype html><meta charset="utf-8"><title>Call link expired</title>
<body style="font:15px/1.5 system-ui;margin:0;min-height:100vh;display:grid;place-items:center;background:#06101e;color:#e8eefc">
<div style="max-width:460px;padding:28px 32px;background:#0b203c;border-radius:16px">
<h2 style="margin-top:0">This call link has expired</h2>
<p>Call links work for 12 hours. To talk to Kaltura Genie again, go back to Slack and type <b>/genie</b> (or send any message to Kaltura Genie). A new call card appears; click <b>Join</b>.</p>
</div></body>`;
  }
  return `<!doctype html><meta charset="utf-8"><title>Link expired</title>
<body style="font:15px system-ui;margin:2rem;color:#333"><h3>This Genie link is ${reason === 'expired' ? 'expired' : 'not valid'}.</h3>
<p>Go back to Slack and open Genie again to get a fresh link.</p></body>`;
}

// The call page Slack's call card opens (in a normal browser window, outside Slack's sandbox), so
// Kaltura's Genie avatar owns the whole voice experience: mic prompt, audio, video, captions.
// It tells our server when the call connects and ends, so the Slack call card stays in sync.
export function callPage({ ks, partnerId, k, title = 'Call with Kaltura Genie' }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>
  html,body{margin:0;height:100%;background:#06101e;font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#e8eefc}
  #avatar{position:fixed;inset:0}
  #err{display:none;position:fixed;inset:auto 16px 16px 16px;background:#3a1016;color:#ffd7dc;padding:10px 14px;border-radius:8px}
  #recap{display:none;position:fixed;inset:0;overflow:auto;background:#06101e;z-index:10}
  #recap .card{max-width:680px;margin:7vh auto;padding:28px 32px;background:#0b203c;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.35)}
  #recap h1{margin:0 0 4px;font-size:22px}
  #recap .muted{color:#a9c7ef;font-size:13px}
  #recap h2{margin:22px 0 8px;font-size:15px;color:#a9c7ef;text-transform:uppercase;letter-spacing:.06em}
  #recap .summary{white-space:pre-wrap;font-size:16px}
  #recap .turn{margin:6px 0;white-space:pre-wrap}
  #recap .turn b{color:#7fb2ff}
  #recap button{margin-top:24px;background:#006cfa;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}
  #recap details summary{cursor:pointer;color:#a9c7ef}
</style>
</head><body>
<div id="avatar"></div>
<div id="err"></div>
<div id="recap" role="dialog" aria-label="Call summary"><div class="card">
  <h1>Call ended</h1>
  <div class="muted" id="recap-status">Preparing your call summary…</div>
  <h2>Summary</h2><div class="summary" id="recap-summary">…</div>
  <details id="recap-tx-wrap" hidden><summary>Transcript</summary><div id="recap-tx"></div></details>
  <div class="muted" style="margin-top:14px">The summary is also posted in your Slack conversation with Kaltura Genie.</div>
  <button id="again" type="button">Start a new call</button>
</div></div>
<script>
// Call-quality probe: wraps RTCPeerConnection (before Kaltura's code loads) and reports WebRTC stats
// every 3 s to our server, so choppy audio can be measured (loss, jitter, concealment, RTT, relay).
(function () {
  var K = ${json(k)}, Orig = window.RTCPeerConnection, pcs = [];
  if (!Orig) return;
  function Wrapped(a, b) { var pc = new Orig(a, b); pcs.push(pc); return pc; }
  Wrapped.prototype = Orig.prototype; Object.setPrototypeOf(Wrapped, Orig);
  window.RTCPeerConnection = Wrapped;
  var ms = function (v) { return v == null ? undefined : Math.round(v * 1000); };
  setInterval(function () {
    pcs.forEach(function (pc, i) {
      if (pc.connectionState === 'closed') return;
      pc.getStats().then(function (r) {
        var s = { pc: i, state: pc.connectionState, visible: document.visibilityState }, pair, byId = {};
        r.forEach(function (x) { byId[x.id] = x; });
        r.forEach(function (x) {
          if (x.type === 'inbound-rtp') s[x.kind + 'In'] = { recv: x.packetsReceived, lost: x.packetsLost, jitterMs: ms(x.jitter),
            concealed: x.concealedSamples, samples: x.totalSamplesReceived,
            jbMs: x.jitterBufferEmittedCount ? Math.round(1000 * x.jitterBufferDelay / x.jitterBufferEmittedCount) : undefined,
            fps: x.framesPerSecond, freezes: x.freezeCount };
          if (x.type === 'outbound-rtp' && x.kind === 'audio') s.audioOut = { sent: x.packetsSent };
          if (x.type === 'remote-inbound-rtp' && x.kind === 'audio') s.audioOutAtServer = { lost: x.packetsLost, jitterMs: ms(x.jitter), rttMs: ms(x.roundTripTime) };
          if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') pair = x;
        });
        if (pair) { var l = byId[pair.localCandidateId], rc = byId[pair.remoteCandidateId];
          s.rttMs = ms(pair.currentRoundTripTime); s.path = (l && l.candidateType + '/' + l.protocol) + ' -> ' + (rc && rc.candidateType); }
        navigator.sendBeacon('/api/call/stats?k=' + encodeURIComponent(K), JSON.stringify(s));
      }).catch(function () {});
    });
  }, 3000);
})();
</script>
<script type="module">
const KS = ${json(ks)}, PID = ${json(Number(partnerId))}, K = ${json(k)};
const q = 'k=' + encodeURIComponent(K);
let live = false, threadId = null;
const start = () => { if (!live) { live = true; navigator.sendBeacon('/api/call/start?' + q); } };
const end = () => {
  if (!live) return;
  live = false;
  navigator.sendBeacon('/api/call/end?' + q + (threadId ? '&t=' + encodeURIComponent(threadId) : ''));
  showRecap();
};
addEventListener('pagehide', end);

// End screen: Kaltura generates the summary on its side a few seconds after hang-up.
const $ = (id) => document.getElementById(id);
async function showRecap() {
  $('recap').style.display = 'block';
  if (!threadId) { $('recap-status').textContent = 'Nothing was said in this call, so there is no summary.'; $('recap-summary').textContent = '—'; return; }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const r = await fetch('/api/call/recap?' + q).then((x) => x.json()).catch(() => null);
    if (r && r.ready) {
      $('recap-status').textContent = r.summary ? 'From Kaltura Genie' : 'Kaltura did not produce a summary for this call.';
      $('recap-summary').textContent = r.summary || '—';
      const tx = $('recap-tx'); tx.textContent = '';
      for (const t of r.turns || []) {
        const d = document.createElement('div'); d.className = 'turn';
        const b = document.createElement('b'); b.textContent = (t.who === 'you' ? 'You' : 'Genie') + ': ';
        d.append(b, document.createTextNode(t.text)); tx.append(d);
      }
      $('recap-tx-wrap').hidden = !(r.turns || []).length;
      return;
    }
  }
  $('recap-status').textContent = 'The summary is taking longer than usual. It will appear in Slack when ready.';
}
$('again').addEventListener('click', () => location.reload());

try {
  const { embeds } = await import(${json(LOADER)});
  const { apis } = await embeds.workspace({
    apis: [{ name: 'genieAvatar', settings: { captions: { enable: true }, theme: { type: 'dark' } } }],
    session: { ks: KS, partnerId: PID },
  });
  window.__genieAvatar = apis.genieAvatar; // for debugging in DevTools
  apis.genieAvatar.threadId.onChanges((id) => { if (id) threadId = id; });
  apis.genieAvatar.contained({
    elementId: 'avatar',
    autoConnect: false, // one click on "Start call" gives the browser the user gesture it needs for audio
    stageMode: 'contained',
    lobbyButton: { type: 'default', label: 'Start call' },
  });
  // connectionStatus is 'connected' while the live avatar session is up; any other value after that
  // (notConnected, error, ...) means the call ended: End button, dropped connection, or mic refused.
  // (isConnected stays false in this embed, so it can't be used.)
  apis.genieAvatar.connectionStatus.onChanges((status) => (status === 'connected' ? start() : end()));
} catch (e) {
  const box = $('err');
  box.style.display = 'block';
  box.textContent = 'Could not start Kaltura Genie: ' + ((e && e.message) || e);
}
</script>
</body></html>`;
}
