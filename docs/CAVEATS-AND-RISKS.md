# Caveats, risks and limits

[← Back to overview](../README.md) · [How it works](HOW-IT-WORKS.md) · [Replicate & reuse](REPLICATE-AND-REUSE.md) · **Caveats, risks & limits** · [Technical reference](TECHNICAL-REFERENCE.md)

---

Status: **working prototype**, tested by hand in one Slack workspace (Kaltura) on Slack web and desktop, plus 45 automated tests. It is not production software.

## What can and cannot be done today

### ✅ Works today (tested in Slack)
| Capability | Notes |
|---|---|
| Chat with the Kaltura agent in a DM or by @mention | Answers appear as they are written, with a Stop button; memory across messages |
| Rich answers | Kaltura video clips play in Slack; sources, follow-up buttons, flashcards |
| Feedback (👍 / 👎) | Saved in Kaltura per message |
| No extra threads | Replies sit next to the question; "New conversation" starts over |
| **Live avatar inside the Slack message** | Plays in the message, type under the video, the avatar answers out loud |
| Live avatar in Slack's side panel | Opens beside the conversation |
| Text chat and avatar share memory | Same Kaltura conversation |
| Transcript of the avatar conversation in Slack | One "📝 Avatar conversation" message, updated as you talk |
| Custom avatar face and voice | From a photo + Kaltura catalog voice |
| Live hands-free call, started from Slack | Slack shows a native call card; the call runs in a browser window |
| Slack voice clips | Transcribed by Slack; answered out loud by an open avatar, or in text |

### ❌ Not possible today (Slack platform limits)
| Wanted | Why not | Closest alternative in this prototype |
|---|---|---|
| **Talking to the avatar with a live microphone inside Slack** | Slack gives app content no microphone access. Checked in Slack: the side panel frame is `sandbox="allow-scripts allow-forms"` with no microphone permission; the in-message player frame allows autoplay only. An app cannot change this. | Slack voice clips (record → avatar answers), or the live call window |
| The avatar joining a **Slack huddle** | Slack has no API for apps to join huddles or send/receive huddle audio. Meeting-bot vendors don't support huddles either (e.g. Recall.ai lists Zoom, Meet, Teams, Webex only). | Live call through Slack's Calls API (opens outside Slack, like Zoom does) |
| A live call that stays **inside** the Slack window | Slack's Calls API only shows a card; joining always opens the provider's window or app. | "Float over Slack": an always-on-top mini avatar window (Chrome/Edge) |
| A "tap to talk" button in the avatar panel using the computer's mic | Same frame restriction as above: the page cannot get the microphone. | A helper outside Slack (browser tab or Mac app). Rejected because it adds end-user steps. |
| Opening the side panel straight from a button | Slack only opens the side panel when a user clicks a Work Object card. | The card is attached to the reply (two clicks: button, then card) |

### ⚠️ Works, with caveats
| Area | Caveat |
|---|---|
| **In-message player resets** | Slack reloads the in-message player when the conversation **scrolls**, including when a new message arrives at the bottom. The avatar conversation stops and the user must press play again. The app avoids posting new messages while it plays (the transcript is an edited message), but other activity in the DM (a new question, a call card) can still reset it. The side panel doesn't have this problem. |
| **Voice clips are not live** | Each clip is press, speak, send, then a few seconds of Slack transcription before the avatar answers. Needs Slack clips enabled by workspace admins and Slack's transcription available. |
| **Live call needs one click and a browser** | Opens outside Slack; the first time, the browser asks for the microphone. "Float over Slack" needs Chrome or Edge on desktop. |
| **Sound in the in-message player** | Starts automatically after Slack's play button. If the browser blocks sound, a "Turn on sound" button appears. |
| **Channels** | In a channel, each person has their own conversation with the agent (Kaltura conversations belong to one user). |
| **Mobile** | Not tested on Slack mobile (in-message player, side panel, calls). |
| **Speech recognition quality** | The live call uses Kaltura's speech recognition; misheard phrases happen (seen in testing). |

## Risks

Severity: 🔴 high · 🟠 medium · 🟡 low (for a customer-facing product; acceptable for an internal demo unless noted).

