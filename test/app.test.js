import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaBridge } from '../src/kaltura.js';
import { createMockManagement } from '../src/mock-kaltura.js';
import { widgetsToBlocks, widgetsToLinkBlocks, footerBlocks } from '../src/blocks.js';
import { signUrl, verifyUrl } from '../src/sign.js';
import { registerSlackHandlers } from '../src/slack.js';
import { createEmbedServer, AVATAR_PATH } from '../src/embed.js';
import { parseVtt, transcriptOf, waitForTranscript, voiceClips } from '../src/voice.js';
import { CallManager } from '../src/calls.js';
import { AvatarLog } from '../src/avatar-log.js';
import { avatarPage } from '../src/avatar-page.js';
import { AvatarInbox } from '../src/inbox.js';

const SECRET = 'x'.repeat(40);
const kcfg = { partnerId: '123', agentId: 'agent-1', tokenTtlSeconds: 3600 };
const cfg = {
  kaltura: kcfg,
  avatar: { enabled: true, publicBaseUrl: 'https://agent.example.com', signingSecret: SECRET, linkTtlSeconds: 600 },
  streamFlushMs: 5,
  videoBlocks: true,
};
const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

async function collect(gen) { const out = []; for await (const e of gen) out.push(e); return out; }

// ── Kaltura bridge ────────────────────────────────────────────────────────────

test('bridge streams text, keeps the Kaltura thread, and renders widgets', async () => {
  const bridge = new KalturaBridge(kcfg, { management: createMockManagement({ delayMs: 1 }) });
  const evs = await collect(bridge.turn({ userId: 'slack-T-U1', threadKey: 'D1:1.0:U1', text: 'show me a video' }));
  assert.ok(evs.some((e) => e.type === 'status'));
  const text = evs.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.match(text, /You said: \*\*show me a video\*\*/);
  const done = evs.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.threadId, 'mock-thread-1');
  assert.deepEqual(done.widgets.map((w) => w.kind).sort(), ['followups', 'video-gallery']);
  assert.equal(done.widgets.find((w) => w.kind === 'video-gallery').data.videos[0].entryId, '1_mockclip');

  // Second turn in the same Slack thread continues the same Kaltura thread.
  const evs2 = await collect(bridge.turn({ userId: 'slack-T-U1', threadKey: 'D1:1.0:U1', text: 'again' }));
  assert.equal(evs2.at(-1).threadId, 'mock-thread-1');
});

test('bridge retries once on a foreign thread, then reports errors', async () => {
  const mgmt = createMockManagement({ delayMs: 1 });
  const real = mgmt.conversations.stream;
  let calls = 0;
  mgmt.conversations.stream = async function* (opts, ks) {
    calls++;
    if (opts.threadId) throw Object.assign(new Error('no'), { code: 'thread_access_denied' });
    yield* real.call(this, opts, ks);
  };
  const bridge = new KalturaBridge(kcfg, { management: mgmt });
  bridge.threads.set('k', 'someone-elses-thread');
  const evs = await collect(bridge.turn({ userId: 'u', threadKey: 'k', text: 'hi' }));
  assert.equal(calls, 2);
  assert.equal(evs.at(-1).threadId, 'mock-thread-1');

  mgmt.conversations.stream = async function* () { throw Object.assign(new Error('boom'), { code: 'http_500', title: 'Server error' }); };
  const bad = await collect(bridge.turn({ userId: 'u', threadKey: 'k2', text: 'hi' }));
  assert.equal(bad[0].type, 'error');
  assert.equal(bad.at(-1).type, 'done');
});

test('tokens are cached per user', async () => {
  const mgmt = createMockManagement();
  let minted = 0;
  const orig = mgmt.sessions.createAgentToken;
  mgmt.sessions.createAgentToken = (o) => { minted++; return orig(o); };
  const bridge = new KalturaBridge(kcfg, { management: mgmt });
  await bridge.tokenFor('a'); await bridge.tokenFor('a'); await bridge.tokenFor('b');
  assert.equal(minted, 2);
});

// ── Block Kit ─────────────────────────────────────────────────────────────────

const sampleWidgets = [
  { kind: 'video-gallery', data: { title: 'Clips', videos: [{ entryId: '1_a', title: 'Intro', startTime: 12, endTime: 40, thumbnailUrl: 'https://cfvod.kaltura.com/t.jpg', embedUrl: 'https://www.kaltura.com/embed', url: '' }] } },
  { kind: 'sources', data: { sources: [{ title: 'Doc <1>', url: 'https://x.com/a' }] } },
  { kind: 'followups', data: { questions: ['What next?', 'Tell me more'] } },
  { kind: 'flashcards', data: { cards: [{ front: 'Q', back: 'A' }] } },
  { kind: 'show-link', data: { url: 'javascript:alert(1)', safe: false } },
];

test('widgets map to Block Kit, with a link-only fallback for clips', () => {
  const blocks = widgetsToBlocks(sampleWidgets);
  const video = blocks.find((b) => b.type === 'video');
  assert.equal(video.video_url, 'https://www.kaltura.com/embed');
  assert.match(video.title.text, /Intro \(0:12–0:40\)/);
  assert.match(JSON.stringify(blocks), /Doc &lt;1&gt;/);
  const followups = blocks.find((b) => b.type === 'actions');
  assert.deepEqual(followups.elements.map((e) => e.action_id), ['kaltura_followup:0', 'kaltura_followup:1']);
  assert.ok(!JSON.stringify(blocks).includes('javascript:'), 'unsafe links are dropped');

  const fallback = widgetsToLinkBlocks(sampleWidgets);
  assert.ok(!fallback.some((b) => b.type === 'video'));
  assert.match(JSON.stringify(fallback), /<https:\/\/www\.kaltura\.com\/embed\|Intro>/);
});

