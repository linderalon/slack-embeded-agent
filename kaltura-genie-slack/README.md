# Kaltura Genie in Slack: voice-call prototype

A side prototype, separate from the Slack agent in the rest of this repository. It doesn't change it.

**What it does:** Slack users talk to **Kaltura Genie**, Kaltura's own AI avatar, in a voice call started from Slack.
- A **Start a call** button is always available: on the app's Home tab, and as the newest message in its DM.
- One click opens the call in the browser. There, Kaltura's Genie avatar has the microphone, which Slack never gives apps.
- Slack shows a native call card while the call runs.
- After hang-up, Kaltura's summary and transcript appear on the call page and in the Slack DM, together with a **Start a new call** button.

There is no text chat inside Slack, by design.

The full investigation is in [REPORT.md](REPORT.md): why Genie can't use the microphone inside Slack's side panel, what was tested, and the Kaltura embed behaviour found along the way. Section 10 covers the current design. Screenshots referenced there aren't included in this repository.

## Run it

```bash
npm install
npm test
```

Create a `.env` with these settings:

| Setting | What it is |
|---|---|
| `KALTURA_PARTNER_ID`, `KALTURA_ADMIN_SECRET` | Kaltura partner; the secret is used server-side only, to mint per-user login tokens (KS) |
| `KALTURA_AGENT_ID`, `KALTURA_CONFIG_ID` | The conversational agent and its intellect |
| `GENIE_SIGNING_SECRET` | `openssl rand -hex 32`; signs the Start a call links |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | A Slack app created from [`slack/manifest.json`](slack/manifest.json) (Socket Mode; app token with `connections:write`) |
| `PUBLIC_BASE_URL` | The public HTTPS address of this server, e.g. a tunnel: `cloudflared tunnel --url http://localhost:3077` |

Then run `npm start`, open the app in Slack, and click **Start a call** on its Home tab.

## Files

| Path | What |
|---|---|
| `src/server.js` | HTTP server: `/start` (signed link: a new call), `/call/<key>` (the call page), `/api/call/*` (start, end, recap, stats) |
| `src/page.js` | Call page (Kaltura `genieAvatar` embed, end-of-call summary screen, WebRTC quality probe); also the earlier side-panel page |
| `src/slack-app.js` | Slack app: Home tab, Start a call button, `/genie` |
| `src/calls.js` | Slack Calls lifecycle (card, joined, ended), saved to `data/calls.json` |
| `src/recap.js` | After hang-up: tells Kaltura the session is over (`thread/session_completed`), reads its summary and transcript, posts them in Slack |
| `src/kaltura.js`, `src/sign.js` | Per-user Kaltura agent token; HMAC-signed links |
| `scripts/call-test.mjs` | A full call in headless Chrome with a fake microphone |
| `scripts/slack-frames-test.mjs` | The side-panel sandbox harness from the investigation |
| `test/genie.test.js` | Unit tests |

Status: a prototype, tested by hand in one Slack workspace. See REPORT.md for gaps before production.
