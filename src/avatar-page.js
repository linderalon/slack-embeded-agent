// The avatar page Slack shows (side panel or inline player). Pure: no Node APIs, so the same
// code runs in the local server (src/embed.js) and the hosted copy (kvibe/, see scripts/build-kvibe.mjs).

// Work Object panel: *.slack.com / *.slack-gov.com / *.slack-mcps.com (all three required).
// Inline video block: Slack wraps the page in https://slack-files.com/video_embed.
export const FRAME_ANCESTORS = "frame-ancestors https://*.slack.com https://*.slack-gov.com https://*.slack-mcps.com https://slack-files.com https://*.slack-files.com";

export const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// JSON that is safe to inline in a <script> tag.
// U+2028/U+2029 end a line inside <script>, so escape them like '<'.
const inlineJson = (v) => JSON.stringify(v)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

export function errorPage(message) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;color:#1d1c1d;background:#fff}p{max-width:28rem;padding:1.5rem;text-align:center}</style>
<p>${escHtml(message)}</p>`;
}

/**
 * @param {{init:object, threadId?:string, region?:string|null, selfUrl:string, sdkUrl?:string, call?:{k:string}|null}} o
 *   call: render the live-call page (opened from Slack's call card or "Start a live call"): starts
 *   by itself, keeps the microphone listening (no push-to-talk), and adds Mute / Float over Slack /
 *   End call. It reports start and end to the app so the Slack call card stays accurate.
 * logUrl: where to report each finished exchange (the user's words + the avatar's answer), so the
 *   Slack app can post it in the conversation the avatar was opened from. Null: nothing is reported.
 */
export function avatarPage({ init, threadId, region, selfUrl, sdkUrl = '/sdk/experience/index.js', call = null, logUrl = null }) {
  const boot = { ...init, threadId: threadId || null, region: region || null, call: call ? { k: call.k } : null, logUrl: logUrl || null };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${call ? 'Live call with the Kaltura avatar' : 'Kaltura avatar'}</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1d1c1d; --muted:#616061; --line:#e1e1e1; --accent:#006efa; --danger:#e01e5a; --stage:#0d0d0f; }
  @media (prefers-color-scheme: dark) { :root { --bg:#1a1d21; --fg:#e8e8e8; --muted:#a3a3a3; --line:#35383c; } }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  body, #app { display:flex; flex-direction:column; }
  #app { flex:1 1 auto; min-height:0; height:100%; }
  .stage { position:relative; flex:0 0 auto; height:min(55vh, 100vw); width:100%; background:var(--stage); overflow:hidden; }
  /* contain: the whole avatar stays visible in the narrow Slack panel, the wide view and the call window */
  .stage video { width:100%; height:100%; object-fit:contain; display:block; }
  .overlay { position:absolute; inset:0; display:grid; place-items:center; gap:.75rem; align-content:center; color:#fff; text-align:center; padding:1rem; }
  .overlay[hidden] { display:none; }
  .start { font:inherit; font-weight:600; padding:.7rem 1.4rem; border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
  .start:disabled { opacity:.6; cursor:default; }
  .status { min-height:1.4em; padding:.5rem .9rem; color:var(--muted); font-size:13px; border-bottom:1px solid var(--line); }
  .notice { padding:.5rem .9rem; font-size:12px; color:var(--muted); }
  .log { flex:1 1 auto; overflow:auto; padding:.5rem .9rem; display:flex; flex-direction:column; gap:.4rem; }
  .msg { max-width:90%; padding:.45rem .7rem; border-radius:10px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .msg.user { align-self:flex-end; background:var(--accent); color:#fff; }
  .msg.agent { align-self:flex-start; background:color-mix(in srgb, var(--fg) 8%, transparent); }
  .composer { display:flex; gap:.5rem; padding:.6rem .9rem; border-top:1px solid var(--line); }
  input { flex:1; min-width:0; font:inherit; padding:.55rem .7rem; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; }
  .composer button, .callbar button { font:inherit; font-weight:600; padding:.55rem .9rem; border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
  .composer button:disabled, input:disabled, .callbar button:disabled { opacity:.5; }
  .callbar { display:flex; gap:.5rem; align-items:center; padding:.6rem .9rem; border-top:1px solid var(--line); }
  .callbar[hidden] { display:none; }
  .callbar .grow { flex:1; color:var(--muted); font-size:12px; }
  .callbar .secondary { background:color-mix(in srgb, var(--fg) 12%, transparent); color:inherit; }
  .callbar .end { background:var(--danger); }
  .mic { display:inline-block; width:.6rem; height:.6rem; border-radius:50%; background:#2bac76; margin-right:.35rem; vertical-align:middle; }
  .mic.off { background:var(--danger); }
  .mic.speaking { box-shadow:0 0 0 4px rgba(43,172,118,.35); }
  .sound { position:absolute; top:.5rem; right:.5rem; font:inherit; font-size:12px; padding:.3rem .6rem; border:0; border-radius:6px; background:rgba(0,0,0,.6); color:#fff; cursor:pointer; }
  .sound[hidden] { display:none; }
  a { color:var(--accent); }
  /* Compact: Slack's inline player (about 350x260) and the floating window. The video fills the
     frame and the controls sit on top of it; the transcript is not shown here (it goes to Slack). */
  @media (max-height: 460px) {
    html, body { font-size:12px; background:var(--stage); color:#fff; }
    #app { position:relative; }
    .stage { flex:1 1 auto; height:auto; }
    .status, #disclosure, #voice-note { display:none !important; }
    /* No captions on the video: the conversation is logged in Slack instead. */
    .log { display:none !important; }
    .composer { position:absolute; left:0; right:0; bottom:0; padding:.3rem; gap:.3rem; border:0; background:rgba(0,0,0,.55); }
    input { padding:.3rem .5rem; border-color:rgba(255,255,255,.3); color:#fff; }
    .composer button, .callbar button { padding:.3rem .6rem; }
    .callbar { position:absolute; top:0; left:0; right:0; padding:.3rem; gap:.3rem; border:0; background:linear-gradient(rgba(0,0,0,.6), transparent); }
    .callbar .grow { color:#fff; }
    .callbar #float { display:none; }
    .start { padding:.5rem 1rem; }
    .overlay div { display:none; }
  }
</style>
</head>
<body>
  <main id="app">
    <div class="stage">
      <video id="video" autoplay playsinline muted></video>
      <button class="sound" id="sound" type="button" hidden>🔊 Turn on sound</button>
      <div class="overlay" id="overlay">
        <button class="start" id="start" type="button">${call ? 'Start the call' : 'Start conversation'}</button>
        <div style="font-size:12px;opacity:.8">${call ? 'One click starts sound and the microphone. Then just talk, no buttons needed.' : 'Video and audio start after you click.'}</div>
      </div>
    </div>
    <div class="callbar" id="callbar" hidden>
      <span class="grow"><span class="mic" id="mic-dot"></span><span id="mic-label">Listening</span></span>
      <button class="secondary" id="mute" type="button">Mute</button>
      <button class="secondary" id="float" type="button" hidden>Float over Slack</button>
      <button class="end" id="end" type="button">End call</button>
    </div>
    <div class="status" id="status" role="status" aria-live="polite"></div>
    <div class="notice" id="disclosure" hidden></div>
    <div class="log" id="log" aria-live="polite"></div>
    <div class="composer">
      <input id="msg" placeholder="Type a message…" aria-label="Message" autocomplete="off" disabled>
      <button id="send" type="button" disabled>Send</button>
    </div>
    <div class="notice" id="voice-note" hidden>
      ${call ? 'Microphone access is blocked. Allow it in your browser’s address bar and reload to talk; you can still type.'
    : `Slack doesn't give this panel your microphone. Type here, or record a voice clip in the Slack conversation and I'll answer it out loud.`}
    </div>
  </main>

  <script src="https://cdn.socket.io/4.7.5/socket.io.min.js" integrity="sha384-2huaZvOR9iDzHqslqwpR87isEmrfxqyWOF7hr7BY6KG0+hVKLoEXMPUJw3ynWuhO" crossorigin="anonymous"></script>
  <script type="module">
    import { KalturaAvatarSession } from '${sdkUrl}';
    const boot = ${inlineJson(boot)};
    // Element references are taken once: the UI can move into a floating window (another document).
    const el = Object.fromEntries(['app', 'video', 'sound', 'overlay', 'start', 'callbar', 'mic-dot', 'mic-label', 'mute', 'float', 'end', 'status', 'disclosure', 'log', 'msg', 'send', 'voice-note']
      .map((id) => [id, document.getElementById(id)]));
    const status = (t) => { el.status.textContent = t || ''; };
    const add = (who, text) => {
      const d = el.log.ownerDocument.createElement('div');
      d.className = 'msg ' + who; d.textContent = text;
      el.log.appendChild(d); el.log.scrollTop = el.log.scrollHeight;
      return d;
    };
    const callApi = (what) => {
      if (!boot.call) return;
      const url = '/api/call/' + what + '?k=' + encodeURIComponent(boot.call.k);
      if (what === 'end' && navigator.sendBeacon) { navigator.sendBeacon(url); return; }
      fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
    };

    const audio = document.createElement('audio');
    audio.autoplay = true;
    document.body.appendChild(audio);

    let session;
    let ended = false;
    const pendingTyped = new Set();

    // One exchange = what the user said or typed + the avatar's whole answer. Reported when the
    // avatar's turn ends (or when the next question starts), so Slack gets one message per exchange.
    let turn = { user: '', agent: '' };
    const flushTurn = () => {
      const t = turn;
      turn = { user: '', agent: '' };
      if (!boot.logUrl || !t.user.trim() || !t.agent.trim()) return; // skips the greeting
      const body = JSON.stringify({ user: t.user.trim().slice(0, 2000), agent: t.agent.trim().slice(0, 6000) });
      // text/plain keeps this a "simple" cross-origin request (no preflight) from Slack's sandboxed frames.
      fetch(boot.logUrl, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true, mode: 'cors' }).catch(() => {});
    };
    const userSaid = (text) => {
      if (turn.agent) flushTurn();
      turn.user = turn.user ? turn.user + ' ' + text : text;
    };
    el.start.addEventListener('click', async () => {
      el.start.disabled = true;
      status('Connecting…');
      try {
        el.video.muted = false;
        session = new KalturaAvatarSession({
          token: boot.ks,
          conversationManagerUrl: boot.conversationManagerUrl,
          srsBaseUrl: boot.srsBaseUrl,
          turnServerUrl: boot.turnServerUrl,
          ...(boot.region ? { region: boot.region } : {}),
          ...(boot.threadId ? { threadId: boot.threadId } : {}),
          videoEl: el.video,
          audioEl: audio,
          socketFactory: (url, opts) => window.io(url, opts),
          isFirefox: /firefox/i.test(navigator.userAgent),
        });
        session.on('disclosure', ({ disclosureText }) => { el.disclosure.textContent = disclosureText; el.disclosure.hidden = !disclosureText; });
        session.on('responsePending', () => status('Thinking…'));
        session.on('responseSettled', () => status(''));
        // 'user' = what the viewer said or typed; 'final' = the agent's whole utterance, sent
        // when it starts speaking; 'partial' = caption chunks of that same text (skipped here).
        // Typed messages are shown on send, so their late 'user' echo is skipped. Consecutive
        // agent utterances (one per sentence group) are joined into one bubble.
        session.on('transcript', ({ text, type }) => {
          if (!text) return;
          if (type === 'user') {
            if (pendingTyped.has(text.trim())) { pendingTyped.delete(text.trim()); return; }
            add('user', text);
            userSaid(text.trim());
          } else if (type === 'final') {
            if (el.status.textContent === 'Thinking…') status('');
            turn.agent = turn.agent ? turn.agent + ' ' + text.trim() : text.trim();
            const last = el.log.lastElementChild;
            if (last && last.classList.contains('agent')) { last.textContent += ' ' + text.trim(); el.log.scrollTop = el.log.scrollHeight; }
            else add('agent', text.trim());
          }
        });
        session.on('warning', (w) => {
          if (/^(mic_|devices_)/.test(w?.code || '')) { el['voice-note'].hidden = false; setMic(false, 'Microphone blocked'); }
        });
        session.on('turnEnd', () => { flushTurn(); status(''); });
        session.on('avatarStartTalking', () => status(''));
        session.on('localSpeakingChanged', ({ speaking }) => el['mic-dot'].classList.toggle('speaking', !!speaking));
        session.on('error', (e) => status('Error: ' + (e?.detail || e?.code || 'unknown')));
        session.on('ended', () => endCall('Conversation ended.'));
        await session.connect();
        el.overlay.hidden = true;
        el.msg.disabled = false; el.send.disabled = false;
        if (boot.call) {
          el.callbar.hidden = false;
          el.float.hidden = !('documentPictureInPicture' in window);
          status('Connected. Just talk, or type below.');
          callApi('start');
        } else {
          el.msg.focus();
          status('Connected. Speak or type.');
        }
        ensureSound();
        listenForClips();
      } catch (err) {
        console.error(err);
        status('Could not start the avatar: ' + (err?.detail || err?.message || err));
        el.start.disabled = false;
      }
    });

    // Slack voice clips: while this avatar is open, the app hands over the words of clips you record
    // in Slack (Slack gives this page no microphone). They are spoken to the avatar like typed text.
    async function listenForClips() {
      if (!boot.logUrl) return;
      const inboxUrl = boot.logUrl.replace('/api/log?', '/api/inbox?');
      let failures = 0;
      while (!ended) {
        try {
          const res = await fetch(inboxUrl, { cache: 'no-store' });
          if (res.status === 404) return; // this app no longer knows the key
          const { items = [] } = res.ok ? await res.json() : {};
          failures = res.ok ? 0 : failures + 1;
          for (const text of items) {
            if (ended || !session) break;
            add('user', '🎤 ' + text);
            userSaid(text);
            pendingTyped.add(text);
            session.speak(text);
          }
          if (!res.ok) await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * failures)));
        } catch {
          failures++;
          await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * failures)));
        }
      }
    }

    // No <form>: sandboxed frames without allow-forms never submit, so send on click / Enter.
    const send = () => {
      const t = el.msg.value.trim();
      if (!t || !session || ended) return;
      add('user', t);
      userSaid(t);
      pendingTyped.add(t);
      session.speak(t);
      el.msg.value = '';
    };
    el.send.addEventListener('click', send);
    el.msg.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); send(); } });

    // Browsers may refuse sound without a click inside this page: offer a one-click unmute.
    const ensureSound = () => {
      Promise.all([audio.play(), el.video.play()]).then(() => { el.sound.hidden = true; }).catch(() => { el.sound.hidden = false; });
    };
    el.sound.addEventListener('click', ensureSound);

    // ── Live call controls ──
    function setMic(on, label) {
      el['mic-dot'].classList.toggle('off', !on);
      el['mic-label'].textContent = label || (on ? 'Listening' : 'Muted');
      el.mute.textContent = on ? 'Mute' : 'Unmute';
    }
    el.mute.addEventListener('click', () => {
      if (!session) return;
      if (session.micEnabled) { session.mute(); setMic(false); } else { session.unmute(); setMic(true); }
    });
    function endCall(note = 'Call ended.') {
      if (ended) return;
      ended = true;
      flushTurn();
      try { session?.disconnect(); } catch {}
      callApi('end');
      el.msg.disabled = true; el.send.disabled = true; el.mute.disabled = true; el.end.disabled = true; el.float.disabled = true;
      status(note + (boot.call ? ' You can close this window.' : ''));
    }
    el.end.addEventListener('click', () => endCall());

    // Float over Slack: move the whole UI into an always-on-top Picture-in-Picture window
    // (Chrome/Edge desktop). Closing that window brings the UI back here.
    el.float.addEventListener('click', async () => {
      try {
        const pip = await window.documentPictureInPicture.requestWindow({ width: 360, height: 440 });
        for (const ss of document.styleSheets) {
          try { const st = pip.document.createElement('style'); st.textContent = [...ss.cssRules].map((r) => r.cssText).join('\\n'); pip.document.head.appendChild(st); } catch {}
        }
        pip.document.title = document.title;
        pip.document.body.append(el.app);
        el.video.play().catch(() => {});
        pip.addEventListener('pagehide', () => { document.body.prepend(el.app); el.video.play().catch(() => {}); });
      } catch (err) { console.warn('float failed', err); }
    });

    // Slack's inline player already took a click (its play button), so start right away there.
    // The call page opens in a new tab, where the browser needs one click on the page itself
    // before it plays sound and asks for the microphone, so it waits for "Start the call".
    const q = new URLSearchParams(location.search);
    if (q.get('autostart') === '1' && !boot.call) el.start.click();
    addEventListener('pagehide', () => { flushTurn(); if (boot.call) endCall(); else { try { session?.disconnect(); } catch {} } });
  </script>
</body>
</html>`;
}
