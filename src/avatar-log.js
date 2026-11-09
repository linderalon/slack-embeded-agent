// Writes what was said with the avatar into the Slack conversation it was opened from.
//
// Every avatar link the app hands out carries a log key `lk`; the avatar page reports each finished
// exchange (the user's words + the avatar's answer) to /api/log?k=<lk>. The key is signed (HMAC) and
// names the conversation itself, so it keeps working after the app restarts.
//
// The exchanges go into ONE "Avatar conversation" message per conversation, which is edited as the
// conversation goes on. Slack reloads its in-message video player when the conversation scrolls
// (a new message at the bottom does that), but not when another message is edited, so the app posts
// the transcript message before the player is used (ensureTranscript) and then only edits it.

import crypto from 'node:crypto';

const MAX_BLOCKS = 46; // Slack allows 50 blocks per message; start a new transcript message before that
export const TRANSCRIPT = 'kaltura_transcript';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const convKey = ({ channel, slackUserId, threadTs }) => `${channel}:${threadTs || 'main'}:${slackUserId}`;

const header = (empty) => ({
  type: 'context',
  block_id: `${TRANSCRIPT}:${Date.now()}`,
  elements: [{ type: 'mrkdwn', text: empty
    ? ':memo: *Avatar conversation.* What you and the avatar say will be written here.'
    : ':memo: *Avatar conversation*' }],
});

export class AvatarLog {
  /** @param {{client:any, secret:string, log?:Console}} o  client: Slack WebClient (chat:write, im:history); secret signs log keys */
  constructor({ client, secret, log = console }) {
    if (!secret) throw new Error('AvatarLog needs a signing secret');
    this.client = client;
    this.secret = secret;
    this.log = log;
    /** conversation -> { ts, blocks } (the transcript message) */
    this.transcripts = new Map();
    this.queues = new Map();
  }

  _mac(data) { return crypto.createHmac('sha256', this.secret).update(`avatar-log:${data}`).digest('base64url').slice(0, 32); }

  /** A log key for one avatar link. threadTs: that thread's conversation; omit for the top level. */
  reserve({ channel, slackUserId, threadTs }) {
    const data = Buffer.from(JSON.stringify({ c: channel, u: slackUserId, ...(threadTs ? { t: threadTs } : {}) })).toString('base64url');
    return `${data}.${this._mac(data)}`;
  }

  /** The conversation a log key names, or null if it was not signed by this app. */
  resolve(k) {
    const [data, sig] = String(k || '').split('.');
    if (!data || !sig) return null;
    const want = Buffer.from(this._mac(data));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    try {
      const { c, u, t } = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
      return c && u ? { channel: c, slackUserId: u, ...(t ? { threadTs: t } : {}) } : null;
    } catch { return null; }
  }

  has(k) { return this.resolve(k) !== null; }

  /** Blocks for one exchange. */
  static exchangeBlocks({ user, agent }) {
    return [
      { type: 'context', elements: [{ type: 'mrkdwn', text: `:speaking_head_in_silhouette: *You:* ${esc(user).slice(0, 2900)}` }] },
      { type: 'markdown', text: String(agent).slice(0, 3000) },
    ];
  }

  /** Find this conversation's latest transcript message (after a restart). */
  async _find(conv) {
    const { channel, threadTs } = conv;
    try {
      const res = threadTs
        ? await this.client.conversations.replies({ channel, ts: threadTs, limit: 100 })
        : await this.client.conversations.history({ channel, limit: 100 });
      const msgs = [...(res.messages || [])].sort((a, b) => Number(b.ts) - Number(a.ts));
      const m = msgs.find((x) => (x.blocks || []).some((b) => String(b.block_id || '').startsWith(`${TRANSCRIPT}:`)));
      return m ? { ts: m.ts, blocks: m.blocks } : null;
    } catch (err) {
      this.log.warn('[avatar-log] lookup failed:', err?.data?.error || err?.message);
      return null;
    }
  }

  /**
   * Make sure the conversation has a transcript message, posting an empty one if needed. Call this
   * before the avatar player is used, so later exchanges only edit it.
   */
  async ensureTranscript({ channel, slackUserId, threadTs }) {
    const conv = { channel, slackUserId, threadTs };
    const key = convKey(conv);
    let t = this.transcripts.get(key) || await this._find(conv);
    if (!t) {
      const blocks = [header(true)];
      const res = await this.client.chat.postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), text: 'Avatar conversation', blocks });
      t = { ts: res.ts, blocks };
    }
    this.transcripts.set(key, t);
    return t;
  }

  /** Start a fresh transcript next time (e.g. after "New conversation"). */
  forget({ channel, slackUserId, threadTs }) { this.transcripts.delete(convKey({ channel, slackUserId, threadTs })); }

  /** Add one exchange to the conversation's transcript message. Returns false for an unknown key or empty input. */
  async post(k, { user, agent }) {
    const conv = this.resolve(k);
    if (!conv || !String(user || '').trim() || !String(agent || '').trim()) return false;
    const key = convKey(conv);
    // One exchange at a time per conversation, so edits never overwrite each other.
    const prev = this.queues.get(key) || Promise.resolve();
    const run = prev.then(() => this._append(conv, key, { user, agent }));
    this.queues.set(key, run.catch(() => {}));
    await run;
    return true;
  }

  async _append(conv, key, exchange) {
    let t = this.transcripts.get(key) || await this._find(conv);
    const add = AvatarLog.exchangeBlocks(exchange);
    const text = `Avatar conversation: You: ${exchange.user}`.slice(0, 3900);
    if (!t || t.blocks.length + add.length > MAX_BLOCKS) {
      // No transcript yet (e.g. a live call), or the current one is full: start a new message.
      const blocks = [header(false), ...add];
      const res = await this.client.chat.postMessage({ channel: conv.channel, ...(conv.threadTs ? { thread_ts: conv.threadTs } : {}), text, blocks });
      this.transcripts.set(key, { ts: res.ts, blocks });
      return;
    }
    const blocks = [header(false), ...t.blocks.filter((b) => !String(b.block_id || '').startsWith(`${TRANSCRIPT}:`)), ...add];
    await this.client.chat.update({ channel: conv.channel, ts: t.ts, text, blocks });
    this.transcripts.set(key, { ts: t.ts, blocks });
  }
}