test('footer carries the Kaltura message id in feedback values', () => {
  const f = footerBlocks({ messageId: 'm1', avatarEnabled: true });
  const fb = f[0].elements[0];
  assert.equal(fb.positive_button.value, 'up|m1');
  assert.equal(fb.negative_button.value, 'down|m1');
  assert.equal(f[1].elements[0].action_id, 'kaltura_open_avatar');
  assert.deepEqual(footerBlocks({ messageId: undefined, avatarEnabled: false }), []);
});

// ── Signed links ──────────────────────────────────────────────────────────────

test('signed avatar links verify, and reject tampering and expiry', () => {
  const url = new URL(signUrl('https://a.example.com', AVATAR_PATH, { userId: 'slack-T-U1', threadId: 'th1', ttlSeconds: 600 }, SECRET));
  assert.deepEqual(verifyUrl(url, SECRET), { ok: true, userId: 'slack-T-U1', threadId: 'th1' });
  const tampered = new URL(url); tampered.searchParams.set('u', 'slack-T-U2');
  assert.equal(verifyUrl(tampered, SECRET).ok, false);
  assert.equal(verifyUrl(url, 'y'.repeat(40)).ok, false);
  assert.equal(verifyUrl(url, SECRET, Date.now() + 601_000).reason, 'expired');
});

// ── Slack handlers (fake Bolt app + fake Web API client) ─────────────────────

function fakeApp() {
  const h = { message: [], event: {}, action: [], command: {} };
  return {
    h,
    command: (name, fn) => { h.command[name] = fn; },
    message: (fn) => h.message.push(fn),
    event: (name, fn) => { h.event[name] = fn; },
    action: (id, fn) => h.action.push({ id, fn }),
    findAction(actionId) { return h.action.find((a) => (a.id instanceof RegExp ? a.id.test(actionId) : a.id === actionId))?.fn; },
  };
}

const invalidBlocks = () => Object.assign(new Error('invalid_blocks'), { data: { error: 'invalid_blocks' } });

function fakeClient({ rejectVideoOnce = false } = {}) {
  const calls = [];
  let rejected = false;
  const rejectVideo = (blocks) => {
    if (rejectVideoOnce && !rejected && blocks?.some((b) => b.type === 'video')) { rejected = true; throw invalidBlocks(); }
  };
  return {
    calls,
    async apiCall(method, args) {
      calls.push({ method, args });
      if (method === 'chat.startStream') return { ok: true, ts: '200.1' };
      if (method === 'calls.add') return { ok: true, call: { id: 'R123' } };
      if (method === 'chat.stopStream') rejectVideo(args.blocks);
      return { ok: true };
    },
    chat: {
      postMessage: async (args) => { calls.push({ method: 'chat.postMessage', args }); return { ok: true, ts: '300.1' }; },
      update: async (args) => { calls.push({ method: 'chat.update', args }); rejectVideo(args.blocks); return { ok: true }; },
      postEphemeral: async (args) => { calls.push({ method: 'chat.postEphemeral', args }); return { ok: true }; },
    },
  };
}

const testCfg = { ...cfg, updateFlushMs: 1000, threadReplies: false };

function setup(clientOpts, { delayMs = 1, cfgOver = {} } = {}) {
  const app = fakeApp();
  const mgmt = createMockManagement({ delayMs });
  const bridge = new KalturaBridge(kcfg, { management: mgmt });
  const client = fakeClient(clientOpts);
  const calls = new CallManager({ client, log: quiet });
  const avatarLog = new AvatarLog({ client, secret: SECRET, log: quiet });
  const inbox = new AvatarInbox({ avatarLog, pollMs: 200 });
  const api = registerSlackHandlers(app, { bridge, cfg: { ...testCfg, ...cfgOver }, calls, avatarLog, inbox, log: quiet });
  return { app, mgmt, bridge, api, client, calls, avatarLog, inbox };
}

const dm = (text, extra = {}) => ({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', ts: '100.1', text, ...extra });
const updates = (client) => client.calls.filter((c) => c.method === 'chat.update');
const streamed = (client) => client.calls.filter((c) => /chat\.(start|append)Stream/.test(c.method)).map((c) => c.args.markdown_text).join('');

test('a top-level DM gets one top-level reply, edited live, with no thread and no session status', async () => {
  const { app, client } = setup();
  await app.h.message[0]({ message: dm('show me a video'), client, context: { teamId: 'T1' } });
  const placeholder = client.calls[0];
  assert.equal(placeholder.method, 'chat.postMessage');
  assert.equal(placeholder.args.thread_ts, undefined, 'reply is top-level');
  assert.ok(placeholder.args.blocks.some((b) => b.type === 'actions' && b.elements[0].action_id === 'kaltura_stop'));
  assert.ok(!client.calls.some((c) => /Stream|setStatus/.test(c.method)), 'no thread-only APIs');
  const final = updates(client).at(-1).args;
  assert.equal(final.ts, '300.1');
  assert.equal(final.blocks[0].type, 'markdown');
  assert.match(final.blocks[0].text, /You said: \*\*show me a video\*\*/);
  assert.ok(final.blocks.some((b) => b.type === 'video'));
  assert.ok(final.blocks.some((b) => b.type === 'context_actions'));
  const ids = final.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));
  assert.ok(ids.includes('kaltura_open_avatar') && ids.includes('kaltura_reset'));
  assert.ok(!ids.includes('kaltura_stop'), 'stop button removed when done');
});

test('top-level DMs share one Kaltura conversation; New conversation starts over', async () => {
  const { app, bridge, client } = setup();
  await app.h.message[0]({ message: dm('first', { ts: '100.1' }), client, context: { teamId: 'T1' } });
  await app.h.message[0]({ message: dm('second', { ts: '101.1' }), client, context: { teamId: 'T1' } });
  assert.equal(bridge.getThread('D1:main:U1'), 'mock-thread-1');
  assert.equal(bridge.threads.size, 1);
  let said;
  await app.findAction('kaltura_reset')({ ack: async () => {}, body: { user: { id: 'U1' }, channel: { id: 'D1' } }, respond: async (r) => { said = r; } });
  assert.equal(bridge.getThread('D1:main:U1'), undefined);
  assert.equal(said.response_type, 'ephemeral');
});

