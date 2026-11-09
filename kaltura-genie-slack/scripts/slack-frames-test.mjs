// Drives a headless Chrome (own throwaway profile) over the DevTools protocol through the
// Slack-frame harness: waits for Genie to mount in each frame, prints each frame's diagnostics,
// optionally asks a question in one frame, and saves screenshots.
//   node scripts/slack-frames-test.mjs <harnessUrl> <outPrefix> [frameIndexToAsk] [question]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [harness, out, askFrame, question = 'What can you help me with?'] = process.argv.slice(2);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9333 + Math.floor(Math.random() * 500);
const prof = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'genie-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run',
  '--window-size=1800,1000', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50 && !targets; i++) { await sleep(200); targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => null); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
const reqs = new Map(); const netLog = [];
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
  if (!process.env.NET) return;
  if (d.method === 'Target.attachedToTarget') { const sid = d.params.sessionId; cdp('Network.enable', {}, sid); cdp('Runtime.enable', {}, sid); cdp('Runtime.runIfWaitingForDebugger', {}, sid); }
  if (d.method === 'Runtime.exceptionThrown') netLog.push('EXCEPTION ' + (d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text || '').slice(0, 300));
  const p = d.params || {};
  if (d.method === 'Network.requestWillBeSent') reqs.set(p.requestId, p.request.url);
  if (d.method === 'Network.responseReceived' && p.response.status >= 400) netLog.push(`HTTP ${p.response.status} ${p.response.url}`);
  if (d.method === 'Network.loadingFailed') netLog.push(`FAILED ${p.errorText}${p.corsErrorStatus ? ' cors=' + p.corsErrorStatus.corsError : ''}${p.blockedReason ? ' blocked=' + p.blockedReason : ''} ${reqs.get(p.requestId)}`);
});
const cdp = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const evalJs = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${out}-${name}.png`, Buffer.from(r.result.data, 'base64')); };

await cdp('Page.enable');
if (process.env.NET) { await cdp('Network.enable'); await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); }
await cdp('Emulation.setDeviceMetricsOverride', { width: 1800, height: 1000, deviceScaleFactor: 1, mobile: false });
await cdp('Page.navigate', { url: harness });
await sleep(15000);
const diag = await evalJs(`[...document.querySelectorAll('figure')].map(f => f.querySelector('figcaption').innerText + '\\n' + f.querySelector('pre').innerText).join('\\n\\n')`);
console.log(diag);
await shot('loaded');

if (askFrame !== undefined) {
  // Click into the frame's question box (bottom area of the Genie landing page) and type.
  const box = await evalJs(`(() => { const r = document.getElementById('f${askFrame}').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const found = await evalJs(`'frame ${askFrame} box ' + JSON.stringify(document.getElementById('f${askFrame}').getBoundingClientRect())`);
  console.log(found);
  const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
  const yRatio = Number(process.env.ASK_Y_RATIO || 0.355);
  await click(box.x + box.w / 2, box.y + box.h * yRatio); await sleep(400); await click(box.x + box.w / 2, box.y + box.h * yRatio);
  await sleep(500);
  if (!process.env.CLICK_ONLY) { // CLICK_ONLY=1: just click (e.g. the avatar's Start conversation button)
    await cdp('Input.insertText', { text: question });
    await sleep(300);
    for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined });
  }
  await sleep(Number(process.env.ANSWER_WAIT_MS || 20000));
  await shot('answer');
  console.log(await evalJs(`document.getElementById('d${askFrame}').innerText`));
}
if (process.env.NET) console.log('--- network problems ---\n' + [...new Set(netLog)].join('\n'));
ws.close(); chrome.kill();
