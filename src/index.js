// Entry point: Slack (Socket Mode) + the avatar embed server.

import bolt from '@slack/bolt';
import { loadConfig } from './config.js';
import { KalturaBridge } from './kaltura.js';
import { createMockManagement } from './mock-kaltura.js';
import { registerSlackHandlers } from './slack.js';
import { createEmbedServer } from './embed.js';
import { CallManager } from './calls.js';
import { AvatarLog } from './avatar-log.js';
import { AvatarInbox } from './inbox.js';

const { App, LogLevel } = bolt;

const cfg = loadConfig();
const bridge = new KalturaBridge(cfg.kaltura, cfg.kaltura.mock ? { management: createMockManagement() } : {});

const app = new App({
  token: cfg.slack.botToken,
  appToken: cfg.slack.appToken,
  socketMode: true,
  logLevel: process.env.SLACK_LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
});
const calls = new CallManager({ client: app.client, log: console });
const avatarLog = cfg.avatar.enabled ? new AvatarLog({ client: app.client, secret: cfg.avatar.signingSecret, log: console }) : undefined;
const inbox = avatarLog ? new AvatarInbox({ avatarLog, log: console }) : undefined;
registerSlackHandlers(app, { bridge, cfg, calls, avatarLog, inbox, log: console });

app.error(async (err) => { console.error('[bolt]', err?.code || '', err?.message || err); });

await app.start();
console.log(`Slack agent connected (Socket Mode).${cfg.kaltura.mock ? ' Using the MOCK Kaltura agent.' : ` Kaltura agent ${cfg.kaltura.agentId}.`}`);

const server = createEmbedServer({ bridge, cfg, calls, avatarLog, inbox });
server.listen(cfg.port, () => {
  console.log(cfg.avatar.enabled
    ? `Avatar embed server on :${cfg.port}, public at ${cfg.avatar.publicBaseUrl}`
    : `Avatar panel off (set PUBLIC_BASE_URL to turn it on). Health check on :${cfg.port}/healthz`);
});

const shutdown = async () => { server.close(); await app.stop().catch(() => {}); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