test('a message inside a thread streams into that thread with session status', async () => {
  const { app, client } = setup();
  await app.h.message[0]({ message: dm('in a thread', { ts: '105.1', thread_ts: '100.1' }), client, context: { teamId: 'T1' } });
  assert.equal(client.calls[0].method, 'agents.sessions.setStatus');
  const start = client.calls.find((c) => c.method === 'chat.startStream').args;
  assert.equal(start.thread_ts, '100.1');
  assert.equal(start.recipient_user_id, undefined, 'no recipient fields in DMs');
  assert.match(streamed(client), /in a thread/);
  assert.equal(client.calls.at(-1).args.status, 'active');
});

test('threadReplies:true answers top-level messages in a new thread', async () => {
  const { app, client } = setup({}, { cfgOver: { threadReplies: true } });
  await app.h.message[0]({ message: dm('hi'), client, context: { teamId: 'T1' } });
  assert.equal(client.calls.find((c) => c.method === 'chat.startStream').args.thread_ts, '100.1');
});

test('bot messages and edits are ignored', async () => {
  const { app, client } = setup();
  await app.h.message[0]({ message: dm('hi', { bot_id: 'B1' }), client, context: {} });
  await app.h.message[0]({ message: dm('hi', { subtype: 'message_changed' }), client, context: {} });
  await app.h.message[0]({ message: dm('hi', { channel_type: 'channel' }), client, context: {} });
  assert.equal(client.calls.length, 0);
});

test('rejected video blocks fall back to clip links (top-level and threaded)', async () => {
  let { app, client } = setup({ rejectVideoOnce: true });
  await app.h.message[0]({ message: dm('a clip please'), client, context: { teamId: 'T1' } });
  const last = updates(client).at(-1).args.blocks;
  assert.ok(!last.some((b) => b.type === 'video'));
  assert.match(JSON.stringify(last), /Getting started/);

  ({ app, client } = setup({ rejectVideoOnce: true }));
  await app.h.message[0]({ message: dm('a clip please', { ts: '105.1', thread_ts: '100.1' }), client, context: { teamId: 'T1' } });
  const stops = client.calls.filter((c) => c.method === 'chat.stopStream');
  assert.equal(stops.length, 2);
  assert.ok(!stops[1].args.blocks.some((b) => b.type === 'video'));
});

test('@mentions reply top-level; inside a thread they stream with recipient fields', async () => {
  let { app, client } = setup();
  await app.h.event.app_mention({ event: { type: 'app_mention', channel: 'C1', user: 'U9', ts: '50.5', text: '<@UBOT> hello there' }, client, context: { teamId: 'T1' } });
  assert.equal(client.calls[0].args.thread_ts, undefined);
  assert.match(updates(client).at(-1).args.blocks[0].text, /\*\*hello there\*\*/);

  ({ app, client } = setup());
  await app.h.event.app_mention({ event: { type: 'app_mention', channel: 'C1', user: 'U9', ts: '51.5', thread_ts: '50.5', text: '<@UBOT> and here' }, client, context: { teamId: 'T1' } });
  const start = client.calls.find((c) => c.method === 'chat.startStream').args;
  assert.equal(start.recipient_user_id, 'U9');
  assert.equal(start.recipient_team_id, 'T1');
  assert.equal(start.thread_ts, '50.5');
});

test('the Stop button cancels a top-level reply', async () => {
  const { app, client } = setup({}, { delayMs: 200 });
  const turn = app.h.message[0]({ message: dm('long answer'), client, context: { teamId: 'T1' } });
  await new Promise((r) => setTimeout(r, 30));
  const stopBtn = client.calls[0].args.blocks.find((b) => b.type === 'actions').elements[0];
  await app.findAction('kaltura_stop')({ ack: async () => {}, action: stopBtn });
  await turn;
  const last = updates(client).at(-1).args.blocks;
  assert.match(JSON.stringify(last), /Stopped/);
  assert.ok(!JSON.stringify(last).includes('kaltura_feedback'));
});

test("Slack's native stop button cancels a threaded reply", async () => {
  const { app, client } = setup({}, { delayMs: 200 });
  const turn = app.h.message[0]({ message: dm('long answer', { ts: '105.1', thread_ts: '100.1' }), client, context: { teamId: 'T1' } });
  await new Promise((r) => setTimeout(r, 30));
  await app.h.event.agent_session_stopped({ event: { channel: 'D1', thread_ts: '100.1' }, client });
  await turn;
  assert.ok(!client.calls.some((c) => c.method === 'chat.stopStream' && c.args.blocks), 'no final widgets after stop');
  assert.equal(client.calls.at(-1).args.status, 'active');
});

test('feedback buttons rate the Kaltura message as the clicking user', async () => {
  const { app, mgmt, client } = setup();
  const fn = app.findAction('kaltura_feedback');
  let acked = false;
  await fn({ ack: async () => { acked = true; }, action: { value: 'down|m42' }, body: { user: { id: 'U1' } }, context: { teamId: 'T1' }, client });
  assert.ok(acked);
  assert.deepEqual(mgmt.feedbackLog, [{ message_id: 'm42', is_positive: false }]);
});

test('follow-up buttons on a top-level reply ask the question at the top level', async () => {
  const { app, client } = setup();
  await app.findAction('kaltura_followup:1')({
    ack: async () => {}, action: { value: 'Tell me more' }, client, context: { teamId: 'T1' },
    body: { user: { id: 'U1' }, channel: { id: 'D1' }, message: { ts: '300.1' } },
  });
  assert.match(client.calls[0].args.text, /asked: Tell me more/);
  assert.equal(client.calls[0].args.thread_ts, undefined);
  assert.match(updates(client).at(-1).args.blocks[0].text, /Tell me more/);
});

