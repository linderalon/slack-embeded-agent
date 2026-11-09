import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signUrl, verifyUrl } from '../src/sign.js';
import { geniePage, errorPage } from '../src/page.js';
import { kalturaUserId, launcherBlocks, homeView, START_ACTION } from '../src/slack-app.js';
import { callPage } from '../src/page.js';
import { CallManager } from '../src/calls.js';
import { parseTranscript } from '../src/kaltura.js';
import { summaryText, recapBlocks, recapCall } from '../src/recap.js';

const SECRET = 'x'.repeat(40);
const NOW = 1_800_000_000_000;

test('signed link verifies, carries the user, keeps unsigned display options', () => {
  const url = new URL(signUrl('https://genie.example.com', '/genie', { userId: 'slack-T1-U1', ttlSeconds: 600, extra: { mode: 'iframe' } }, SECRET, NOW));
  assert.equal(url.searchParams.get('mode'), 'iframe');
  assert.deepEqual(verifyUrl(url, SECRET, NOW), { ok: true, userId: 'slack-T1-U1' });
});

test('signed link rejects tampering, expiry, wrong path and odd user ids', () => {
  const s = signUrl('https://h', '/genie', { userId: 'slack-T1-U1', ttlSeconds: 60 }, SECRET, NOW);
  const t = new URL(s); t.searchParams.set('u', 'slack-T1-U2');
  assert.equal(verifyUrl(t, SECRET, NOW).reason, 'bad_signature');
  assert.equal(verifyUrl(new URL(s), SECRET, NOW + 61_000).reason, 'expired');
  assert.equal(verifyUrl(new URL(s.replace('/genie', '/other')), SECRET, NOW).reason, 'bad_signature');
  assert.equal(verifyUrl(new URL(s), 'y'.repeat(40), NOW).reason, 'bad_signature');
  assert.equal(verifyUrl(new URL('https://h/genie?u=a<b&exp=9999999999&sig=x'), SECRET, NOW).reason, 'bad_user');
  assert.equal(verifyUrl(new URL('https://h/genie'), SECRET, NOW).reason, 'missing');
});

