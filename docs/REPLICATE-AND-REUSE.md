# Replicate and reuse

[← Back to overview](../README.md) · [How it works](HOW-IT-WORKS.md) · **Replicate & reuse** · [Caveats, risks & limits](CAVEATS-AND-RISKS.md) · [Technical reference](TECHNICAL-REFERENCE.md)

---

This page is the checklist to stand the prototype up again, for another agent, another workspace or a customer demo. It also lists what is reusable and what must change before this becomes a product.

## What you need

| Need | Why | Who usually has it |
|---|---|---|
| A **Kaltura partner** with Agentic Avatars enabled: partner ID + admin secret | Create the agent and mint user tokens | Kaltura account owner / SE |
| A **Slack workspace** on a paid plan (or a free Slack Developer Program sandbox) | Slack's agent features need a paid plan | Workspace admin |
| Permission to **create and install a Slack app** in that workspace | Installing grants the app's permissions | Workspace admin (or a user, if the workspace allows app installs) |
| A machine or server with **Node.js 20+** | Runs the bot service | Developer |
| A **public HTTPS address** for the bot service | Side panel, call page, transcript and voice-clip endpoints | Developer (tunnel for demos, real hosting for production) |
| A **public host on a domain you control** for the in-message avatar page | Slack only plays pages from the app's registered domains | Kaltura K-Vibe (internal) or any host |

Expect about half a day for a first setup by a developer who has these accesses. Most of the time goes to Slack app configuration and approvals.

## Step by step

### 1. Get the code
```bash
git clone https://github.com/linderalon/slack-embeded-agent.git
cd slack-embeded-agent
npm install          # also installs the Kaltura SDK from GitHub (pinned to v1.37.0)
cp .env.example .env # you fill this in as you go
```
Optional sanity check without any accounts: `npm test` (45 tests against a fake Slack and a fake Kaltura agent).

### 2. Create (or pick) the Kaltura agent
Put `KALTURA_PARTNER_ID` and `KALTURA_ADMIN_SECRET` in `.env`, then either:
- **Create a new agent** from a one-line brief:
  ```bash
  node --env-file=.env scripts/provision.mjs "A friendly assistant that answers questions and finds videos in our Kaltura library"
  ```
  This writes `KALTURA_AGENT_ID`, `KALTURA_CONFIG_ID` and `AVATAR_THUMBNAIL_URL` into `.env`. Add `KALTURA_AVATAR_ID` from its output if you want to change the face later.
- **Or reuse an existing agent:** set `KALTURA_AGENT_ID` (and `KALTURA_CONFIG_ID` if you know it).

Check it works: `node --env-file=.env scripts/smoke.mjs`. You should see two answers and the avatar's connection details.

Optional, a custom face and voice:
```bash
node --env-file=.env scripts/set-avatar-photo.mjs photo.jpg --gender Feminine --voice Jane
```
Only use a real person's photo with their consent.

### 3. Create the Slack app
1. Go to api.slack.com/apps → **Create New App → From a manifest**, choose the workspace and paste [`manifest.json`](../manifest.json).
   - Tip: if the manifest editor shows "0 scopes" on review, the paste did not register. Go back and paste again.
2. **Basic Information → App-Level Tokens:** create a token with `connections:write`. That is `SLACK_APP_TOKEN`.
3. **Work Object Previews:** turn it on, add the **File** entity type, and add your public HTTPS host to the **embed domain allow list** (for a Cloudflare quick tunnel: `*.trycloudflare.com`).
4. **App Manifest → `unfurl_domains`:** add the domain that will host the in-message avatar page (for K-Vibe: `kaltura.ai`). Keep `kaltura.com` for Kaltura video clips.
5. **Install App → Install to workspace** and approve. Copy the **Bot User OAuth Token**. That is `SLACK_BOT_TOKEN`.

> **Important:** Slack only applies changes to permissions and link domains after a **reinstall** (Install App → Reinstall). Most "it doesn't work" moments during the prototype came from forgetting this.

### 4. Give the bot service a public HTTPS address
For a demo on a laptop:
```bash
brew install cloudflared
cloudflared tunnel --no-autoupdate --url http://localhost:3000
```
Put the printed `https://….trycloudflare.com` address in `PUBLIC_BASE_URL`. Generate `EMBED_SIGNING_SECRET` with `openssl rand -hex 32`.
The quick-tunnel address changes every time the tunnel restarts; update `.env` and restart the bot when it does.