### Platform and vendor
| Risk | Severity | Mitigation |
|---|---|---|
| The in-chat experience depends on **Slack features that can change**: video blocks playing third-party pages, Work Objects embeds (newer feature), the agent view. | 🟠 | Keep the side-panel and live-call paths as fallbacks (already built); watch Slack's changelog. |
| **Slack Marketplace distribution:** Work Objects embeds (side panel) in distributed apps are **invitation-only** (pilot). Marketplace review is required for listing. | 🟠 | Apply to Slack's embeds pilot early; the in-message player doesn't depend on the pilot. |
| **Slack plan requirements:** agent features need paid Slack plans; clips/transcription can be disabled by admins. | 🟡 | State requirements in sales material; fall back to text. |
| **Kaltura SDK** is installed from GitHub (pinned `v1.37.0`), not from npm. | 🟡 | Pin versions; track SDK releases. |

### Operational (current prototype setup)
| Risk | Severity | Mitigation |
|---|---|---|
| The bot service runs on **one developer's Mac**; it stops when the Mac sleeps or the app is closed. | 🔴 | Host it (see [Replicate & reuse → From prototype to product](REPLICATE-AND-REUSE.md#from-prototype-to-product-what-must-change)). |
| The public address is a **temporary Cloudflare tunnel** whose address changes on restart. | 🔴 | Stable domain on real hosting. |
| **State is in memory:** after a restart, text chat starts a new Kaltura conversation and pending live calls are forgotten. (Transcript and avatar links survive restarts.) | 🟠 | Database / Redis. |
| **One workspace per running bot** (single bot token). | 🟠 | "Add to Slack" OAuth install, per-workspace tokens. |
| Slack **rate limits** (message edits ~50/min per app) can slow live updates under heavy use. | 🟡 | Edits are batched (1.5 s); move to Slack streaming in threads where acceptable. |

### Security and privacy
| Risk | Severity | Mitigation |
|---|---|---|
| The **Kaltura admin secret** (full partner access) sits in `.env` on the developer machine and in the K-Vibe app settings. | 🔴 | Rotate the prototype's secret before any customer use; for production use a secrets manager and per-customer credentials. |
| **Avatar links** (12 h for the in-message player and calls, 10 min for the side panel) let anyone who has the link talk to the avatar as that user until it expires. They are only posted in the user's own DM. | 🟠 | Shorter lifetimes; bind links to Slack identity where possible. |
| **Transcript / voice-clip keys** (`lk`) are signed but **don't expire**. Someone who copied a key could add lines to that DM's transcript, or receive that user's voice-clip text while their avatar is open. | 🟠 | Add an expiry to the key (planned), rotate `EMBED_SIGNING_SECRET` if a key leaks. |
| The **K-Vibe avatar page is public** (required by Slack's player). Without a valid signed link it only shows an error, but it is reachable by anyone. | 🟡 | Valid signature required for every page; monitor usage. |
| **Conversation content in Slack:** transcripts and answers are stored as Slack messages (subject to the customer's Slack retention) and in Kaltura conversations. | 🟠 | Document data flows; agree retention with customers. |
| **Likeness:** a custom avatar face from a real person's photo needs that person's consent. | 🟠 | Consent process; the SDK supports recording a consent reference. |
| **AI disclosure:** the avatar shows "You are speaking with an AI-generated avatar". Text answers in Slack are posted by an app labeled "AGENT". | 🟡 | Review disclosure wording per market. |

### Cost
| Risk | Severity | Mitigation |
|---|---|---|
| Every play of the avatar (in-message, panel, call) opens a **live avatar session**, which consumes Kaltura avatar capacity, including sessions left open in a background tab. | 🟠 | Session limits, idle timeouts, usage reporting per customer. |

## Not verified yet
- A real **voice clip** answered by the open avatar end to end (all parts are tested separately; the full flow needs a person to record a clip).
- Speaking in the **live call** and "Float over Slack" with a real microphone (a live call by the product owner was logged correctly).
- **Slack mobile** behavior.
- Behavior with **many users** at once (load).
