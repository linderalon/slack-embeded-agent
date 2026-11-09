// Talk to the real agent through the same bridge the Slack app uses, then check avatar init.
import { loadConfig } from '../src/config.js';
import { KalturaBridge } from '../src/kaltura.js';
process.env.SLACK_BOT_TOKEN ||= 'unused'; process.env.SLACK_APP_TOKEN ||= 'unused';
const cfg = loadConfig();
const bridge = new KalturaBridge(cfg.kaltura);
const user = 'slack-smoke-test';
for (const text of ['Hi! What can you help me with?', 'Can you say that again in one short sentence?']) {
  const t0 = Date.now(); let out = ''; let done;
  for await (const ev of bridge.turn({ userId: user, threadKey: 'smoke', text })) {
    if (ev.type === 'text') out += ev.text;
    else if (ev.type === 'done') done = ev;
    else console.log(`  [${ev.type}]`, ev.text || ev.message || '');
  }
  console.log(`> ${text}\n< ${out.trim()}\n  thread=${done?.threadId} message=${done?.messageId} widgets=${JSON.stringify(done?.widgets?.map((w) => w.kind))} (${Date.now() - t0} ms)`);
}
const init = await bridge.avatarInit(user);
console.log('avatarInit:', { hasKs: !!init.ks, conversationManagerUrl: init.conversationManagerUrl, srsBaseUrl: init.srsBaseUrl, turnServerUrl: init.turnServerUrl });