test('avatar button attaches the card to the same reply; opening it continues the conversation', async () => {
  const { app, bridge, client } = setup();
  bridge.threads.set('D1:main:U1', 'kthread-7');
  const msgBlocks = footerBlocks({ messageId: 'm1', avatarEnabled: true, resetEnabled: true });
  await app.findAction('kaltura_open_avatar')({
    ack: async () => {}, client, context: { teamId: 'T1' },
    body: { user: { id: 'U1' }, channel: { id: 'D1' }, message: { ts: '300.1', text: 'answer', blocks: [{ type: 'markdown', text: 'answer' }, ...msgBlocks] } },
  });
  assert.equal(client.calls.length, 1, 'no new messages');
  const upd = client.calls[0];
  assert.equal(upd.method, 'chat.update');
  assert.equal(upd.args.ts, '300.1');
  assert.equal(upd.args.metadata.entities[0].entity_payload.attributes.full_size_preview.is_supported, true);
  const ids = upd.args.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));
  assert.deepEqual(ids, ['kaltura_reset'], 'avatar button replaced by the card');

  await app.h.event.entity_details_requested({
    event: { user: 'U1', channel: 'D1', message_ts: '300.1', trigger_id: 'trig', external_ref: { id: 'kaltura-avatar' }, entity_url: 'https://agent.example.com/embed/avatar' },
    body: { team_id: 'T1' }, client, context: { teamId: 'T1' },
  });
  const pd = client.calls.find((c) => c.method === 'entity.presentDetails').args;
  assert.equal(pd.trigger_id, 'trig');
  const previewUrl = new URL(pd.metadata.entity_payload.attributes.full_size_preview.preview_url);
  assert.deepEqual(verifyUrl(previewUrl, SECRET), { ok: true, userId: 'slack-T1-U1', threadId: 'kthread-7' });
});

test('with a thumbnail set, the avatar plays inline in the same reply (video block)', async () => {
  const { app, bridge, client } = setup({}, { cfgOver: { avatar: { ...cfg.avatar, inline: true, inlineLinkTtlSeconds: 3600, thumbnailUrl: 'https://cfvod.kaltura.com/t.jpg' } } });
  bridge.threads.set('D1:main:U1', 'kthread-9');
  await app.findAction('kaltura_open_avatar')({
    ack: async () => {}, client, context: { teamId: 'T1' },
    body: { user: { id: 'U1' }, channel: { id: 'D1' }, message: { ts: '300.1', text: 'answer', blocks: [{ type: 'markdown', text: 'answer' }, ...footerBlocks({ messageId: 'm1', avatarEnabled: true })] } },
  });
  assert.equal(client.calls[0].method, 'chat.update', 'the reply itself becomes the player');
  assert.match(client.calls[1].args.blocks[0].block_id, /^kaltura_transcript:/, 'then its transcript message, before playing');
  assert.equal(client.calls.length, 2);
  const upd = client.calls[0].args;
  assert.equal(upd.metadata, undefined);
  const video = upd.blocks.find((b) => b.type === 'video');
  assert.equal(video.thumbnail_url, 'https://cfvod.kaltura.com/t.jpg');
  const u = new URL(video.video_url);
  assert.equal(u.searchParams.get('autostart'), '1');
  assert.deepEqual(verifyUrl(u, SECRET), { ok: true, userId: 'slack-T1-U1', threadId: 'kthread-9' });
  assert.ok(!JSON.stringify(upd.blocks).includes('kaltura_open_avatar'));
});

test('if Slack refuses the inline player (domain not claimed), the card is attached instead', async () => {
  const { app, client } = setup({}, { cfgOver: { avatar: { ...cfg.avatar, inline: true, inlineLinkTtlSeconds: 3600, thumbnailUrl: 'https://cfvod.kaltura.com/t.jpg' } } });
  let n = 0;
  client.chat.update = async (args) => { client.calls.push({ method: 'chat.update', args }); if (n++ === 0) throw invalidBlocks(); return { ok: true }; };
  await app.findAction('kaltura_open_avatar')({
    ack: async () => {}, client, context: { teamId: 'T1' },
    body: { user: { id: 'U1' }, channel: { id: 'D1' }, message: { ts: '300.1', blocks: [] } },
  });
  const [first, second] = client.calls.map((c) => c.args);
  assert.ok(first.blocks.some((b) => b.type === 'video'));
  assert.ok(second.metadata.entities[0], 'fell back to the Work Object card');
});

test('if Slack refuses to attach the card, it is posted at the same level instead', async () => {
  const { app, client } = setup();
  client.chat.update = async () => { throw Object.assign(new Error('x'), { data: { error: 'invalid_metadata' } }); };
  await app.findAction('kaltura_open_avatar')({
    ack: async () => {}, client, context: { teamId: 'T1' },
    body: { user: { id: 'U1' }, channel: { id: 'D1' }, message: { ts: '300.1', blocks: [] } },
  });
  const post = client.calls.find((c) => c.method === 'chat.postMessage').args;
  assert.equal(post.thread_ts, undefined);
  assert.ok(post.metadata.entities[0]);
});

// ── Avatar waiting in the DM ─────────────────────────────────────────────────

const inlineCfg = { avatar: { ...cfg.avatar, inline: true, inlineLinkTtlSeconds: 43200, thumbnailUrl: 'https://cfvod.kaltura.com/t.jpg', inlineBaseUrl: 'https://inline.example.com' } };
const homeOpened = (app, client, extra = {}) => app.h.event.app_home_opened({
  event: { type: 'app_home_opened', tab: 'messages', channel: 'D1', user: 'U1', ...extra }, client, context: { teamId: 'T1', botUserId: 'UBOT' },
});
const withHistory = (client, messages = []) => { client.conversations = { history: async () => ({ messages }) }; return client; };

