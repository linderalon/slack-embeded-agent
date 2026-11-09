// After a Genie call: wait for Kaltura's end-of-call summary, keep it for the call page's end
// screen, and post it (with the transcript) into the Slack DM, threaded under the call card.

import { startButton } from './slack-app.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mrkdwn = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Summary text from Kaltura's analysis object (keys come from the agent's avatar_summary_config). */
export function summaryText(analysis) {
  if (!analysis || typeof analysis !== 'object') return '';
  const entries = Object.entries(analysis).filter(([, v]) => v != null && String(v).trim());
  if (entries.length === 1) return String(entries[0][1]).trim();
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
}

/** Slack blocks for the post-call message: summary, transcript, and the button for the next call. */
export function recapBlocks({ summary, turns }, startUrl) {
  const said = turns.filter((t) => t.who === 'you').length;
  const transcript = turns.map((t) => `*${t.who === 'you' ? 'You' : 'Genie'}:* ${mrkdwn(t.text)}`).join('\n');
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*Call summary*\n${mrkdwn(summary || 'Kaltura did not produce a summary for this call.')}` } },
    ...(turns.length ? [{ type: 'section', text: { type: 'mrkdwn', text: cut(`*Transcript*\n${transcript}`, 2900) } }] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${said} question${said === 1 ? '' : 's'} from you · summary and transcript from Kaltura Genie` }] },
    ...(startUrl ? [{ type: 'actions', elements: [startButton(startUrl, 'Start a new call')] }] : []),
  ];
}

/**
 * Poll Kaltura until the thread has its summary (or time runs out), store it on the call,
 * then post it in Slack. Safe to call once per call end.
 */
export async function recapCall({ calls, kaltura, k, userId, log = console, waitMs = 60000, everyMs = 3000 }) {
  const c = calls.get(k);
  if (!c?.threadId) return null;
  const threadId = c.threadId;
  let recap = { summary: '', turns: [] };
  // Kaltura only builds the summary once it hears the conversation is over.
  await kaltura.completeSession(userId, threadId)
    .then((r) => { if (r.status >= 300) log.warn('[recap] session_completed returned', r.status, r.body); })
    .catch((err) => log.warn('[recap] session_completed failed:', err?.message));
  for (let waited = 0; waited <= waitMs; waited += everyMs) {
    await sleep(everyMs);
    try {
      const r = await kaltura.callRecap(userId, threadId);
      recap = { summary: summaryText(r.summary), turns: r.turns };
      if (recap.summary) break;
    } catch (err) { log.warn('[recap] read failed:', err?.code || err?.message); }
  }
  if (c.threadId !== threadId) return null; // a newer call replaced this one
  c.recap = { ...recap, ready: true };
  log.log('[recap]', new Date().toISOString().slice(11, 19), recap.summary ? 'summary ready' : 'no summary', `${recap.turns.length} turns`);
  if (calls.client && c.channel) {
    // A new message at the bottom of the DM (right under the call card), so the newest message
    // always carries the button for the next call.
    const startUrl = calls.startUrlFor ? calls.startUrlFor(c) : undefined;
    await calls.client.chat.postMessage({
      channel: c.channel,
      text: `Call summary: ${cut(recap.summary || 'no summary', 200)}`,
      blocks: recapBlocks(recap, startUrl),
    }).catch((err) => log.warn('[recap] Slack post failed:', err?.data?.error || err?.message));
  }
  return c.recap;
}
