// Streams one agent reply into a Slack thread with chat.startStream / appendStream / stopStream,
// batching small chunks so we stay inside Slack's rate limits.

const MAX_STREAM_CHARS = 11_000; // Slack caps a stream at 12,000 characters of markdown in total

export class SlackReplyStream {
  /**
   * @param {{client:any, channel:string, threadTs:string, recipientUserId?:string, recipientTeamId?:string, flushMs?:number, log?:Console}} o
   *   recipient* are required by Slack when streaming in channels (not in DMs).
   */
  constructor(o) {
    this.client = o.client;
    this.channel = o.channel;
    this.threadTs = o.threadTs;
    this.recipient = o.recipientUserId && o.recipientTeamId
      ? { recipient_user_id: o.recipientUserId, recipient_team_id: o.recipientTeamId } : {};
    this.flushMs = o.flushMs ?? 800;
    this.log = o.log || console;
    this.ts = null;           // ts of the streaming message, once started
    this.pending = '';        // text not yet sent
    this.sent = 0;            // characters sent in the current stream
    this.text = '';           // full reply text (fallback for notifications / postMessage)
    this.timer = null;
    this.chain = Promise.resolve();
    this.failed = false;      // streaming unavailable -> post the whole reply at the end
  }

  get started() { return this.ts !== null; }

  append(text) {
    if (!text) return;
    this.text += text;
    this.pending += text;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this._enqueue(() => this._flush()); }, this.flushMs);
  }

  _enqueue(fn) {
    this.chain = this.chain.then(fn).catch((err) => this.log.warn('[stream] ', err?.data?.error || err?.message || err));
    return this.chain;
  }

  async _flush() {
    if (this.failed || !this.pending) return;
    let chunk = this.pending;
    this.pending = '';
    // Roll over to a new message before hitting Slack's per-stream text limit.
    if (this.started && this.sent + chunk.length > MAX_STREAM_CHARS) {
      await this.client.apiCall('chat.stopStream', { channel: this.channel, ts: this.ts });
      this.ts = null;
      this.sent = 0;
    }
    if (!this.started) {
      try {
        const res = await this.client.apiCall('chat.startStream', {
          channel: this.channel, thread_ts: this.threadTs, markdown_text: chunk, ...this.recipient,
        });
        this.ts = res.ts;
        this.sent = chunk.length;
      } catch (err) {
        this.log.warn('[stream] chat.startStream failed, will post the reply instead:', err?.data?.error || err?.message);
        this.failed = true;
      }
      return;
    }
    await this.client.apiCall('chat.appendStream', { channel: this.channel, ts: this.ts, markdown_text: chunk });
    this.sent += chunk.length;
  }

  /** Flush what is left. Resolves when every queued Slack call has finished. */
  async drain() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this._enqueue(() => this._flush());
  }

  /**
   * Finish the reply and attach blocks (widgets, feedback, buttons).
   * Tries the full blocks, then `fallbackBlocks` (e.g. clips as links), then text only + a separate post.
   * @param {{blocks?:object[], fallbackBlocks?:object[], fallbackText?:string}} o
   */
  async finish({ blocks = [], fallbackBlocks, fallbackText = 'Reply from the agent' } = {}) {
    await this.drain();
    const text = this.text.trim();

    if (this.failed || !this.started) {
      // Never streamed (widget-only answer, or streaming unavailable): one regular message.
      const textBlocks = text ? [{ type: 'markdown', text: text.slice(0, 12_000) }] : [];
      return this._postWithFallback([...textBlocks, ...blocks], fallbackBlocks && [...textBlocks, ...fallbackBlocks], text || fallbackText);
    }

    const attempts = [blocks, fallbackBlocks].filter((b) => b && b.length);
    for (const b of attempts) {
      try {
        await this.client.apiCall('chat.stopStream', { channel: this.channel, ts: this.ts, blocks: b });
        return;
      } catch (err) {
        const code = err?.data?.error;
        if (code !== 'invalid_blocks' && code !== 'invalid_arguments') throw err;
        this.log.warn('[stream] stopStream rejected blocks:', code, JSON.stringify(err?.data?.response_metadata?.messages || []));
      }
    }
    await this.client.apiCall('chat.stopStream', { channel: this.channel, ts: this.ts });
    if (attempts.length) await this._postWithFallback(blocks, fallbackBlocks, fallbackText);
  }

  /** Close the stream early (user pressed stop). */
  async abort(note = '_Stopped._') {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.chain;
    this.pending = '';
    if (this.started && !this.failed) {
      await this.client.apiCall('chat.stopStream', { channel: this.channel, ts: this.ts, markdown_text: `\n\n${note}` }).catch(() => {});
    }
  }

  async _postWithFallback(blocks, fallbackBlocks, text) {
    const post = (b) => this.client.chat.postMessage({ channel: this.channel, thread_ts: this.threadTs, text, ...(b && b.length ? { blocks: b } : {}) });
    try { return await post(blocks); } catch (err) {
      if (err?.data?.error !== 'invalid_blocks' || !fallbackBlocks) throw err;
      this.log.warn('[stream] postMessage rejected blocks, retrying with fallback blocks');
      return post(fallbackBlocks);
    }
  }
}