test('opening the DM posts one avatar message: inline player + voice button', async () => {
  const { app, client } = setup({}, { cfgOver: inlineCfg });
  withHistory(client);
  await homeOpened(app, client);
  const post = client.calls.find((c) => c.method === 'chat.postMessage').args;
  assert.equal(post.thread_ts, undefined);
  const video = post.blocks.find((b) => b.type === 'video');
  assert.match(video.video_url, /^https:\/\/inline\.example\.com\/embed\/avatar\?/);
  const voice = post.blocks.find((b) => b.type === 'actions').elements[0];
  assert.match(voice.url, /^https:\/\/agent\.example\.com\/embed\/avatar\?/, 'voice opens the browser page');
  assert.equal(verifyUrl(new URL(voice.url), SECRET).ok, true);

  await homeOpened(app, client); // second open: cached, nothing new
  assert.equal(client.calls.filter((c) => c.method === 'chat.postMessage').length, 2, 'avatar message + transcript, once');
});

test('if Slack refuses the inline player, the DM message uses the side-panel card', async () => {
  const { app, client } = setup({}, { cfgOver: inlineCfg });
  withHistory(client);
  client.chat.postMessage = async (args) => {
    client.calls.push({ method: 'chat.postMessage', args });
    if (args.blocks.some((b) => b.type === 'video')) throw invalidBlocks();
    return { ok: true, ts: '400.1' };
  };
  await homeOpened(app, client);
  const posts = client.calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.args);
  assert.equal(posts.length, 3, 'player refused, card, transcript');
  assert.ok(posts[1].metadata.entities[0], 'card attached');
  assert.match(posts[1].blocks[0].block_id, /^kaltura_welcome:card:/);
  assert.match(posts[2].blocks[0].block_id, /^kaltura_transcript:/);
});

test('an existing avatar message is reused (found in history), and refreshed when stale', async () => {
  const fresh = Math.floor(Date.now() / 1000) + 40000;
  let { app, client } = setup({}, { cfgOver: inlineCfg });
  withHistory(client, [{ user: 'UBOT', ts: '350.1', blocks: [{ block_id: `kaltura_welcome:inline:${fresh}:5` }] }]);
  await homeOpened(app, client);
  assert.deepEqual(client.calls.map((c) => c.method), ['chat.postMessage'], 'fresh avatar message kept; only its transcript is added');

  ({ app, client } = setup({}, { cfgOver: inlineCfg }));
  withHistory(client, [{ user: 'UBOT', ts: '350.1', blocks: [{ block_id: 'kaltura_welcome:inline:100' }] }]);
  await homeOpened(app, client);
  assert.equal(client.calls[0].method, 'chat.update');
  assert.equal(client.calls[0].args.ts, '350.1');
  assert.equal(client.calls.filter((c) => c.method === 'chat.update').length, 1);
});

test('switching the DM avatar message from card to player replaces the card message', async () => {
  const { app, client } = setup({}, { cfgOver: inlineCfg });
  withHistory(client, [{ user: 'UBOT', ts: '350.1', blocks: [{ block_id: `kaltura_welcome:card:${Math.floor(Date.now() / 1000) + 40000}` }] }]);
  client.chat.delete = async (args) => { client.calls.push({ method: 'chat.delete', args }); return { ok: true }; };
  await homeOpened(app, client);
  const methods = client.calls.map((c) => c.method);
  assert.deepEqual(methods, ['chat.postMessage', 'chat.delete', 'chat.postMessage'], 'new player, old card removed, transcript');
  assert.ok(client.calls[0].args.blocks.some((b) => b.type === 'video'));
  assert.equal(client.calls[1].args.ts, '350.1');
});

test('a new DM conversation points the avatar message at it', async () => {
  const { app, client } = setup({}, { cfgOver: inlineCfg });
  withHistory(client);
  await homeOpened(app, client);
  await app.h.message[0]({ message: dm('hello'), client, context: { teamId: 'T1' } });
  const upd = client.calls.filter((c) => c.method === 'chat.update' && c.args.ts === '300.1' && c.args.blocks.some((b) => b.type === 'video'));
  const video = upd.at(-1).args.blocks.find((b) => b.type === 'video');
  assert.equal(verifyUrl(new URL(video.video_url), SECRET).threadId, 'mock-thread-1');
});

// ── Voice clips ──────────────────────────────────────────────────────────────

test('voice helpers: find clips, read WebVTT, read transcript status', () => {
  assert.equal(voiceClips({ files: [{ subtype: 'slack_audio' }, { mimetype: 'image/png' }, { mimetype: 'video/mp4' }] }).length, 2);
  const vtt = 'WEBVTT\n\nNOTE made by Slack\nignored\n\n1\n00:00:00.000 --> 00:00:02.000\n<v Alon>What videos do we have\n\n2\n00:00:02.000 --> 00:00:03.500\nabout onboarding?\n';
  assert.equal(parseVtt(vtt), 'What videos do we have about onboarding?');
  assert.deepEqual(transcriptOf({ transcription: { status: 'processing' } }), { status: 'pending' });
  assert.deepEqual(transcriptOf({ transcription: { status: 'complete', preview: { content: ' hi ' } } }), { status: 'complete', text: 'hi' });
  assert.deepEqual(transcriptOf({ vtt }), { status: 'complete', text: 'What videos do we have about onboarding?' });
  assert.deepEqual(transcriptOf({ transcription: { status: 'failed' } }), { status: 'unavailable' });
});

