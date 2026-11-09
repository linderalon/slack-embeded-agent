// Read-only: show a Slack user's most recent Genie threads and what Kaltura stored on them
// (thread_metadata.analysis, where the end-of-call summary lands) plus the transcript length.
//   node --env-file=.env scripts/last-thread.mjs <slackDmChannelId>
import { Management } from '@kaltura/intelligent-agents/management';
const e = process.env;
const im = process.argv[2];
const info = await fetch(`https://slack.com/api/conversations.info?channel=${im}`, { headers: { Authorization: `Bearer ${e.SLACK_BOT_TOKEN}` } }).then((r) => r.json());
const auth = await fetch('https://slack.com/api/auth.test', { headers: { Authorization: `Bearer ${e.SLACK_BOT_TOKEN}` } }).then((r) => r.json());
const userId = `slack-${auth.team_id}-${info.channel?.user}`;
const m = new Management({ partnerId: e.KALTURA_PARTNER_ID, adminSecret: e.KALTURA_ADMIN_SECRET });
const { ks } = await m.sessions.createAgentToken({ agentId: e.KALTURA_AGENT_ID, configId: e.KALTURA_CONFIG_ID, userId, ttlSeconds: 600 });
const out = [];
for await (const t of m.threads.list(ks, { filter: { orderBy: '-updatedAt' }, pageSize: 10 })) { out.push(t); if (out.length >= 6) break; }
out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
for (const t of out.slice(0, 4)) {
  const tr = await m.threads.transcript(t.id, ks).catch((err) => ({ data: 'transcript error: ' + err.message }));
  const text = typeof tr?.data === 'string' ? tr.data : JSON.stringify(tr?.data ?? tr);
  console.log(JSON.stringify({ updated: t.updated_at, title: t.title, origin: t.origin, analysis: t.thread_metadata?.analysis ?? null,
    transcriptTurns: (text.match(/^(human|ai):/gm) || []).length, transcriptStart: text.slice(0, 160) }));
}