// ── Thread-free replies ───────────────────────────────────────────────────────
// Slack's streaming API and agent "Working…" status only work inside threads. For a
// top-level conversation (no threads), post one reply message and edit it as the agent
// writes, with a Stop button while it works.

const MAX_MARKDOWN = 11_500; // Slack's markdown block holds 12,000 characters

export class SlackUpdateReply {
  /**
   * @param {{client:any, channel:string, threadTs?:string, stopValue:string, stopActionId:string, flushMs?:number, log?:Console, ts?:string, header?:string}} o
   *   threadTs: only when the conversation is already inside a thread; omit for a top-level reply.
   *   ts: reuse a message the app already posted (e.g. "Listening…") instead of posting a new one.
   *   header: mrkdwn line shown above the reply (e.g. what the user said in a voice clip).
   */
  constructor(o) {
    this.client = o.client;
    this.channel = o.channel;
    this.threadTs = o.threadTs;
    this.stop = { actionId: o.stopActionId, value: o.stopValue };
    this.flushMs = Math.max(o.flushMs ?? 1500, 1000); // chat.update is Tier 3 (~50/min)
    this.log = o.log || console;
    this.ts = o.ts || null;
    this.header = o.header || '';
    this.text = '';
    this.status = 'Thinking…';
    this.dirty = false;
    this.timer = null;
    this.chain = Promise.resolve();
    this.closed = false;
  }

  get started() { return this.ts !== null; }

  /** Post the placeholder reply right away, so the user sees the agent is working. */
  async start() {
    if (this.ts) {
      await this.client.chat.update({ channel: this.channel, ts: this.ts, text: this.status, blocks: this._workingBlocks() });
      return;
    }
    const res = await this.client.chat.postMessage({
      channel: this.channel, ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
      text: this.status, blocks: this._workingBlocks(),
    });
    this.ts = res.ts;
  }

  setStatus(text) {
    if (this.text || !text || text === this.status) return; // once text flows, it is the progress
    this.status = text;
    this._schedule();
  }

  append(text) {
    if (!text) return;
    this.text += text;
    this._schedule();
  }

  _schedule() {
    this.dirty = true;
    if (!this.timer && !this.closed) {
      this.timer = setTimeout(() => { this.timer = null; this._enqueue(() => this._flush()); }, this.flushMs);
    }
  }

  _enqueue(fn) {
    this.chain = this.chain.then(fn).catch((err) => this.log.warn('[reply] ', err?.data?.error || err?.message || err));
    return this.chain;
  }

  async _flush() {
    if (!this.dirty || this.closed || !this.started) return;
    this.dirty = false;
    await this.client.chat.update({ channel: this.channel, ts: this.ts, text: this._plain(), blocks: this._workingBlocks() });
  }

  _plain() { return (this.text || this.status).slice(0, 3900); }
  _head() { return this.header ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: this.header.slice(0, 3000) }] }] : []; }
  _textBlock(cursor = '') {
    const t = this.text.length > MAX_MARKDOWN ? `${this.text.slice(0, MAX_MARKDOWN)}…` : this.text;
    return { type: 'markdown', text: `${t}${cursor}` };
  }
  _workingBlocks() {
    const head = this.text
      ? this._textBlock(' ▍')
      : { type: 'context', elements: [{ type: 'mrkdwn', text: `_${this.status.replace(/[_*~`]/g, '')}_` }] };
    return [...this._head(), head, {
      type: 'actions',
      elements: [{ type: 'button', action_id: this.stop.actionId, value: this.stop.value, text: { type: 'plain_text', text: 'Stop' } }],
    }];
  }

  async _settle() {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.chain;
  }

  /** Final edit: the full reply plus widgets/feedback. Same contract as SlackReplyStream#finish. */
  async finish({ blocks = [], fallbackBlocks, fallbackText = 'Reply from the agent' } = {}) {
    await this._settle();
    const text = this.text.trim();
    const head = [...this._head(), ...(text ? [this._textBlock()] : [])];
    const attempts = [[...head, ...blocks], fallbackBlocks && [...head, ...fallbackBlocks], head.length ? head : [{ type: 'section', text: { type: 'mrkdwn', text: fallbackText } }]];
    for (const b of attempts.filter(Boolean)) {
      try {
        await this.client.chat.update({ channel: this.channel, ts: this.ts, text: (text || fallbackText).slice(0, 3900), blocks: b });
        return;
      } catch (err) {
        if (err?.data?.error !== 'invalid_blocks') throw err;
        this.log.warn('[reply] chat.update rejected blocks:', JSON.stringify(err?.data?.response_metadata?.messages || []));
      }
    }
  }

  async abort(note = 'Stopped.') {
    await this._settle();
    if (!this.started) return;
    const blocks = [...this._head(), ...(this.text ? [this._textBlock()] : []), { type: 'context', elements: [{ type: 'mrkdwn', text: `_${note}_` }] }];
    await this.client.chat.update({ channel: this.channel, ts: this.ts, text: this.text || note, blocks }).catch(() => {});
  }
}