test('waitForTranscript polls files.info until Slack finishes', async () => {
  let n = 0;
  const client = { files: { info: async () => ({ file: ++n < 3 ? { transcription: { status: 'processing' } } : { transcription: { status: 'complete', preview: { content: 'show me onboarding videos' } } } }) } };
  const text = await waitForTranscript(client, { id: 'F1', transcription: { status: 'processing' } }, { sleep: async () => {}, log: quiet });
  assert.equal(text, 'show me onboarding videos');
  assert.equal(n, 3);
  const none = await waitForTranscript({ files: { info: async () => ({ file: { transcription: { status: 'failed' } } }) } }, { id: 'F2' }, { sleep: async () => {}, log: quiet });
  assert.equal(none, null);
});

const clipMsg = (extra = {}) => dm('', { subtype: 'file_share', ts: '120.1', files: [{ id: 'F9', subtype: 'slack_audio', mimetype: 'audio/mp4', transcription: { status: 'processing' } }], ...extra });

test('a voice clip in the DM: Listening… then the same message shows what you said and the answer', async () => {
  const { app, client } = setup();
  client.files = { info: async () => ({ file: { id: 'F9', transcription: { status: 'complete', preview: { content: 'what can you help me with' } } } }) };
  await app.h.message[0]({ message: clipMsg(), client, context: { teamId: 'T1' } });
  const posts = client.calls.filter((c) => c.method === 'chat.postMessage');
  assert.equal(posts.length, 1, 'only the Listening message is posted');
  assert.match(JSON.stringify(posts[0].args.blocks), /Listening/);
  assert.equal(posts[0].args.thread_ts, undefined);
  const final = updates(client).at(-1).args;
  assert.equal(final.ts, '300.1', 'answer replaces the Listening message');
  assert.match(final.blocks[0].elements[0].text, /You said:.*what can you help me with/);
  assert.match(final.blocks[1].text, /You said: \*\*what can you help me with\*\*/);
});

test('a voice clip without a transcript asks the user to type instead', async () => {
  const { app, client, mgmt } = setup();
  client.files = { info: async () => ({ file: { id: 'F9', transcription: { status: 'failed' } } }) };
  let turns = 0;
  const orig = mgmt.conversations.stream;
  mgmt.conversations.stream = (...a) => { turns++; return orig(...a); };
  await app.h.message[0]({ message: clipMsg(), client, context: { teamId: 'T1' } });
  assert.equal(turns, 0, 'nothing sent to the agent');
  assert.match(JSON.stringify(updates(client).at(-1).args.blocks), /couldn't get a transcript/);
});

// ── Live calls ───────────────────────────────────────────────────────────────

test('/talk posts a Slack call card whose Join link opens the call page for this user', async () => {
  const { app, client, calls } = setup();
  let acked = false;
  await app.h.command['/talk']({ ack: async () => { acked = true; }, command: { channel_id: 'D1', user_id: 'U1', team_id: 'T1' }, client, context: { teamId: 'T1' }, respond: async () => {} });
  assert.ok(acked);
  const add = client.calls.find((c) => c.method === 'calls.add').args;
  assert.equal(add.created_by, 'U1');
  const join = new URL(add.join_url);
  assert.equal(join.searchParams.get('k'), add.external_unique_id);
  assert.equal(verifyUrl(join, SECRET).userId, 'slack-T1-U1');
  const card = client.calls.find((c) => c.method === 'chat.postMessage').args;
  assert.deepEqual(card.blocks, [{ type: 'call', call_id: 'R123' }]);
  assert.equal(calls.get(add.external_unique_id).callId, 'R123');
});

test('call lifecycle: start adds the participant once, end ends the call, reuse starts a new call', async () => {
  const { client, calls } = setup();
  const { k } = calls.reserve({ channel: 'D1', slackUserId: 'U1', joinUrlFor: (key) => `https://x/embed/avatar?k=${key}` });
  assert.equal(await calls.started(k), true);
  assert.deepEqual(client.calls.map((c) => c.method), ['calls.add', 'chat.postMessage', 'calls.participants.add']);
  assert.equal(await calls.ended(k), true);
  assert.equal(client.calls.at(-1).method, 'calls.end');
  assert.equal(await calls.ended(k), false, 'ending twice is a no-op');
  await calls.started(k);
  assert.equal(client.calls.filter((c) => c.method === 'calls.add').length, 2, 'same link again = a new call');
});

test('the DM avatar message offers a live call button that carries a call key', async () => {
  const { app, client, calls } = setup({}, { cfgOver: inlineCfg });
  withHistory(client);
  await homeOpened(app, client);
  const post = client.calls.find((c) => c.method === 'chat.postMessage').args;
  const btn = post.blocks.find((b) => b.type === 'actions').elements[0];
  assert.match(btn.text.text, /Start a live call/);
  const u = new URL(btn.url);
  assert.ok(calls.get(u.searchParams.get('k')), 'key reserved');
  assert.match(btn.url, /^https:\/\/agent\.example\.com\//, 'call page runs on the app\'s own host');
});

test('embed server: call page only for the reserved user; start/end endpoints drive the Slack call', async () => {
  const client = fakeClient();
  const calls = new CallManager({ client, log: quiet });
  const { k } = calls.reserve({ channel: 'D1', slackUserId: 'U1', joinUrlFor: () => 'https://x' });
  const bridge = { avatarInit: async () => ({ ks: 'ks', conversationManagerUrl: 'https://cm', srsBaseUrl: 'https://srs', turnServerUrl: 'turn:x' }) };
  const server = createEmbedServer({ bridge, cfg, calls, log: quiet });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const link = (user) => { const u = new URL(signUrl('https://a', AVATAR_PATH, { userId: user, ttlSeconds: 600 }, SECRET)); u.searchParams.set('k', k); return base + u.pathname + u.search; };
    const mine = await (await fetch(link('slack-T1-U1'))).text();
    assert.match(mine, /End call/);
    assert.match(mine, new RegExp(`"call":\\{"k":"${k}"\\}`));
    const other = await (await fetch(link('slack-T1-U2'))).text();
    assert.match(other, /"call":null/, 'someone else\'s link is a normal avatar page');

    assert.equal((await fetch(`${base}/api/call/start?k=${k}`, { method: 'POST' })).status, 204);
    assert.equal(client.calls.at(-1).method, 'calls.participants.add');
    assert.equal((await fetch(`${base}/api/call/end?k=${k}`, { method: 'POST' })).status, 204);
    assert.equal(client.calls.at(-1).method, 'calls.end');
    assert.equal((await fetch(`${base}/api/call/start?k=nope`, { method: 'POST' })).status, 404);
  } finally {
    server.close();
  }
});

// ── Avatar transcript in Slack ───────────────────────────────────────────────

test('avatar links carry a log key; the hosted player also gets this app\'s host', async () => {
  const { app, client, avatarLog } = setup({}, { cfgOver: inlineCfg });
  withHistory(client);
  await homeOpened(app, client);
  const post = client.calls.find((c) => c.method === 'chat.postMessage').args;
  const inline = new URL(post.blocks.find((b) => b.type === 'video').video_url);
  assert.ok(avatarLog.has(inline.searchParams.get('lk')));
  assert.equal(inline.searchParams.get('lb'), 'https://agent.example.com');
  assert.equal(verifyUrl(inline, SECRET).ok, true, 'extra params do not break the signature');
  const call = new URL(post.blocks.find((b) => b.type === 'actions').elements[0].url);
  assert.ok(avatarLog.has(call.searchParams.get('lk')));
  assert.equal(call.searchParams.get('lb'), null, 'same host: no lb needed');
});

test('AvatarLog keeps one transcript message per conversation and edits it', async () => {
  const client = fakeClient();
  client.conversations = { history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) };
  const log = new AvatarLog({ client, secret: SECRET, log: quiet });
  const t = await log.ensureTranscript({ channel: 'D1', slackUserId: 'U1' });
  assert.equal(client.calls[0].method, 'chat.postMessage');
  assert.match(client.calls[0].args.blocks[0].block_id, /^kaltura_transcript:/);
  const k = log.reserve({ channel: 'D1', slackUserId: 'U1' });
  assert.equal(await log.post(k, { user: 'What is <your> name?', agent: 'I am the **assistant**.' }), true);
  assert.equal(await log.post(k, { user: 'And yours?', agent: 'Same.' }), true);
  const edits = client.calls.filter((c) => c.method === 'chat.update').map((c) => c.args);
  assert.equal(edits.length, 2, 'exchanges edit the message; no new posts');
  assert.equal(edits[1].ts, t.ts);
  assert.match(JSON.stringify(edits[1].blocks), /What is &lt;your&gt; name\?/);
  assert.match(JSON.stringify(edits[1].blocks), /And yours\?/);
  assert.equal(client.calls.filter((c) => c.method === 'chat.postMessage').length, 1);
  assert.equal(await log.post('nope', { user: 'a', agent: 'b' }), false);
  assert.equal(await log.post(k, { user: '', agent: 'greeting only' }), false);
  // Keys are signed and stateless: another instance (after a restart) accepts them; tampering fails.
  assert.deepEqual(new AvatarLog({ client, secret: SECRET, log: quiet }).resolve(k), { channel: 'D1', slackUserId: 'U1' });
  const [data, sig] = k.split('.');
  const forged = Buffer.from(JSON.stringify({ c: 'C-other', u: 'U1' })).toString('base64url');
  assert.equal(log.resolve(`${forged}.${sig}`), null);
  assert.equal(new AvatarLog({ client, secret: 'z'.repeat(40), log: quiet }).resolve(k), null);
  assert.ok(data);
});

