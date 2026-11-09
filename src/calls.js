// Live voice calls with the avatar, shown in Slack as a native call card (Slack Calls API).
// Slack apps can't hear the microphone inside Slack, so the call itself runs in a browser window
// (the avatar's call page). Slack shows the call card, who joined and when it ended.
//
// A call link carries a random key `k` (in addition to the signed avatar link). The call page
// reports /api/call/start and /api/call/end with that key; the key maps to the Slack call here.

import crypto from 'node:crypto';

const MAX_CALLS = 500;

export class CallManager {
  /** @param {{client:any, log?:Console}} o  client: Slack WebClient (calls:write, chat:write) */
  constructor({ client, log = console }) {
    this.client = client;
    this.log = log;
    /** @type {Map<string,{channel:string, slackUserId:string, joinUrl?:string, callId?:string, startedAt?:number, messageTs?:string, ended?:boolean}>} */
    this.calls = new Map();
  }

  /**
   * Reserve a call for a user in a DM/channel.
   * @param {{channel:string, slackUserId:string, joinUrlFor:(k:string)=>string}} o  joinUrlFor builds the call page link for the key
   * @returns {{k:string, joinUrl:string}}
   */
  reserve({ channel, slackUserId, joinUrlFor }) {
    const k = crypto.randomBytes(18).toString('base64url');
    const joinUrl = joinUrlFor(k);
    this.calls.set(k, { channel, slackUserId, joinUrl });
    if (this.calls.size > MAX_CALLS) this.calls.delete(this.calls.keys().next().value);
    return { k, joinUrl };
  }

  get(k) { return this.calls.get(k); }

  /** Register the call with Slack and post its card (once). */
  async open(k) {
    const c = this.calls.get(k);
    if (!c) return null;
    if (c.callId) return c;
    const joinUrl = c.joinUrl;
    const res = await this.client.apiCall('calls.add', {
      external_unique_id: k,
      join_url: joinUrl,
      title: 'Live call with the Kaltura avatar',
      created_by: c.slackUserId,
      date_start: Math.floor(Date.now() / 1000),
    });
    c.callId = res.call?.id;
    const msg = await this.client.chat.postMessage({
      channel: c.channel,
      text: 'Live call with the Kaltura avatar',
      blocks: [{ type: 'call', call_id: c.callId }],
    });
    c.messageTs = msg.ts;
    return c;
  }

  /** The call page connected: make sure the card exists and show the user as joined. */
  async started(k) {
    const c = this.calls.get(k);
    if (!c) return false;
    // The same link used again after hanging up starts a new Slack call.
    if (c.ended) Object.assign(c, { ended: false, callId: undefined, startedAt: undefined, messageTs: undefined });
    await this.open(k);
    if (!c.startedAt) c.startedAt = Date.now();
    await this.client.apiCall('calls.participants.add', { id: c.callId, users: [{ slack_id: c.slackUserId }] })
      .catch((err) => this.log.warn('[calls] participants.add failed:', err?.data?.error || err?.message));
    return true;
  }

  /** The call page hung up (End call, or the window closed). */
  async ended(k) {
    const c = this.calls.get(k);
    if (!c || c.ended || !c.callId) return false;
    c.ended = true;
    const duration = c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : undefined;
    await this.client.apiCall('calls.end', { id: c.callId, ...(duration ? { duration } : {}) })
      .catch((err) => this.log.warn('[calls] calls.end failed:', err?.data?.error || err?.message));
    return true;
  }
}
