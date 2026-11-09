# Technical reference

[← Back to overview](../README.md) · [How it works](HOW-IT-WORKS.md) · [Replicate & reuse](REPLICATE-AND-REUSE.md) · [Caveats, risks & limits](CAVEATS-AND-RISKS.md) · **Technical reference**

---

For developers. Product managers can skip this page.

## Project layout

```
src/index.js          entry point: Slack (Bolt, Socket Mode) + web server
src/config.js         settings from .env
src/slack.js          Slack listeners: DMs, @mentions, buttons, feedback, stop, avatar message,
                      side panel (Work Objects), /talk, voice clips
src/kaltura.js        Kaltura bridge: per-user tokens, conversation memory, answer streaming, widgets
src/stream.js         Slack replies: streaming in threads, live-edited top-level replies
src/blocks.js         Kaltura widgets → Slack Block Kit; avatar player block; Work Object card
src/avatar-page.js    the avatar page (in-message, side panel, call window): one shared source
src/embed.js          web server: avatar pages, /api/log, /api/inbox, /api/call/*, SDK files
src/kvibe-worker.js   hosted version of the avatar page (built into kvibe/src/index.js)
src/avatar-log.js     transcript: signed keys, one edited "Avatar conversation" message
src/inbox.js          hands voice-clip text to an open avatar page (long-poll)
src/calls.js          Slack Calls API: call card, joined, ended
src/voice.js          Slack voice clips: detect, wait for Slack's transcript
src/sign.js           HMAC-signed avatar links
src/mock-kaltura.js   fake Kaltura agent (MOCK_KALTURA=1, tests)
kvibe/src/index.js    generated single-file web worker for the hosted page (do not edit)
scripts/              provision.mjs, set-avatar-photo.mjs, smoke.mjs, local-avatar.mjs, build-kvibe.mjs
test/app.test.js      45 tests (fake Slack client + mock Kaltura)
manifest.json         Slack app manifest
```

## Configuration (`.env`)

| Variable | Required | Notes |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | yes | Bot token (`xoxb-`) and app-level token with `connections:write` (`xapp-`) |
| `KALTURA_PARTNER_ID`, `KALTURA_ADMIN_SECRET`, `KALTURA_AGENT_ID` | yes (unless `MOCK_KALTURA=1`) | The admin secret stays on the server; users get per-user agent tokens |
| `KALTURA_CONFIG_ID` | no | The agent's intellect id; looked up from the agent when empty |
| `KALTURA_AVATAR_ID` | no | Needed by `scripts/set-avatar-photo.mjs` |
| `KALTURA_REGION` | no | e.g. `frp2` for EU partners |
| `KALTURA_UICONF_ID`, `KALTURA_MODEL_TYPE` | no | Player for clip embeds; `fast` (default) or `smart` |
| `PUBLIC_BASE_URL`, `EMBED_SIGNING_SECRET` | for avatar features | The bot service's public HTTPS address; a 32+ character random secret |
| `AVATAR_INLINE_BASE_URL` | for the in-message player | Host of the hosted avatar page, if different from `PUBLIC_BASE_URL` |
| `AVATAR_THUMBNAIL_URL` | for the in-message player | The avatar's preview image (saved by the scripts) |
| `AVATAR_INLINE` | no | `0` turns off the in-message player |
| `SLACK_THREAD_REPLIES` | no | `1` answers in threads; `0` (default) top-level replies |
| `SLACK_VIDEO_BLOCKS` | no | `0` shows Kaltura clips as links |
| `MOCK_KALTURA` | no | `1` uses the fake agent |
| `PORT`, `STREAM_FLUSH_MS`, `UPDATE_FLUSH_MS`, `VOICE_TRANSCRIPT_TIMEOUT_MS`, `EMBED_LINK_TTL_SECONDS`, `AVATAR_INLINE_LINK_TTL_SECONDS` | no | Tuning |

The hosted page (K-Vibe) needs `KALTURA_PARTNER_ID`, `KALTURA_ADMIN_SECRET`, `KALTURA_AGENT_ID`, `KALTURA_CONFIG_ID`, `EMBED_SIGNING_SECRET` (same value), optional `KALTURA_REGION`.

## Slack app (manifest)

| Setting | Used for |
|---|---|
| `agent_view` with suggested prompts | Agent DM experience ("AGENT" label, prompts) |
| Bot scopes `assistant:write`, `chat:write`, `im:history`, `im:read`, `im:write`, `app_mentions:read` | Agent chat in DMs and channels |
| `links:read`, `links.embed:write` (bot + user), `unfurl_domains` | Video blocks: Kaltura clips and the in-message avatar player |
| `metadata.message:read` + Work Object Previews (File type, embed allow list) | Side-panel avatar |
| `files:read` | Reading Slack's transcript of voice clips |
| `calls:write`, `commands`, `/talk` | Live call card |
| Events `message.im`, `app_mention`, `app_home_opened`, `link_shared`, `agent_session_stopped`, `entity_details_requested` | Messages, DM open, side panel, stop button |
| Socket Mode | No public URL needed for Slack events |

Changes to scopes or `unfurl_domains` take effect only after **reinstalling** the app.

## How Kaltura output maps to Slack

| Kaltura output | Slack |
|---|---|
| `text` / `avatar` segments | Top-level reply edited live (`chat.update`), or `chat.startStream`/`appendStream`/`stopStream` in threads |
| `think`, `tool`, `avatar-filler` | Status line ("Thinking…", "Using …"), or `agents.sessions.setStatus` in threads |
| `video-gallery` | `video` block with the Kaltura player URL (falls back to links) |
| `sources`, `show-link`, `external-video`, `content-gallery`, `summary` | Section / context blocks |
| `followups` | Buttons that ask the question |
| `flashcards` | "Show answer" buttons (private reply) |
| OAuth interruption | "Sign in" button |
| `messageId` | Feedback buttons → Kaltura `feedback.add` |

## Web endpoints (bot service)

| Endpoint | Purpose | Protection |
|---|---|---|
| `GET /embed/avatar?u&t&exp&sig[&k][&lk][&lb]` | Avatar page (side panel, call window with `k`) | HMAC signature + expiry; `k` must belong to the same user |
| `POST /api/log?k=<lk>` | One finished exchange → transcript message | Signed `lk`; CORS open (pages run in Slack frames / other hosts) |
| `GET /api/inbox?k=<lk>` | Long-poll: voice-clip text for an open avatar | Signed `lk`; CORS open |
| `POST /api/call/start?k`, `/api/call/end?k` | Live call card: joined / ended | Random call key, in memory |
| `GET /sdk/*` | Kaltura SDK browser files | Public (open-source SDK) |
| `GET /healthz` | Health check | Public |

## Scripts

```bash
node --env-file=.env scripts/provision.mjs "brief"                     # create a Kaltura avatar agent; writes ids to .env
node --env-file=.env scripts/smoke.mjs                                 # two text turns + avatar init against the real agent
node --env-file=.env scripts/set-avatar-photo.mjs photo.jpg --gender Feminine --voice Jane   # new face (+ voice)
node --env-file=.env scripts/local-avatar.mjs                          # avatar page on http://127.0.0.1:4318 for testing
node scripts/build-kvibe.mjs                                           # build the hosted page (kvibe/src/index.js)
```

## Tests

```bash
npm test
```
45 tests with a fake Slack client and the mock Kaltura agent: streaming and live-edited replies, widget mapping and fallbacks, @mentions, stop, feedback, follow-ups, the DM avatar message, side panel signing, in-message player, transcript message, voice clips (to text and to the open avatar), live calls, and the web endpoints' headers and access checks.