test('AvatarLog: a thread conversation logs in that thread; a full transcript starts a new message', async () => {
  const client = fakeClient();
  client.conversations = { history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) };
  const log = new AvatarLog({ client, secret: SECRET, log: quiet });
  const k = log.reserve({ channel: 'C1', slackUserId: 'U1', threadTs: '50.5' });
  await log.post(k, { user: 'hi', agent: 'hello' }); // no transcript yet (e.g. a call): posts one
  assert.equal(client.calls[0].method, 'chat.postMessage');
  assert.equal(client.calls[0].args.thread_ts, '50.5');
  for (let i = 0; i < 30; i++) await log.post(k, { user: `q${i}`, agent: `a${i}` });
  const posts = client.calls.filter((c) => c.method === 'chat.postMessage');
  assert.ok(posts.length >= 2, 'rolled over to a new transcript message');
  assert.ok(client.calls.filter((c) => c.method === 'chat.update').every((c) => c.args.blocks.length <= 50));
});

test('the DM avatar message is followed by its transcript message', async () => {
  const { app, client } = setup({}, { cfgOver: inlineCfg });
  withHistory(client);
  await homeOpened(app, client);
  const posts = client.calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.args);
  assert.equal(posts.length, 2);
  assert.ok(posts[0].blocks.some((b) => b.type === 'video'));
  assert.match(posts[1].blocks[0].block_id, /^kaltura_transcript:/);
});

test('avatar page: no captions over the video, and it reports exchanges when given a log URL', () => {
  const html = avatarPage({ init: { ks: 'k' }, selfUrl: '/x', logUrl: 'https://agent.example.com/api/log?k=abc' });
  assert.match(html, /\.log \{ display:none !important; \}/);
  assert.match(html, /"logUrl":"https:\/\/agent\.example\.com\/api\/log\?k=abc"/);
  assert.match(html, /session\.on\('turnEnd', \(\) => \{ flushTurn\(\);/);
  assert.match(avatarPage({ init: {}, selfUrl: '/x' }), /"logUrl":null/);
});

test('embed server /api/log posts the exchange to Slack (CORS-open, keyed)', async () => {
  const client = fakeClient();
  const avatarLog = new AvatarLog({ client, secret: SECRET, log: quiet });
  const k = avatarLog.reserve({ channel: 'D1', slackUserId: 'U1' });
  const server = createEmbedServer({ bridge: {}, cfg, avatarLog, log: quiet });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/api/log?k=${k}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ user: 'hi', agent: 'hello there' }) });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), '*');
    assert.equal(client.calls.at(-1).args.channel, 'D1');
    assert.equal((await fetch(`${base}/api/log?k=nope`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(`${base}/api/log?k=${k}`, { method: 'POST', body: 'not json' })).status, 400);
  } finally {
    server.close();
  }
});