test('page (js mode) loads Unisphere genieChat with the KS, escapes it, and shims storage', () => {
  const html = geniePage({ ks: 'abc</script><x>', partnerId: 123, mode: 'js' });
  assert.match(html, /embeds\.workspace\(\{ apis: \['genieChat'\]/);
  assert.match(html, /genieChat\.contained\(/);
  assert.ok(!html.includes('abc</script>'), 'KS must be JSON-escaped');
  assert.match(html, /abc\\u003c\/script>/);
  assert.match(html, /MemoryStorage/);
  assert.match(html, /unisphere\.nvp1\.ovp\.kaltura\.com\/v1\/loader\/index\.esm\.js/);
});

test('page (iframe mode) nests the hosted Kaltura page and does not inline the KS in script', () => {
  const html = geniePage({ ks: 'K&S', partnerId: 123, mode: 'iframe' });
  assert.match(html, /<iframe title="Kaltura Genie" src="https:\/\/unisphere\.nvp1\.ovp\.kaltura\.com\/apps\/embeds\/conversational-agents\/\?partnerId=123&#38;ks=K%26S/);
  assert.match(html, /KS = ""/);
});

test('error page never echoes input', () => {
  assert.match(errorPage('expired'), /expired/);
  assert.match(errorPage('<script>'), /not valid/);
});

test('Kaltura user id scheme matches the existing bot', () => {
  assert.equal(kalturaUserId('T1', 'U1'), 'slack-T1-U1');
});

test('call page mounts the Genie avatar, tracks connectionStatus and threadId, escapes the KS', () => {
  const html = callPage({ ks: 'k</script>', partnerId: 7, k: 'abcdefghijklmnopqrstuv' });
  assert.match(html, /name: 'genieAvatar'/);
  assert.match(html, /connectionStatus\.onChanges/);
  assert.match(html, /threadId\.onChanges/);
  assert.match(html, /\/api\/call\/recap/);
  assert.ok(!html.includes('k</script>'));
});

function fakeSlack() {
  const calls = [];
  return { calls, apiCall: async (m, a) => { calls.push([m, a]); return m === 'calls.add' ? { call: { id: 'R1' } } : {}; },
    chat: { postMessage: async (a) => { calls.push(['chat.postMessage', a]); return { ts: '1.2' }; } } };
}

test('call lifecycle: card, join, end with duration, rejoin posts a new card, keys expire', async () => {
  let now = 1_000_000;
  const client = fakeSlack();
  const cm = new CallManager({ client, joinUrlFor: (k) => `https://h/call/${k}`, ttlSeconds: 60, now: () => now, log: { warn() {} } });
  const { k, joinUrl } = cm.reserve({ teamId: 'T1', slackUserId: 'U1', channel: 'D1' });
  assert.equal(joinUrl, `https://h/call/${k}`);
  await cm.post(k);
  assert.deepEqual(client.calls.map((c) => c[0]), ['calls.add', 'chat.postMessage']);
  assert.equal(client.calls[1][1].blocks[0].type, 'call');
  assert.equal(await cm.started(k), true);
  now += 30_000;
  assert.equal(await cm.ended(k, { threadId: 'thread-1234' }), true);
  assert.deepEqual(client.calls.at(-1), ['calls.end', { id: 'R1', duration: 30 }]);
  assert.equal(cm.get(k).threadId, 'thread-1234');
  assert.equal(await cm.ended(k), false, 'ending twice is a no-op');
  await cm.started(k);
  assert.equal(client.calls.filter((c) => c[0] === 'calls.add').length, 2, 'rejoining after hang-up posts a new card');
  now += 61_000;
  assert.equal(cm.get(k), undefined, 'expired');
  assert.equal(cm.get('../../etc'), undefined);
});

test('transcript parsing and summary text', () => {
  assert.deepEqual(parseTranscript('opening: Hi\nhuman: What?\nmore\nai: This.'), [
    { who: 'genie', text: 'Hi' }, { who: 'you', text: 'What?\nmore' }, { who: 'genie', text: 'This.' }]);
  assert.equal(summaryText({ SUMMARY: ' The user asked X. ' }), 'The user asked X.');
  assert.equal(summaryText({ a: '1', b: '2' }), 'a: 1\nb: 2');
  assert.equal(summaryText(null), '');
});

test('recap: signals session end, waits for the summary, posts it with a Start a new call button', async () => {
  const client = fakeSlack();
  const cm = new CallManager({ client, joinUrlFor: (k) => k, log: { warn() {} } });
  cm.startUrlFor = (c) => `https://h/start?for=${c.slackUserId}`;
  const { k } = cm.reserve({ teamId: 'T1', slackUserId: 'U1', channel: 'D1' });
  await cm.post(k); await cm.started(k); await cm.ended(k, { threadId: 'thread-1234' });
  let reads = 0, completed = 0;
  const kaltura = {
    completeSession: async () => { completed++; return { status: 200 }; },
    callRecap: async () => (++reads < 2 ? { summary: null, turns: [] } : { summary: { SUMMARY: 'User <b> asked' }, turns: [{ who: 'you', text: 'hi' }] }),
  };
  const r = await recapCall({ calls: cm, kaltura, k, userId: 'slack-T1-U1', everyMs: 1, waitMs: 50, log: { warn() {}, log() {} } });
  assert.equal(completed, 1);
  assert.equal(r.summary, 'User <b> asked');
  const post = client.calls.at(-1);
  assert.equal(post[0], 'chat.postMessage');
  assert.equal(post[1].thread_ts, undefined, 'a new message at the bottom of the DM, not a thread reply');
  assert.match(post[1].blocks[0].text.text, /User &lt;b&gt; asked/);
  const btn = post[1].blocks.at(-1).elements[0];
  assert.equal(btn.url, 'https://h/start?for=U1');
  assert.equal(btn.action_id, START_ACTION);
  assert.equal(recapBlocks({ summary: '', turns: [] }).length, 2);
});

test('call links survive a restart; calls live at shutdown are ended on startup', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const file = join(mkdtempSync(join(tmpdir(), 'calls-')), 'calls.json');
  const client = fakeSlack();
  const a = new CallManager({ client, joinUrlFor: (k) => k, file, log: { warn() {} } });
  const { k } = a.reserve({ teamId: 'T1', slackUserId: 'U1', channel: 'D1' });
  await a.post(k); await a.started(k);
  const b = new CallManager({ client, joinUrlFor: (x) => x, file, log: { warn() {} } }); // "restarted server"
  assert.equal(b.get(k)?.slackUserId, 'U1');
  await b.endOrphans();
  assert.equal(client.calls.at(-1)[0], 'calls.end');
  const c = new CallManager({ client, joinUrlFor: (x) => x, file, log: { warn() {} } });
  assert.equal(c.get(k).ended, true);
});

test('Start a call button is on the Home tab and in the launcher message, as a link button', () => {
  const url = signUrl('https://h', '/start', { userId: 'T1:U1:D1', ttlSeconds: 60 }, SECRET, NOW);
  for (const blocks of [launcherBlocks(url), homeView(url).blocks]) {
    const btn = blocks.find((b) => b.type === 'actions').elements[0];
    assert.equal(btn.url, url);
    assert.equal(btn.style, 'primary');
  }
  assert.equal(homeView(url).type, 'home');
  assert.deepEqual(verifyUrl(new URL(url), SECRET, NOW), { ok: true, userId: 'T1:U1:D1' });
});
