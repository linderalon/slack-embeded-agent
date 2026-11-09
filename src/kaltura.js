// Server-side bridge to a Kaltura conversational agent, built on @kaltura/intelligent-agents.
//
// One Kaltura end-user identity per Slack user (so threads and feedback stay private),
// one Kaltura thread per Slack thread + user (so the agent keeps memory across turns).

import { Management } from '@kaltura/intelligent-agents/management';
import { ExperienceRenderer } from '@kaltura/intelligent-agents/experience/genui';

const TOKEN_REFRESH_MARGIN_S = 300;
const SPOKEN_TYPES = new Set(['text', 'avatar']); // reply text; 'avatar' is how avatar-enabled agents stream it

/** Kaltura userId for a Slack user. Stable, so Kaltura analytics and lifecycle rules see one person. */
export const kalturaUserId = (teamId, userId) => `slack-${teamId || 'T'}-${userId}`;

export class KalturaBridge {
  /**
   * @param {object} cfg  the `kaltura` block of loadConfig()
   * @param {{management?: object, threadStore?: Map<string,string>}} [deps]  injectable for tests
   */
  constructor(cfg, deps = {}) {
    this.cfg = cfg;
    this.mgmt = deps.management || new Management({
      partnerId: cfg.partnerId,
      adminSecret: cfg.adminSecret,
      ...(cfg.region ? { region: cfg.region } : {}),
    });
    this.renderer = new ExperienceRenderer({
      partnerId: cfg.partnerId,
      ...(cfg.uiConfId ? { uiConfId: cfg.uiConfId } : {}),
    });
    /** @type {Map<string,{ks:string, expiresAt:number}>} */
    this.tokens = new Map();
    /** Slack thread key -> Kaltura threadId. In-memory: swap for Redis/DB in production. */
    this.threads = deps.threadStore || new Map();
  }

  /** A per-user agent token (KS), cached until shortly before it expires. */
  async tokenFor(userId) {
    const now = Math.floor(Date.now() / 1000);
    const hit = this.tokens.get(userId);
    if (hit && (!hit.expiresAt || hit.expiresAt - TOKEN_REFRESH_MARGIN_S > now)) return hit.ks;
    const tok = await this.mgmt.sessions.createAgentToken({
      agentId: this.cfg.agentId,
      ...(this.cfg.configId ? { configId: this.cfg.configId } : {}),
      userId,
      ttlSeconds: this.cfg.tokenTtlSeconds,
    });
    this.tokens.set(userId, { ks: tok.ks, expiresAt: tok.expiresAt || 0 });
    return tok.ks;
  }

  getThread(threadKey) { return this.threads.get(threadKey); }

  /**
   * Run one user turn and yield normalized events:
   *   {type:'status', text}             thinking / tool progress
   *   {type:'text', text}               a chunk of the reply (markdown)
   *   {type:'auth', url, name}          the agent's tool needs the user to sign in (OAuth)
   *   {type:'error', message, code}     the turn failed or was refused
   *   {type:'done', threadId, messageId, widgets}   always last (unless aborted)
   * @param {{userId:string, threadKey:string, text:string, signal?:AbortSignal}} turn
   */
  async *turn({ userId, threadKey, text, signal }) {
    let threadId = this.threads.get(threadKey);
    let attempt = 0;
    while (true) {
      try {
        yield* this._turnOnce({ userId, threadKey, threadId, text, signal });
        return;
      } catch (err) {
        if (signal?.aborted) return;
        // A stale or foreign threadId (for example after a token/user change): start a fresh thread once.
        if (err?.code === 'thread_access_denied' && threadId && attempt === 0) {
          this.threads.delete(threadKey);
          threadId = undefined;
          attempt++;
          continue;
        }
        yield { type: 'error', code: err?.code || 'kaltura_error', message: describeError(err) };
        yield { type: 'done', threadId, messageId: undefined, widgets: [] };
        return;
      }
    }
  }