// ── Voice clips to an open avatar ────────────────────────────────────────────

test('inbox: a waiting avatar page gets the clip; none open means not delivered', async () => {
  const log = new AvatarLog({ client: fakeClient(), secret: SECRET, log: quiet });
  const inbox = new AvatarInbox({ avatarLog: log, pollMs: 500 });
  assert.equal(inbox.deliver('D1', 'U1', 'hello'), false, 'nothing open');
  const k = log.reserve({ channel: 'D1', slackUserId: 'U1', threadTs: '9.9' });
  const waiting = inbox.poll(k);
  assert.equal(inbox.isOpen('D1', 'U1'), true, 'open for the whole DM, any thread');
  assert.equal(inbox.deliver('D1', 'U1', 'what can you do'), true);
  assert.deepEqual(await waiting, ['what can you do']);
  // Between polls (recently seen): queued for the next poll.
  assert.equal(inbox.deliver('D1', 'U1', 'and more?'), true);
  assert.deepEqual(await inbox.poll(k), ['and more?']);
  assert.equal(inbox.poll('forged.key'), null);
  assert.equal(inbox.deliver('D1', 'U2', 'other user'), false);
});

test('a voice clip while the avatar is open goes to the avatar, not to a text reply', async () => {
  const { app, client, inbox, avatarLog, mgmt } = setup();
  client.files = { info: async () => ({ file: { id: 'F9', transcription: { status: 'complete', preview: { content: 'tell me about live events' } } } }) };
  let turns = 0;
  const orig = mgmt.conversations.stream;
  mgmt.conversations.stream = (...a) => { turns++; return orig(...a); };
  const k = avatarLog.reserve({ channel: 'D1', slackUserId: 'U1' });
  const waiting = inbox.poll(k); // the avatar panel is open and waiting
  await app.h.message[0]({ message: clipMsg({ thread_ts: '50.5', ts: '121.1' }), client, context: { teamId: 'T1' } });
  assert.deepEqual(await waiting, ['tell me about live events']);
  assert.equal(turns, 0, 'no text turn: the avatar answers');
  const upd = updates(client).at(-1).args;
  assert.match(upd.blocks[0].elements[0].text, /You said:.*tell me about live events.*the avatar is answering out loud/);
});

test('avatar page listens for clips and clears "Thinking…" when the avatar answers', () => {
  const html = avatarPage({ init: { ks: 'k' }, selfUrl: '/x', logUrl: 'https://a/api/log?k=abc' });
  assert.match(html, /listenForClips\(\)/);
  assert.match(html, /replace\('\/api\/log\?', '\/api\/inbox\?'\)/);
  assert.match(html, /session\.on\('turnEnd', \(\) => \{ flushTurn\(\); status\(''\); \}\)/);
});

test('embed server /api/inbox long-polls and returns a delivered clip', async () => {
  const log = new AvatarLog({ client: fakeClient(), secret: SECRET, log: quiet });
  const inbox = new AvatarInbox({ avatarLog: log, pollMs: 2000 });
  const k = log.reserve({ channel: 'D1', slackUserId: 'U1' });
  const server = createEmbedServer({ bridge: {}, cfg, avatarLog: log, inbox, log: quiet });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pending = fetch(`${base}/api/inbox?k=${encodeURIComponent(k)}`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(inbox.deliver('D1', 'U1', 'hello avatar'), true);
    const res = await pending;
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await res.json(), { items: ['hello avatar'] });
    assert.equal((await fetch(`${base}/api/inbox?k=bad.key`)).status, 404);
  } finally {
    server.close();
  }
});

// ── Embed server ──────────────────────────────────────────────────────────────

test('embed server serves the avatar page only for signed links, with Slack framing headers', async () => {
  const bridge = { avatarInit: async (u) => ({ ks: `ks-for-${u}`, conversationManagerUrl: 'https://cm', srsBaseUrl: 'https://srs', turnServerUrl: 'turn:x' }) };
  const server = createEmbedServer({ bridge, cfg, log: quiet });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const signed = new URL(signUrl('https://agent.example.com', AVATAR_PATH, { userId: 'slack-T1-U1', ttlSeconds: 600 }, SECRET));
    const ok = await fetch(base + signed.pathname + signed.search);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-security-policy'), /frame-ancestors https:\/\/\*\.slack\.com https:\/\/\*\.slack-gov\.com https:\/\/\*\.slack-mcps\.com/);
    const html = await ok.text();
    assert.match(html, /"ks":"ks-for-slack-T1-U1"/);
    assert.match(html, /\/sdk\/experience\/index\.js/);

    const bad = await fetch(`${base}${AVATAR_PATH}?u=slack-T1-U1&exp=9999999999&sig=nope`);
    assert.equal(bad.status, 403);

    const sdk = await fetch(`${base}/sdk/experience/index.js`);
    assert.equal(sdk.status, 200);
    assert.equal(sdk.headers.get('access-control-allow-origin'), '*');
    assert.match(await sdk.text(), /KalturaAvatarSession/);

    const trav = await fetch(`${base}/sdk/..%2f..%2fpackage.json`);
    assert.equal(trav.status, 404);
  } finally {
    server.close();
  }
});
