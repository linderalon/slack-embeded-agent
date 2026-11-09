// A stand-in for the Kaltura Management client (MOCK_KALTURA=1), so the Slack side can be
// tried and tested without Kaltura credentials. It streams segments in the same shape as
// POST /assistant/converse: think -> tool -> text chunks -> GenUI widgets -> final.

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

export function createMockManagement({ delayMs = 120 } = {}) {
  let n = 0;
  const feedback = [];
  return {
    feedbackLog: feedback,
    sessions: {
      async createAgentToken({ userId, ttlSeconds = 3600 }) {
        return { ks: `mock-ks-${userId}`, expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds };
      },
    },
    conversations: {
      async *stream(opts) {
        const threadId = opts.threadId || `mock-thread-${++n}`;
        const messageId = `mock-msg-${Date.now()}`;
        yield { type: 'think', threadId, messageId };
        await sleep(delayMs, opts.signal);
        yield { type: 'tool', metadata: { tool_display_name: 'Video library search' }, threadId };
        const reply = `You said: **${opts.userMessage}**.\n\nThis is the mock Kaltura agent. Set MOCK_KALTURA=0 and add your Kaltura credentials to talk to the real one.`;
        for (const word of reply.split(/(?<= )/)) {
          await sleep(delayMs / 4, opts.signal);
          yield { type: 'text', content: word, threadId, messageId };
        }
        yield {
          type: 'unisphere-tool', segmentNumber: 1, segmentStart: true,
          metadata: { runtimeName: 'followups-tool' },
          content: JSON.stringify({ followups: ['What else can you do?', 'Show me a video'] }),
        };
        if (/video|clip/i.test(opts.userMessage)) {
          yield {
            type: 'unisphere-tool', segmentNumber: 2, segmentStart: true,
            metadata: { runtimeName: 'video-gallery-tool' },
            content: 'videos:\n  - entryId: 1_mockclip\n    title: Getting started\n    startTime: 12\n    endTime: 48',
          };
        }
        yield { type: 'text', content: '', isFinal: true, threadId, messageId };
      },
    },
    feedback: {
      async add(data) { feedback.push(data); return { ok: true }; },
    },
    application: {
      async appInit() {
        throw Object.assign(new Error('The avatar needs a real Kaltura account (MOCK_KALTURA is on).'), { code: 'mock_mode' });
      },
    },
  };
}
