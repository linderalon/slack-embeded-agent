// Provision a Kaltura avatar agent from a one-line brief and save its ids to .env.
// Usage: node --env-file=.env scripts/provision.mjs "A friendly assistant that ..."
import fs from 'node:fs';
import { Management } from '@kaltura/intelligent-agents/management';

const { KALTURA_PARTNER_ID: partnerId, KALTURA_ADMIN_SECRET: adminSecret, KALTURA_REGION: region } = process.env;
if (!partnerId || !adminSecret) { console.error('Set KALTURA_PARTNER_ID and KALTURA_ADMIN_SECRET in .env'); process.exit(2); }
const brief = process.argv[2] || 'A friendly, concise assistant for employees that answers questions and finds helpful videos in the company Kaltura video library.';

const mgmt = new Management({ partnerId, adminSecret, ...(region ? { region } : {}) });
const admin = await mgmt.sessions.createAdminToken({ userId: 'slack-agent-setup', ttlSeconds: 900 });
const agent = await mgmt.provision({ brief, ks: admin.ks });
console.log('Provisioned:', { name: agent.name, agentId: agent.agentId, configId: agent.configId, avatarId: agent.avatarId, widgetId: agent.widgetId });
if (agent.personaLint?.findings?.length) console.log('Persona notes:', agent.personaLint.findings);

let env = fs.readFileSync('.env', 'utf8');
const set = (k, v) => { env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`; };
set('KALTURA_AGENT_ID', agent.agentId);
set('KALTURA_CONFIG_ID', agent.configId);
// Thumbnail for the inline avatar player in Slack.
const avatar = await mgmt.avatars.get(agent.avatarId, admin.ks).catch(() => null);
if (avatar?.previewImageUrl) set('AVATAR_THUMBNAIL_URL', avatar.previewImageUrl);
fs.writeFileSync('.env', env, { mode: 0o600 });
console.log('Saved KALTURA_AGENT_ID, KALTURA_CONFIG_ID and AVATAR_THUMBNAIL_URL to .env');
