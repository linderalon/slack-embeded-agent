# Can Kaltura Genie be hosted inside Slack?

> Screenshots: the `shots/…` links point to screenshots taken during testing. They're kept with the original working copy and aren't published in the repository.

> **Current direction (chosen after the tests below): one experience, a Genie voice call.** Slack shows a native call card, and **Join** opens Kaltura's Genie avatar in a browser window, where the microphone works. When you hang up, you get Kaltura's call summary and transcript, both on screen and in the Slack DM. There is no text chat in Slack. See **section 10**. Sections 1–9 document the side-panel investigation that led to this.

**Side-panel finding, short answer: yes, in Slack's Work Object viewer, for text chat. Verified in the real Slack client.** Clicking an "Ask Kaltura Genie" card in a test app's DM opens Kaltura's own Genie chat UI inside Slack, beside the conversation's thread. Genie answered questions there and showed follow-up suggestions, feedback buttons, New thread and History. History even listed threads from the existing Kaltura Agent bot, because both apps use the same Kaltura identity per Slack user. Slack only provides the frame: the whole conversation happens in Kaltura's UI.

Three limits:
- **Slack's default side-panel sandbox breaks Genie as shipped.** Kaltura's loader needs browser storage, which that sandbox blocks. A ~20-line in-memory storage shim in our page fixes it. Turning on `allow-same-origin` in the Slack app's settings also fixes it.
- **Voice and the talking avatar don't work inside Slack.** Slack gives apps no microphone, so "Start conversation" stops at "Allow access to your mic".
- **The in-message video block (350×260) is too small for a chat UI.** It shows the title and part of the avatar, but no input box.

> **What was tested.**
> - **First, a local harness**, in a real Chrome (headless, its own profile) and in the app's browser pane. It copies Slack's iframe attributes exactly and loads the page from a different origin, the way Slack does (section 3).
> - **Then the real Slack web client in Chrome** (section 3b), with a separate test app "Kaltura Genie (test)" (A0CFWPAP927) in the Kaltura workspace. The page was served from this laptop through a Cloudflare quick tunnel, with `allow-same-origin` **off**, i.e. Slack's default sandbox.
>
> The existing "Kaltura Agent" app was not changed.

---

## 1. How Genie is embedded (from the docs)

Kaltura has two embeddable "Genie" products, both built on the Unisphere micro-frontend loader (`https://unisphere.nvp1.ovp.kaltura.com/v1/loader/index.esm.js`):

| | **Conversational agent chat (`genieChat`)**, used here | **Genie AI-search widget (`unisphere.widget.genie`)** |
|---|---|---|
| What it is | The agent's chat + avatar UI (agent = avatar + intellect) | Q&A over a video library, with clip citations |
| Mount | `embeds.workspace({apis:['genieChat'], session:{ks or widgetId, partnerId}})` then `.contained()` / `.page()` / `.floater()` | `workspace.loadRuntime('unisphere.widget.genie','application',{ks,pid,genieServerUrl,…})` then `assignArea()` |
| Auth | **widgetId** (anonymous, the same for all visitors) **or a KS**. We use a **per-user agent KS** from `sessions.createAgentToken`: USER session, `agentid:<agent>`, `geniegpcid:<intellect>`, `setrole:PLAYBACK_BASE_ROLE` | USER KS with `setrole:PLAYBACK_BASE_ROLE, sview:*, enableentitlement, privacycontext, genieid, appid…` |
| **Hosted page that can be framed** | **Yes:** `https://unisphere.nvp1.ovp.kaltura.com/apps/embeds/conversational-agents/?partnerId=…&ks=…` (or `widgetId=`), documented with `allow="microphone"` | Not documented |
| Theming | `ui.theme` light / dark / full theme object; agent `embedConfig.theme` | Same |

