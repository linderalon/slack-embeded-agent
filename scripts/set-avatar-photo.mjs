// Give the avatar a new face (one finished photo) and, optionally, a voice from the catalog.
// Usage: node --env-file=.env scripts/set-avatar-photo.mjs <photo.jpg> --gender Feminine|Masculine [--voice "Jane"] [--name "Ava"]
// Saves the avatar's new preview image to .env as AVATAR_THUMBNAIL_URL (the Slack inline player thumbnail).
import fs from 'node:fs';
import path from 'node:path';
import { Management } from '@kaltura/intelligent-agents/management';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const photo = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const gender = opt('gender');
if (!photo || !['Feminine', 'Masculine'].includes(gender)) {
  console.error('Usage: set-avatar-photo.mjs <photo.jpg> --gender Feminine|Masculine [--voice "Jane"] [--name "Ava"]');
  process.exit(2);
}
const { KALTURA_PARTNER_ID: partnerId, KALTURA_ADMIN_SECRET: adminSecret, KALTURA_AVATAR_ID: avatarId, KALTURA_AGENT_ID: agentId, KALTURA_REGION: region } = process.env;
if (!avatarId) { console.error('Set KALTURA_AVATAR_ID in .env'); process.exit(2); }

const mgmt = new Management({ partnerId, adminSecret, ...(region ? { region } : {}) });
const admin = await mgmt.sessions.createAdminToken({ userId: 'slack-agent-setup', ttlSeconds: 900 });

const type = path.extname(photo).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
const file = new File([fs.readFileSync(photo)], path.basename(photo), { type });
const visual = await mgmt.catalog.createVisual(file, {
  name: opt('name') || `Slack agent face ${new Date().toISOString().slice(0, 10)}`,
  genderPresentation: gender, background: 'Image', ...(agentId ? { agentScope: agentId } : {}),
}, admin.ks);
const visualId = visual.itemId || visual.id;
console.log('Uploaded photo as visual', visualId);

const current = await mgmt.avatars.get(avatarId, admin.ks);
const body = { id: avatarId, visual: { ...(current.visual || {}), id: visualId } };
const voiceName = opt('voice');
if (voiceName) {
  const page = await mgmt.catalog.list(admin.ks, { filter: { typeEqual: 'Voice', languageEqual: 'en' }, pageSize: 200 });
  const items = page.items || page.objects || page.data || page;
  const voice = (Array.isArray(items) ? items : []).find((v) => v.attributes?.voice?.name === voiceName);
  if (!voice) { console.error(`No English catalog voice named "${voiceName}"`); process.exit(1); }
  body.voice = { ...(current.voice || {}), id: voice.itemId };
  console.log(`Voice: ${voiceName} (${voice.attributes.voice.description || 'no description'})`);
}
await mgmt.avatars.update(body, admin.ks);
const after = await mgmt.avatars.get(avatarId, admin.ks);
console.log('Avatar updated. Visual:', after.visual?.id, 'Voice:', after.voice?.id);

if (after.previewImageUrl) {
  let env = fs.readFileSync('.env', 'utf8');
  env = /^AVATAR_THUMBNAIL_URL=.*$/m.test(env)
    ? env.replace(/^AVATAR_THUMBNAIL_URL=.*$/m, `AVATAR_THUMBNAIL_URL=${after.previewImageUrl}`)
    : `${env.trimEnd()}\nAVATAR_THUMBNAIL_URL=${after.previewImageUrl}\n`;
  fs.writeFileSync('.env', env, { mode: 0o600 });
  console.log('Saved the new preview image as AVATAR_THUMBNAIL_URL:', after.previewImageUrl);
} else {
  console.log('No preview image yet; keep AVATAR_THUMBNAIL_URL as is or rerun later.');
}
