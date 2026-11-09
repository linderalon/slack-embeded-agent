// Serve the avatar page on http://127.0.0.1:<port> with the real Kaltura agent, for testing outside Slack.
import { loadConfig } from '../src/config.js';
import { KalturaBridge } from '../src/kaltura.js';
import { createEmbedServer, AVATAR_PATH } from '../src/embed.js';
import { signUrl } from '../src/sign.js';
process.env.SLACK_BOT_TOKEN ||= 'unused'; process.env.SLACK_APP_TOKEN ||= 'unused';
const cfg = loadConfig();
const port = Number(process.argv[2] || 4318);
const secret = cfg.avatar.signingSecret || 'local-test-secret-local-test-secret!';
const local = { ...cfg, avatar: { ...cfg.avatar, enabled: true, signingSecret: secret } };
createEmbedServer({ bridge: new KalturaBridge(cfg.kaltura), cfg: local }).listen(port, '127.0.0.1', () => {
  console.log('URL', signUrl(`http://127.0.0.1:${port}`, AVATAR_PATH, { userId: 'slack-local-test', ttlSeconds: 3600 }, secret) + '&autostart=1');
});
