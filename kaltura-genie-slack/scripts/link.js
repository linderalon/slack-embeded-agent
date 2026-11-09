// Print a signed Genie link for a user: npm run link -- <kalturaUserId> [js|iframe]
import { signUrl } from '../src/sign.js';
const [user = 'slack-T0TEST-U0LOCAL', mode = 'js'] = process.argv.slice(2);
const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:3077').replace(/\/+$/, '');
console.log(signUrl(base, '/genie', { userId: user, ttlSeconds: Number(process.env.LINK_TTL_SECONDS || 600), extra: { mode } }, process.env.GENIE_SIGNING_SECRET));
