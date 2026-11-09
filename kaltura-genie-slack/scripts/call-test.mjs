// Runs a full Genie call in headless Chrome with a FAKE microphone (Chrome's test tone), so the
// start -> in call -> hang up flow can be checked without a person. Saves 3 screenshots.
//   node scripts/call-test.mjs <callUrl> <outPrefix> [secondsInCall]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [url, out, secs = '25'] = process.argv.slice(2);
const port = 9400 + Math.floor(Math.random() * 400);
const prof = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'genie-call-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`, '--no-first-run', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  ...(process.env.FAKE_AUDIO ? [`--use-file-for-fake-audio-capture=${process.env.FAKE_AUDIO}`] : []),
  '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 50 && !t; i++) { await sleep(200); t = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => null); }
const ws = new WebSocket(t.find((x) => x.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const shot = async (n) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${out}-${n}.png`, Buffer.from(r.result.data, 'base64')); };
const clickText = (re) => ev(`(() => { const b = [...document.querySelectorAll('button,[role=button]')].find(e => ${re}.test(e.innerText || e.getAttribute('aria-label') || '')); if (!b) return 'not found'; b.click(); return 'clicked: ' + (b.innerText || b.getAttribute('aria-label')).trim().slice(0, 40); })()`);
const text = () => ev(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 600)`);

await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await cdp('Page.navigate', { url });
await sleep(10000); await shot('1-lobby'); console.log('lobby:', await text());
console.log(await clickText('/start (call|conversation)/i'));
await sleep(12000);
if (process.env.ASK) console.log('askViaText:', await ev(`(async () => { try { await window.__genieAvatar.askViaText(${JSON.stringify(process.env.ASK)}); return 'sent'; } catch (e) { return 'failed: ' + e.message; } })()`));
console.log('state:', await ev(`(() => { const g = window.__genieAvatar; if (!g) return 'no api'; return JSON.stringify({ isConnected: g.isConnected.getData(), status: g.connectionStatus.getData(), threadId: g.threadId.getData(), recapShown: getComputedStyle(document.getElementById('recap') || document.body).display }); })()`));
console.log('server events api:', await ev(`(() => { const s = window.__genieAvatar && window.__genieAvatar.serverWebsocketEvents; return s ? Object.keys(s).join(',') || typeof s : String(s); })()`));
await sleep(Number(secs) * 1000); await shot('2-incall'); console.log('in call:', await text());
console.log(await clickText('/^\\s*end\\b|hang ?up|end call/i'));
for (const wait of [4000, 8000, 12000, 12000]) {
  await sleep(wait); console.log(`after hang-up (+${wait / 1000}s more):`, await text());
}
console.log('state:', await ev(`(() => { const g = window.__genieAvatar; if (!g) return 'no api'; return JSON.stringify({ isConnected: g.isConnected.getData(), status: g.connectionStatus.getData(), threadId: g.threadId.getData(), recapShown: getComputedStyle(document.getElementById('recap') || document.body).display }); })()`));
await shot('3-after');
console.log('server events:', await ev(`JSON.stringify(window.__genieEvents || []).slice(0, 3000)`));
console.log('last chatLog seen:', await ev(`JSON.stringify(window.__genieChatLog || []).slice(0, 2500)`));
console.log('avatar chatLog:', await ev(`JSON.stringify((window.__genieAvatar && window.__genieAvatar.chatLog.getData()) || 'n/a').slice(0, 1500)`));
ws.close(); chrome.kill();