What Genie needs from the page that hosts it (observed):
- ES-module imports from `unisphere.nvp1.ovp.kaltura.com`. These work even from a sandboxed `null` origin: Kaltura's CDN serves CORS for it.
- **`localStorage` / `sessionStorage` to start.** Without them the loader fails with `failed to activate instance 'embeds-…'` and draws nothing.
- **Microphone** for voice mode, and **autoplay** for avatar video and audio.
- No cookies, no sign-in, no popups for text chat.

Sources: [Embed templates](https://docs.kaltura.com/docs/conversational-agents/conversational-agents/embed-templates), [Chat & Avatar Contained (includes the iframe embed)](https://docs.kaltura.com/docs/conversational-agents/conversational-agents/embed-chat-contained), [Chat & Avatar Page](https://docs.kaltura.com/docs/conversational-agents/conversational-agents/embed-chat-page), [Agent Service: getEmbedScript, widgetConfig](https://docs.kaltura.com/docs/conversational-agents/conversational-agents/agent-service), [Genie widget API](https://kaltura.md/raw/KALTURA_GENIE_WIDGET_API.md), [Unisphere framework](https://kaltura.md/raw/KALTURA_UNISPHERE_FRAMEWORK_API.md).

## 2. Which Slack surface can host it

| Slack surface | Frame Slack gives the page | Verdict for Genie |
|---|---|---|
| **Work Object side panel (flexpane)** | Opens when the user clicks a Work Object card. `sandbox="allow-scripts allow-forms"` (no `allow-same-origin` unless enabled in app settings, no `allow-popups`, no microphone). The page must send `frame-ancestors https://*.slack.com https://*.slack-gov.com https://*.slack-mcps.com`, and its domain must be in the app's embed allow list. | ✅ **Best fit, verified in real Slack.** Full Genie text chat in a large viewer beside the message thread. |
| In-message video block | About 350×260, `allow="autoplay"`, sandbox `allow-scripts allow-same-origin`. Domain must be in `unfurl_domains` (needs a reinstall). Slack reloads it on scroll. | ❌ Genie mounts, but only the title and avatar fit: no input box, no answers. The reload on scroll would also wipe the chat. |
| Link out (button opens a browser tab) | A normal tab | ✅ Everything works, including voice. But it leaves Slack, so it's a fallback, not "hosted in Slack". |
| Messages, App Home, modals | Block Kit only, no web UI | ❌ Not possible. |

## 3. Test results

Prototype page: signed link → server mints a per-user agent KS → page mounts `genieChat.contained()` (mode `js`) or nests Kaltura's hosted page (mode `iframe`). Harness: `/dev/harness`, loaded from `127.0.0.1` so the `localhost` page is cross-origin.

| Frame | JS embed (our page) | Hosted Kaltura iframe | Storage | Mic | Autoplay |
|---|---|---|---|---|---|
| 0. Normal tab, no sandbox | ✅ mounts in ~1.4–2 s, answers, follow-ups | ✅ | ok | allowed | allowed |
| 1. **Slack side panel, default sandbox** | ❌ without the shim (`failed to activate instance`) → ✅ **with the shim**: answers, follow-ups | ❌ blank: the nested frame inherits the `null` origin, and we can't shim inside it | blocked (SecurityError), shimmed in memory | **blocked** | blocked |
| 2. Side panel + `allow-same-origin` | ✅ answers, follow-ups, no shim needed | ✅ | ok (partitioned under Slack in real Slack) | **blocked** | blocked |
| 3. In-message video block 350×260 | mounts, but only title + avatar are visible | same | ok | blocked | allowed |

Exact observations:
- **Standalone tab:** "What can you help me with?" → "I can help you find quick answers to workplace questions and point you to relevant training and instructional videos from the Kaltura video library…" ([01](shots/01-standalone-landing.jpg), [02](shots/02-standalone-answer.jpg)).
- **Default Slack sandbox, before the shim:** blank frame, 3 errors from Unisphere ([03](shots/03-all-frames-before-shim.png), frame 1).
- **Default Slack sandbox, with the shim:** same answer, 0 errors ([04](shots/04-default-sandbox-answer.png)). "What videos do you have about onboarding?" → answer + three "Next steps" follow-up cards ([07](shots/07-default-sandbox-answer-followups.png)). In one earlier run the follow-ups component (`genie-tools/followups-tool`) failed to load once. It loaded in the later runs, so treat it as intermittent.
- **Same-origin side panel and no sandbox:** same experience with follow-ups ([05](shots/05-nosandbox-answer-followups.png), [06](shots/06-sameorigin-answer-followups.png)).
- **Hosted iframe mode:** renders in frames 0, 2 and 3, blank in frame 1 ([08](shots/08-hosted-iframe-all-frames.png)).
- **Voice ("Start conversation")** in either Slack side-panel variant: dark avatar screen with "⚠ Allow access to your mic", and Unisphere logs `getUserMedia … SecurityError` or `NotAllowedError` ([09](shots/09-voice-default-sandbox.png), [10](shots/10-voice-sameorigin.png)). The user can't recover from this inside Slack.
- **Content:** the agent replied "I can't search the video library right now" in **every** frame, including the normal tab. That comes from the agent's knowledge setup, not from Slack framing.
- **Built-in browser pane quirk:** the app's browser pane refuses to load any iframe sandboxed without `allow-same-origin`, even a plain `/healthz`. So the default-sandbox case was tested in real Chrome.

## 3b. Real Slack test (Slack web client in Chrome, Kaltura workspace)

Setup: the test app posts a message with an "Ask Kaltura Genie" Work Object card in its DM ([14](shots/14-real-slack-card.jpg)). Clicking the card makes Slack call `entity_details_requested`. The app answers with a fresh 10-minute signed link for that Slack user, and Slack loads it.

| Check | Result |
|---|---|
| Frame Slack used (read from the DOM) | `sandbox="allow-scripts allow-forms"`, **no `allow` attribute**, about 2100×980 CSS px. It's a large "External content from Kaltura Genie (test)" viewer with the message thread on the right, not a narrow panel. |
| Genie loads | ✅ in about 6–10 s (white frame first), in the default sandbox thanks to the storage shim ([12](shots/12-real-slack-landing.jpg)) |
| "What can you help me with?" | ✅ "I can help you find quick answers to workplace questions and point you to relevant training and instructional videos in the Kaltura video library…" ([11](shots/11-real-slack-answer.jpg)) |
| "What videos do you have about onboarding?" | ✅ answer + three "Next steps" follow-up cards ([15](shots/15-real-slack-followups.jpg)). The answer itself says the library can't be searched: the same agent-content issue as outside Slack. |
| History | ✅ lists this user's earlier Genie threads, including "hey how are you?" and "What topics can you help with?" from the **existing Kaltura Agent bot** ([16](shots/16-real-slack-history.jpg)). Both apps use the Kaltura user `slack-<team>-<user>`, so typed-in-Slack and in-Genie conversations share one history. Some threads show only as an ID because they have no title. |
| Voice ("Start conversation") | ❌ dark avatar screen with "⚠ Allow access to your mic"; ending it closed the viewer ([13](shots/13-real-slack-voice-mic-blocked.jpg)) |
| Reopening the card | ✅ opens again, and the last conversation was showing |
| `allow-same-origin` setting | Exists in the app's **Work Object Previews** settings, next to the domain allow list. It was left off for this test. |

## 4. What works and what doesn't (side panel)

| Feature | Status |
|---|---|
| Typed chat, streaming answers, 👍/👎, follow-up cards, New thread, History | ✅ (History verified in real Slack, and shared with the existing bot's threads) |
| Sign-in | ✅ None needed: the signed link is the proof, the server mints the KS, no cookies |
| Per-user identity | ✅ `slack-<team>-<user>`, the same scheme as the existing bot, so Genie threads are per Slack user |
| Voice / live avatar conversation | ❌ No microphone in any Slack frame |
| Avatar video playback | ⚠️ The avatar only plays in voice mode, which is blocked. Autoplay is blocked in the side panel anyway. |
| Video clips inside answers | ❓ Not tested: the agent returned no clips. Clips would play in a nested Kaltura player, which also inherits the sandbox. |
| Source links that open a new tab | ❓ Probably blocked: the panel has no `allow-popups`, and the page can't navigate the top window. Not tested because no sources were returned. |
| Settings that persist between openings | ⚠️ Default sandbox: in-memory only, lost when the panel closes. With `allow-same-origin`: kept, partitioned under slack.com. Conversation history is stored by Kaltura per user, so it should survive. Not verified. |
| Size | ✅ Harness 420×720 fits. In real Slack the viewer was about 2100×980 (large, with the thread beside it). ❌ 350×260: unusable. |
| Opening | ⚠️ Two clicks: post a card, then click it. Slack can't open the side panel from a button. |

## 5. Compared with the existing approach (Slack-native messages + avatar)

| | **Genie in the side panel (this prototype)** | **Existing "Kaltura Agent" (Slack-native)** |
|---|---|---|
| Where the chat lives | Inside Kaltura's UI, in the panel | Native Slack messages (DMs, @mentions, channels, threads) |
| Fidelity to Kaltura's product | 100%: new Genie features show up automatically | Re-implemented: answers mapped to Block Kit |
| Code to maintain | Small: signed link + KS mint + a ~50-line Slack card app | Large: streaming, Block Kit mapping, voice clips, calls, transcripts |
| Works in channels and threads, visible to teammates | ❌ Private panel per user | ✅ |
| Voice | ❌ | ✅ via voice clips and a live call in a browser window |
| Avatar | ❌ (needs the mic) | ✅ in-message player and side panel (text in, voice out) |
| Searchable in Slack, mobile | ❌ The panel isn't in Slack search. Mobile not tested. | ✅ |
| Onboarding for a customer | Easiest: Kaltura partner + agent id → card → done | More setup |

## 6. Effort and risks to productize (estimates)

- **Pilot in one workspace** (this code + a test Slack app + a public host): about 1 day once hosting is approved.
- **Production:**
  - hosting on Kaltura infrastructure;
  - multi-tenant install (OAuth "Add to Slack", mapping each workspace to a partner and agent);
  - KS refresh for long sessions (the Genie widget documents `workspace.session.setData`; not verified for `genieChat`);
  - Slack Marketplace review.

  Rough estimate: 2–4 weeks of engineering, plus Slack's timelines.
- **Risks:**
  1. **Work Object embeds in Marketplace apps are invitation-only (pilot).** This is the gating item for selling it.
  2. **The storage shim relies on Unisphere's internals.** A Kaltura change could break it. Better: Kaltura's Unisphere team supports a storage-less, opaque-origin mode, or the app enables `allow-same-origin`. The hosted-iframe route can never work in the default sandbox.
  3. No voice and no avatar, which are the most demo-worthy Kaltura features.
  4. The KS sits in the page (USER session, playback-only role, 4 h TTL in this prototype). In hosted-iframe mode it also goes in a URL to Kaltura.
  5. Slack can change Work Objects (a newer feature).

## 7. Recommendation

1. **Use the side panel with the JS embed** (`genieChat.contained()` + the storage shim). Also enable `allow-same-origin` in the test app, to drop the shim dependency where Slack allows it. Don't use the hosted iframe: it can't work in Slack's default sandbox.
2. **Sell it as a hybrid, not a replacement:**
   - Slack-native messages stay the front door: channels, mobile, search, voice clips, live call.
   - A "Open Genie" Work Object card gives the full Kaltura experience beside the chat for deep sessions.
   - Voice and the avatar keep using the existing browser-window call.
3. **Ask the Unisphere team** to let `genieChat` start without `localStorage` (opaque origin), and to hide voice or explain it when there is no microphone. Today the button leads to a dead end in Slack.
4. **Apply for Slack's Work Objects embeds pilot early.**

## 8. The test setup, and how to tear it down

What was created for the real-Slack test:
- **Slack app "Kaltura Genie (test)"**, A0CFWPAP927, created from [`slack/manifest.json`](slack/manifest.json) and installed in the Kaltura workspace. Its settings:
  - Socket Mode, with an app-level token named `socket`;
  - Work Object Previews on, File entity type, embed allow list `*.trycloudflare.com`, allow-same-origin off.
- **A Cloudflare quick tunnel** from this laptop to port 3077. Its address changes whenever it restarts; update `PUBLIC_BASE_URL` in `.env` when it does.
- **The bot and app tokens**, saved in the git-ignored `.env`. They were also pasted into the chat, so **regenerate both** in the app's settings when testing is done, or delete the test app.

To run it again:
1. Start the tunnel: `cloudflared tunnel --no-autoupdate --url http://localhost:3077`.
2. Put the printed address in `PUBLIC_BASE_URL`.
3. Run `npm start`. The Slack side ([`src/slack-app.js`](src/slack-app.js)) connects when the tokens and an https `PUBLIC_BASE_URL` are set.
4. DM the app or type `/genie`, then click the card.

Still open: the same test with allow-same-origin **on**, the Slack desktop and mobile apps, and answers that contain video clips or source links (this agent returned none).

## 9. What's in this folder

| Path | What |
|---|---|
| [`src/server.js`](src/server.js) | `/genie` (signed link → KS → page), `/healthz`, `/dev/harness` (Slack-identical frames, local only). CSP `frame-ancestors` for Slack, `no-store`, `no-referrer`. |
| [`src/page.js`](src/page.js) | The Genie page: JS embed or hosted iframe, storage shim, `diag=1` diagnostics strip |
| [`src/kaltura.js`](src/kaltura.js) | Per-user agent KS via `@kaltura/intelligent-agents` |
| [`src/sign.js`](src/sign.js) | HMAC-signed, expiring links (10 min) |
| [`src/slack-app.js`](src/slack-app.js), [`slack/manifest.json`](slack/manifest.json) | Test Slack app (A0CFWPAP927), now **call-only**: `/genie` or a DM posts a native call card |
| [`src/calls.js`](src/calls.js), [`src/recap.js`](src/recap.js) | Slack Calls lifecycle (card, joined, ended); end-of-call summary (`session_completed`, read Kaltura's analysis and transcript, post in Slack) |
| [`scripts/call-test.mjs`](scripts/call-test.mjs) | Full call in headless Chrome with a fake microphone: start, hang up, read the end screen |
| [`scripts/last-thread.mjs`](scripts/last-thread.mjs) | Read-only: a Slack user's latest Genie threads, with their stored summary and transcript |
| [`scripts/set-slack-tokens.sh`](scripts/set-slack-tokens.sh) | Writes the Slack tokens into `.env` with hidden input |
| [`scripts/slack-frames-test.mjs`](scripts/slack-frames-test.mjs) | Headless-Chrome driver for the harness: diagnostics, asks a question, screenshots |
| [`test/genie.test.js`](test/genie.test.js) | 12 unit tests (`npm test`) |
| `shots/` | Screenshots referenced above |

Run it locally: `npm install`, then create a `.env` with `KALTURA_PARTNER_ID`, `KALTURA_ADMIN_SECRET`, `KALTURA_AGENT_ID`, `KALTURA_CONFIG_ID` and `GENIE_SIGNING_SECRET` (`openssl rand -hex 32`). Then `npm start`, and open the printed signed link or `http://127.0.0.1:3077/dev/harness`.

Nothing in `kaltura-slack-agent/`, the "Kaltura Agent" Slack app or the "kaltura-slack-avatar" K-Vibe app was changed. That folder was only read, and its `.env` was used only to copy the four Kaltura values into this folder's git-ignored `.env`.

## 10. Call-only experience (current build)

**Why a call.** Slack gives no app the microphone: its frame has no `allow="microphone"`, and the browser engine enforces that. So, like Zoom and Meet, the voice part runs in a browser window that Kaltura controls, and Slack shows a native call card. The side panel and its text chat were removed, so there is only one experience.

**Flow (verified in the real Slack web client, 2026-11-09):**
1. **A "Start a call" button is always in Slack:**
   - on the app's **Home tab**, which Slack shows first when you open Kaltura Genie ([22](shots/22-home-tab-start-button.jpg));
   - as the **newest message in the app's DM**: `/genie`, any DM to the app, or opening the DM for the first time posts it, and so does every finished call.

   It's a link button with a long-lived signed URL (`/start?u=<team:user:dm>&exp&sig`, 90 days). Each click creates a **new** call key and opens the call in the browser: one click, no card to find first.
2. The browser opens `/call/<key>`. The key is random, tied to the Slack user and valid for 12 h. The server mints that user's Kaltura login token (KS) and serves Kaltura's **Genie avatar** (`genieAvatar.contained`, captions on) with a **Start call** button ([18](shots/18-call-page-lobby.jpg)). The one click is the gesture browsers need before they play audio.
3. When the call connects, a native **call card** "Call with Kaltura Genie" appears in the DM with you as joined (`calls.add`, `call` block, `calls.participants.add`). On hang-up (End, a dropped connection, or closing the window) it changes to **"Ended · 1 person joined"** (`calls.end`) ([20](shots/20-call-card-ended-1-joined.jpg)).
4. **After hang-up:**
   - The page shows **Call ended, Kaltura's summary and the transcript**, plus *Start a new call* ([19](shots/19-call-ended-summary.png)).
   - The DM gets a new message right under the call card with the **summary, transcript and a "Start a new call" button** ([23](shots/23-after-call-summary-start-new.jpg)), so the next call is always one click away.

**Why there was no summary at first.** Kaltura builds the end-of-call summary (the intellect's `avatar_summary_config`, stored on the thread as `thread_metadata.analysis`) only after it's told the conversation is over: `POST genie…/thread/session_completed {id}`. Kaltura's own SDK sends that on hang-up; **the Unisphere avatar embed doesn't**, and it just returns to its start screen.

Your real call at 14:33 still got a summary, but only later, from Kaltura's background cleanup. Now our server sends `session_completed` on hang-up, and the summary is ready **about 4–5 s later** (measured three times).

**Embed details found by testing** (not in the docs):
- `genieAvatar.isConnected` stays `false`; the reliable signal is `connectionStatus` (`connected` → `notConnected`).
- `threadId` is available once the call connects.
- `askViaText` exists, but in this embed it didn't produce a user turn.

**Audio quality.**
- The call page logs WebRTC stats every 3 s. They show up in the server log as `[stats]` lines.
- A test call from this Mac to Kaltura's US avatar servers showed **0 packets lost, 3–8 ms jitter, about 150 ms round trip, direct UDP (no relay), 25 fps video with no freezes.** So the network path was clean in that test.
- The choppy audio in your first call happened in a Chrome tab that my browser automation was attached to, which can disturb audio. Next time it happens, the `[stats]` lines will show whether it's the network or the device.
- These media streams go straight between the browser and Kaltura. The tunnel only serves the page.

**Known gaps / production work:**
- **Call state** is saved in `data/calls.json` (git-ignored), so Join links survive a restart. Calls that were live when the server stopped are ended in Slack at startup. This came after a "link expired" bug: older links were kept only in memory. For production, use a database shared by all server instances.
- **The summary's wording comes from the agent's intellect.** This agent's summary prompt describes "what the user shared" (memory-style), not a meeting-style recap. Change `avatar_summary_config` on a **dedicated** intellect. The current one is shared with the existing Kaltura Agent, so I didn't touch it.
- **The test app's old Work Object settings are gone** (the manifest no longer has them). The 2:03 PM "Ask Kaltura Genie" card in the test DM is left over and no longer opens.
- **Slack desktop and mobile:** Join opens the system browser. On mobile that's the phone's browser, which also needs microphone permission. Neither was tested yet.