### 5. Host the in-message avatar page
The page code is generated from `src/avatar-page.js` + `src/kvibe-worker.js`:
```bash
node scripts/build-kvibe.mjs   # writes kvibe/src/index.js (one file, no dependencies)
```
Deploy the `kvibe/` folder as a K-Vibe app (or any host that runs a standard `fetch(request, env)` web worker) and set these settings on that host:
`KALTURA_PARTNER_ID`, `KALTURA_ADMIN_SECRET`, `KALTURA_AGENT_ID`, `KALTURA_CONFIG_ID`, `EMBED_SIGNING_SECRET` (the **same** value as the bot's `.env`).

Then:
- Make the hosted app **public** (on K-Vibe this is "Request to make public", approved by a K-Vibe admin). Slack's player cannot sign in.
- Set `AVATAR_INLINE_BASE_URL` in `.env` to that host's address.
- Make sure its domain is in the Slack app's `unfurl_domains` (step 3.4) and that you reinstalled.

### 6. Run it
```bash
npm start
```
You should see `Slack agent connected (Socket Mode)` and `Avatar embed server on :3000, public at …`.

### 7. Verify (5-minute checklist)

| Check | Expected |
|---|---|
| Open the agent DM | A "Talk with me live" message with the avatar player, **Start a live call** and a side-panel card, plus a "📝 Avatar conversation" message |
| Type a question in the DM | "Thinking…" with Stop, then an answer with feedback buttons and **Talk to the avatar** / **New conversation** |
| Press play on the avatar | The avatar starts inside the message; type under the video and it answers out loud |
| After that exchange | The 📝 Avatar conversation message shows "You: …" and the answer; the player keeps playing |
| Click the side-panel card | The avatar opens beside the conversation |
| Record a Slack voice clip while the avatar is open | "You said: … · the avatar is answering out loud"; the avatar answers |
| **Start a live call** → **Start the call** | A browser window with the avatar listening; a Slack call card appears; **End call** closes it |

## Reusing it

### For another agent or persona
Change `KALTURA_AGENT_ID` / `KALTURA_CONFIG_ID` (and `AVATAR_THUMBNAIL_URL`) in `.env` and in the hosted page's settings, then restart. The Slack app doesn't change.

### For another Slack workspace or a customer demo
Create a new Slack app from the same manifest in that workspace (steps 3 to 6). Today, **one running bot serves one workspace** (one bot token). Serving many customers from one service needs the "Add to Slack" install flow (see below).

### Turning features on and off (in `.env`)
| Setting | Effect |
|---|---|
| `SLACK_THREAD_REPLIES=1` | Answer every message in a thread (Slack's native streaming and status) instead of top-level replies |
| Empty `PUBLIC_BASE_URL` | Text agent only: no avatar, calls, transcript or clip-to-avatar |
| `AVATAR_INLINE=0` | No in-message player; the avatar opens in the side panel only |
| `SLACK_VIDEO_BLOCKS=0` | Kaltura clips shown as links instead of embedded players |
| `MOCK_KALTURA=1` | Fake agent, to demo or test the Slack side without Kaltura |

### Reusable for other platforms (e.g. Microsoft Teams)
| Reusable as is | Slack-specific (rewrite per platform) |
|---|---|
| `src/kaltura.js` (Kaltura tokens, conversation memory, answer streaming, widget parsing) | `src/slack.js`, `src/stream.js`, `src/blocks.js` (Slack events, messages, Block Kit) |
| `src/avatar-page.js` (the avatar page, call controls, transcript reporting) | `manifest.json`, Work Objects, video blocks, Calls API |
| `src/sign.js`, `src/avatar-log.js` key signing, `src/inbox.js` | Slack voice clip handling (`src/voice.js`) |

## From prototype to product (what must change)

| Area | Today | Needed for customers |
|---|---|---|
| **Install** | Manual app creation from a manifest, tokens pasted into `.env` | Slack **"Add to Slack"** (OAuth) install; per-workspace tokens stored securely |
| **Hosting** | A Mac + a temporary tunnel; K-Vibe for one page | One hosted service (Kaltura infrastructure) for the bot, pages and endpoints, with a stable domain |
| **Customer setup** | `.env` file per deployment | Admin page or Kaltura-side config: which partner/agent/avatar per workspace |
| **State** | In memory (lost on restart): conversation mapping, call keys | Database / Redis |
| **Secrets** | `.env` and K-Vibe settings | A secrets manager; per-customer Kaltura credentials, rotated |
| **Distribution** | Installed in one workspace | Slack Marketplace listing and review; **apply to Slack's Work Objects embeds pilot** (side panel in distributed apps is invitation-only) |
| **Compliance** | None formal | Security review, data-retention policy for transcripts, AI disclosure review, likeness consent for custom faces |
| **Monitoring** | Console logs | Logging, alerting, usage metrics |
