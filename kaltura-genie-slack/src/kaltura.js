// Mints the per-user KS that Kaltura's Genie embed runs on. The agent token is a USER session
// (type 0) locked to `setrole:PLAYBACK_BASE_ROLE` plus `agentid:<agent>` and `geniegpcid:<intellect>`,
// so it is safe to hand to the browser. One Kaltura identity per Slack user keeps threads private.

import { Management } from '@kaltura/intelligent-agents/management';

const GENIE_URL = process.env.KALTURA_GENIE_URL || 'https://genie.nvp1.ovp.kaltura.com';

export function createKaltura(cfg) {
  const mgmt = new Management({ partnerId: cfg.partnerId, adminSecret: cfg.adminSecret });
  return {
    partnerId: Number(cfg.partnerId),
    /** @returns {Promise<{ks:string, expiresAt:number}>} */
    async genieKs(userId) {
      const t = await mgmt.sessions.createAgentToken({
        agentId: cfg.agentId,
        ...(cfg.configId ? { configId: cfg.configId } : {}),
        userId,
        ttlSeconds: cfg.ksTtlSeconds,
      });
      return { ks: t.ks, expiresAt: t.expiresAt || 0 };
    },
    /**
     * After a call: Kaltura's end-of-call analysis (where the agent's summary lands, per the
     * intellect's avatar_summary_config) and the transcript. Read with the user's own KS, so a
     * user can only read their own threads.
     * @returns {Promise<{summary:Record<string,string>|null, turns:Array<{who:'genie'|'you', text:string}>}>}
     */
    /**
     * Tell Kaltura the conversation is over so its lifecycle rules (the end-of-call summary,
     * insights, CRM pushes) run now. Kaltura's own SDK sends this on hang-up; the Unisphere avatar
     * embed doesn't, which is why no summary appeared after a call.
     */
    async completeSession(userId, threadId) {
      const { ks } = await this.genieKs(userId);
      const res = await fetch(`${GENIE_URL}/thread/session_completed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `KS ${ks}` },
        body: JSON.stringify({ id: threadId }),
      });
      return { status: res.status, body: (await res.text()).slice(0, 300) };
    },
    async callRecap(userId, threadId) {
      const { ks } = await this.genieKs(userId);
      const [thread, tr] = await Promise.all([
        mgmt.threads.get(threadId, ks),
        mgmt.threads.transcript(threadId, ks).catch(() => null),
      ]);
      const raw = typeof tr?.data === 'string' ? tr.data : '';
      return { summary: thread?.thread_metadata?.analysis || null, turns: parseTranscript(raw) };
    },
  };
}

/** "opening: …\nhuman: …\nai: …" (one turn per line, continuation lines allowed) -> turns */
export function parseTranscript(raw) {
  const turns = [];
  for (const line of String(raw).split('\n')) {
    const m = line.match(/^(opening|human|ai):\s?(.*)$/);
    if (m) turns.push({ who: m[1] === 'human' ? 'you' : 'genie', text: m[2] });
    else if (turns.length && line.trim()) turns[turns.length - 1].text += '\n' + line;
  }
  return turns;
}
