// Lets a Slack voice clip reach an avatar that is open right now (side panel, in-message player or
// call window), so the avatar answers it out loud. Slack never gives the avatar page the microphone,
// but the page can wait for words: it long-polls /api/inbox?k=<log key>, and the app hands it the
// transcript of a clip the same user records in that conversation.
//
// Pages are grouped by channel + Slack user. A clip goes to the page that polled most recently
// (one answer, even if two avatar views are open). A page counts as open while it keeps polling.

const OPEN_FOR_MS = 8_000; // a page that polled this recently is open even between polls

export class AvatarInbox {
  /** @param {{avatarLog: import('./avatar-log.js').AvatarLog, pollMs?:number, log?:Console}} o */
  constructor({ avatarLog, pollMs = 20_000, log }) {
    this.avatarLog = avatarLog;
    this.pollMs = pollMs;
    this.log = log;
    /** channel:user -> { waiters: Array<{resolve, at}>, queue: string[], lastSeen: number } */
    this.rooms = new Map();
  }

  _room(key) {
    let r = this.rooms.get(key);
    if (!r) { r = { waiters: [], queue: [], lastSeen: 0 }; this.rooms.set(key, r); }
    return r;
  }

  /**
   * A page waits for delivered text. Resolves with the items (possibly empty after the timeout).
   * Returns null for a log key this app did not sign.
   */
  poll(k, { signal } = {}) {
    const conv = this.avatarLog.resolve(k);
    if (!conv) return null;
    const key = `${conv.channel}:${conv.slackUserId}`;
    const room = this._room(key);
    if (!room.waiters.length && Date.now() - room.lastSeen > OPEN_FOR_MS) this.log?.info?.(`[inbox] avatar open and listening for voice clips (${key})`);
    room.lastSeen = Date.now();
    if (room.queue.length) return Promise.resolve(room.queue.splice(0));
    return new Promise((resolve) => {
      const w = { resolve, at: Date.now() };
      const done = (items) => {
        clearTimeout(timer);
        room.waiters = room.waiters.filter((x) => x !== w);
        room.lastSeen = Date.now();
        resolve(items);
      };
      w.resolve = done;
      const timer = setTimeout(() => done([]), this.pollMs);
      signal?.addEventListener('abort', () => done([]), { once: true });
      room.waiters.push(w);
    });
  }

  /** Is an avatar open for this user in this channel right now? */
  isOpen(channel, slackUserId) {
    const r = this.rooms.get(`${channel}:${slackUserId}`);
    return Boolean(r && (r.waiters.length || Date.now() - r.lastSeen < OPEN_FOR_MS));
  }

  /** Hand text to the open avatar. Returns false when none is open (the caller answers in Slack instead). */
  deliver(channel, slackUserId, text) {
    const r = this.rooms.get(`${channel}:${slackUserId}`);
    if (!r || !this.isOpen(channel, slackUserId)) return false;
    if (r.waiters.length) {
      const latest = r.waiters.reduce((a, b) => (b.at > a.at ? b : a));
      latest.resolve([text]);
    } else {
      r.queue.push(text); // between two polls: picked up by the next one
    }
    return true;
  }
}