  async *_turnOnce({ userId, threadKey, threadId, text, signal }) {
    const ks = await this.tokenFor(userId);
    const opts = { userMessage: text, ...(threadId ? { threadId } : {}), signal };
    if (this.cfg.modelType) opts.model_type = this.cfg.modelType;

    let messageId;
    let sawText = false;
    /** @type {Map<number|string,{runtimeName:string, parts:string[], obj?:unknown}>} */
    const widgets = new Map();
    let widgetSeq = 0;

    for await (const seg of this.mgmt.conversations.stream(opts, ks)) {
      if (seg.threadId && seg.threadId !== threadId) {
        threadId = seg.threadId;
        this.threads.set(threadKey, threadId);
      }
      if (seg.messageId) messageId = seg.messageId;

      switch (seg.type) {
        case 'think':
          if (!sawText) yield { type: 'status', text: 'Thinking…' };
          break;
        case 'tool': {
          const name = seg.metadata?.tool_display_name || seg.metadata?.tool_name || seg.tool_metadata?.name;
          if (name) yield { type: 'status', text: `Using ${name}…` };
          break;
        }
        case 'avatar-filler':
          // Spoken stalling phrases ("one moment…") — show as status, not as reply text.
          if (typeof seg.content === 'string' && seg.content.trim()) yield { type: 'status', text: seg.content.trim() };
          break;
        case 'unisphere-tool': {
          const key = seg.segmentNumber ?? (seg.segmentStart ? ++widgetSeq : widgetSeq);
          const runtimeName = seg.metadata?.runtimeName || '';
          const w = widgets.get(key) || { runtimeName, parts: [] };
          if (!w.runtimeName && runtimeName) w.runtimeName = runtimeName;
          if (typeof seg.content === 'string') w.parts.push(seg.content);
          else if (seg.content && typeof seg.content === 'object') w.obj = seg.content;
          widgets.set(key, w);
          break;
        }
        case 'interruption':
          if (seg.metadata?.subtype === 'oauth_required' && seg.content && typeof seg.content === 'object' && seg.content.auth_url) {
            yield { type: 'auth', url: seg.content.auth_url, name: seg.metadata?.tool_display_name || seg.metadata?.tool_name || 'this tool' };
          }
          break;
        case 'error':
          yield { type: 'error', code: 'stream_error', message: typeof seg.content === 'string' ? seg.content : 'The agent could not answer this turn.' };
          break;
        default:
          if (SPOKEN_TYPES.has(seg.type) && typeof seg.content === 'string' && seg.content) {
            sawText = true;
            yield { type: 'text', text: seg.content };
          }
      }
    }

    const rendered = [];
    for (const w of widgets.values()) {
      if (!w.runtimeName) continue;
      const body = w.obj !== undefined ? w.obj : w.parts.join('');
      const d = this.renderer.render(w.runtimeName, body);
      if (d && d.kind !== 'unknown' && d.kind !== 'error') rendered.push({ kind: d.kind, data: d.data });
    }
    yield { type: 'done', threadId, messageId, widgets: rendered };
  }

  async feedback({ userId, messageId, positive, comment }) {
    const ks = await this.tokenFor(userId);
    return this.mgmt.feedback.add({ message_id: messageId, is_positive: positive, ...(comment ? { comment } : {}) }, ks);
  }

  /**
   * Runtime endpoints + a conversation KS for the browser avatar page.
   * Uses the same per-user agent token, so the avatar can continue the user's Slack thread.
   */
  async avatarInit(userId) {
    const ks = await this.tokenFor(userId);
    const init = await this.mgmt.application.appInit(ks);
    return {
      ks: init.ks || ks,
      conversationManagerUrl: init.conversationManagerUrl,
      srsBaseUrl: init.srsBaseUrl,
      turnServerUrl: init.turnServerUrl,
    };
  }
}

function describeError(err) {
  if (!err) return 'Unknown error';
  const parts = [err.title, err.detail].filter(Boolean);
  return parts.length ? parts.join(': ') : String(err.message || err);
}
