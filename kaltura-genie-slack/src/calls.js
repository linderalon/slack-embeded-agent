// Genie voice calls shown in Slack as a native call card (Slack Calls API), the way Zoom and Meet
// integrate: Slack gives apps no microphone, so the call itself runs in a browser window that
// Kaltura's Genie avatar controls (mic, audio, video). Slack shows the card, who joined, when it ended.
//
// Each call has a random capability key `k`. The card's Join URL is /call/<k>; the key maps to the
// Slack user it was created for and expires. The call page reports start/end with the key.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_CALLS = 1000;

export class CallManager {
  /** @param {{client?:any, joinUrlFor:(k:string)=>string, ttlSeconds?:number, log?:Console, now?:()=>number}} o */
  /** file: optional JSON file so call links and cards survive a server restart */
  constructor({ client, joinUrlFor, ttlSeconds = 12 * 3600, log = console, now = Date.now, file }) {
    Object.assign(this, { client, joinUrlFor, ttlMs: ttlSeconds * 1000, log, now, file });
    /** @type {Map<string,{teamId:string, slackUserId:string, channel?:string, expiresAt:number, callId?:string, messageTs?:string, startedAt?:number, ended?:boolean, threadId?:string, recap?:object}>} */
    this.calls = new Map();
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, c] of rows) if (c.expiresAt > this.now()) this.calls.set(k, c);
    } catch (err) { if (err.code !== 'ENOENT') this.log.warn('[calls] could not read', this.file, err.message); }
  }

  /** Write-through save (small file, a few rows): temp file + rename so a crash never leaves half a file. */
  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const rows = [...this.calls].filter(([, c]) => c.expiresAt > this.now()).map(([k, c]) => [k, { ...c, recap: undefined }]);
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(rows), { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (err) { this.log.warn('[calls] could not save', err.message); }
  }

  /**
   * After a restart: calls that were live when the server stopped can never report their end,
   * so end them in Slack now (otherwise their cards stay "Waiting for people to join" / "in progress").
   */
  async endOrphans() {
    for (const [k, c] of this.calls) if (c.startedAt && !c.ended) await this.ended(k);
  }

  /** New call key for a Slack user. @returns {{k:string, joinUrl:string}} */
  reserve({ teamId, slackUserId, channel }) {
    const k = crypto.randomBytes(18).toString('base64url');
    this.calls.set(k, { teamId, slackUserId, channel, expiresAt: this.now() + this.ttlMs });
    if (this.calls.size > MAX_CALLS) this.calls.delete(this.calls.keys().next().value);
    this.save();
    return { k, joinUrl: this.joinUrlFor(k) };
  }

  /** @returns the call for a valid, unexpired key, else undefined */
  get(k) {
    if (typeof k !== 'string' || !/^[\w-]{20,40}$/.test(k)) return undefined;
    const c = this.calls.get(k);
    if (!c || c.expiresAt < this.now()) return undefined;
    return c;
  }

  /** Register the call with Slack and post its native call card in the conversation. */
  async post(k) {
    const c = this.get(k);
    if (!c || !this.client) return null;
    const res = await this.client.apiCall('calls.add', {
      external_unique_id: k,
      join_url: this.joinUrlFor(k),
      title: 'Call with Kaltura Genie',
      created_by: c.slackUserId,
      date_start: Math.floor(this.now() / 1000),
    });
    Object.assign(c, { callId: res.call?.id, ended: false });
    const msg = await this.client.chat.postMessage({
      channel: c.channel,
      text: 'Call with Kaltura Genie',
      blocks: [{ type: 'call', call_id: c.callId }],
    });
    c.messageTs = msg.ts;
    this.save();
    return c;
  }

  /** The call page connected to Genie: show the user as joined (re-opening the card if it had ended). */
  async started(k) {
    const c = this.get(k);
    if (!c) return false;
    if (this.client && (c.ended || !c.callId)) await this.post(k);
    c.ended = false;
    if (!c.startedAt) c.startedAt = this.now();
    this.save();
    if (!this.client) return true;
    await this.client.apiCall('calls.participants.add', { id: c.callId, users: [{ slack_id: c.slackUserId }] })
      .catch((err) => this.log.warn('[calls] participants.add failed:', err?.data?.error || err?.message));
    return true;
  }

  /** The call page hung up (End, disconnect, or the window closed). */
  async ended(k, { threadId } = {}) {
    const c = this.get(k);
    if (!c || c.ended || !c.startedAt) return false;
    c.ended = true;
    if (typeof threadId === 'string' && /^[\w-]{8,64}$/.test(threadId)) c.threadId = threadId;
    c.recap = undefined;
    const duration = Math.round((this.now() - c.startedAt) / 1000);
    c.startedAt = undefined;
    this.save();
    if (this.client && c.callId) {
      await this.client.apiCall('calls.end', { id: c.callId, duration })
        .catch((err) => this.log.warn('[calls] calls.end failed:', err?.data?.error || err?.message));
    }
    return true;
  }
}
