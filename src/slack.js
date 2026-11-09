// Slack side: listens for DMs (the agent container) and @mentions, relays each turn to the
// Kaltura agent, shows the reply, and handles buttons, feedback, stop and the avatar panel.
//
// Two reply styles:
//  - Top-level (default, `threadReplies: false`): a message sent outside a thread gets one reply
//    message beside it, edited live as the agent writes. The whole DM (or channel, per user) is one
//    continuing conversation with the agent. "New conversation" starts over.
//  - In a thread: when the user writes inside a thread (or `threadReplies: true`), the reply streams
//    into that thread with Slack's agent streaming API, native "Working…" status and stop button.

import { kalturaUserId } from './kaltura.js';
import { SlackReplyStream, SlackUpdateReply } from './stream.js';
import { ACTIONS, widgetsToBlocks, widgetsToLinkBlocks, footerBlocks, avatarWorkObject, avatarVideoBlock } from './blocks.js';
import { signUrl } from './sign.js';
import { AVATAR_PATH } from './embed.js';
import { voiceClips, waitForTranscript } from './voice.js';

const AVATAR_ENTITY_ID = 'kaltura-avatar';
const MAIN = 'main'; // conversation key for top-level (thread-free) chat

/** Kaltura memory is per Slack conversation and per user (Kaltura threads belong to one user). */
export const threadKey = (channel, threadTs, userId) => `${channel}:${threadTs || MAIN}:${userId}`;
const sessionKey = (channel, threadTs, userId) => (threadTs ? `${channel}:${threadTs}` : `${channel}:${MAIN}:${userId}`);
const stripMentions = (text) => String(text || '').replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, '').trim();
/** The thread a message lives in, or undefined for a top-level message. */
const threadOf = (msg) => (msg?.thread_ts && msg.thread_ts !== msg.ts ? msg.thread_ts : undefined);

/**
 * @param {import('@slack/bolt').App} app
 * @param {{bridge: import('./kaltura.js').KalturaBridge, cfg: ReturnType<import('./config.js').loadConfig>, calls?: import('./calls.js').CallManager, avatarLog?: import('./avatar-log.js').AvatarLog, inbox?: import('./inbox.js').AvatarInbox, log?: Console}} deps
 */
export function registerSlackHandlers(app, { bridge, cfg, calls, avatarLog, inbox, log = console }) {
  /** Active turns, so stop buttons can cancel them. */
  const active = new Map();

  async function setStatus(client, channel, threadTs, status) {
    try {
      await client.apiCall('agents.sessions.setStatus', { channel_id: channel, thread_ts: threadTs, status });
    } catch (err) {
      // Older workspaces / assistant_view apps: fall back to the legacy method (bridged by Slack).
      const legacy = status === 'processing' ? 'is thinking…' : '';
      await client.apiCall('assistant.threads.setStatus', { channel_id: channel, thread_ts: threadTs, status: legacy })
        .catch(() => log.debug?.('[slack] setStatus unavailable:', err?.data?.error || err?.message));
    }
  }

  /**
   * Relay one user message to Kaltura and show the answer in Slack.
   * @param {{client:any, channel:string, threadTs?:string, userId:string, teamId:string, text:string, inChannel:boolean, replyTs?:string, header?:string}} t
   *   threadTs: the thread to answer in, or undefined to answer at the top level.
   *   replyTs/header (top-level only): reuse a message already posted (e.g. "Listening…") and show
   *   a line above the answer (e.g. what the user said in a voice clip).
   */
  async function runTurn({ client, channel, threadTs, userId, teamId, text, inChannel, replyTs, header }) {
    if (!text) return;
    const sKey = sessionKey(channel, threadTs, userId);
    active.get(sKey)?.controller.abort(); // a new message supersedes an unfinished turn

    const controller = new AbortController();
    const inThread = Boolean(threadTs);
    const reply = inThread
      ? new SlackReplyStream({
        client, channel, threadTs, flushMs: cfg.streamFlushMs, log,
        ...(inChannel ? { recipientUserId: userId, recipientTeamId: teamId } : {}),
      })
      : new SlackUpdateReply({ client, channel, stopActionId: ACTIONS.stop, stopValue: sKey, flushMs: cfg.updateFlushMs, log, ts: replyTs, header });
    const entry = { controller, reply };
    active.set(sKey, entry);

    if (inThread) await setStatus(client, channel, threadTs, 'processing');
    const threadBefore = bridge.getThread(threadKey(channel, threadTs, userId));
    let done = null;
    try {
      if (!inThread) await reply.start();
      for await (const ev of bridge.turn({
        userId: kalturaUserId(teamId, userId),
        threadKey: threadKey(channel, threadTs, userId),
        text,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) break;
        if (ev.type === 'text') reply.append(ev.text);
        else if (ev.type === 'status') reply.setStatus?.(ev.text);
        else if (ev.type === 'error') reply.append(`${reply.text ? '\n\n' : ''}:warning: ${ev.message}`);
        else if (ev.type === 'auth') {
          await client.chat.postMessage({
            channel, ...(threadTs ? { thread_ts: threadTs } : {}),
            text: `The agent needs you to sign in to ${ev.name}.`,
            blocks: [{
              type: 'section',
              text: { type: 'mrkdwn', text: `The agent needs you to sign in to *${ev.name}* to continue.` },
              accessory: { type: 'button', text: { type: 'plain_text', text: 'Sign in' }, url: ev.url, action_id: 'kaltura_oauth' },
            }],
          });
        } else if (ev.type === 'done') done = ev;
      }

      if (controller.signal.aborted) {
        await reply.abort();
        return;
      }
      const widgets = done?.widgets || [];
      const footer = footerBlocks({ messageId: done?.messageId, avatarEnabled: cfg.avatar.enabled, resetEnabled: !inThread });
      await reply.finish({
        blocks: [...widgetsToBlocks(widgets, { videoBlocks: cfg.videoBlocks }), ...footer],
        fallbackBlocks: [...widgetsToLinkBlocks(widgets), ...footer],
        fallbackText: widgets.length ? 'The agent shared some results.' : 'The agent had no answer for that.',
      });
    } catch (err) {
      log.error('[slack] turn failed:', err?.data?.error || err?.code || '', err?.message || err);
      await client.chat.postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), text: ':warning: Something went wrong talking to the agent. Please try again.' }).catch(() => {});
    } finally {
      if (active.get(sKey) === entry) active.delete(sKey);
      if (inThread) await setStatus(client, channel, threadTs, 'active');
      // A new top-level conversation started in a DM: point the avatar message at it, so the avatar
      // continues this conversation.
      const threadAfter = bridge.getThread(threadKey(channel, threadTs, userId));
      if (!inThread && welcomes.has(channel) && threadAfter && threadAfter !== threadBefore) {
        await ensureWelcome({ client, channel, userId, teamId, force: true }).catch(() => {});
      }
    }
  }

  /** Where to answer a message: its thread if it has one; otherwise the top level, unless threads are forced. */
  const replyThread = (msg) => threadOf(msg) || (cfg.threadReplies ? msg.ts : undefined);

  // ── Messages ────────────────────────────────────────────────────────────────

  // DMs, including the agent container (Agent messaging experience).
  app.message(async ({ message, client, context }) => {
    if (message.channel_type !== 'im') return;
    if (message.bot_id || !message.user) return;
    const clips = message.subtype === 'file_share' ? voiceClips(message) : [];
    if (clips.length) {
      await handleVoiceClip({ client, message, clip: clips[0], teamId: context.teamId || message.team });
      return;
    }
    if (message.subtype || !('text' in message)) return;
    await runTurn({
      client,
      channel: message.channel,
      threadTs: replyThread(message),
      userId: message.user,
      teamId: context.teamId || message.team,
      text: stripMentions(message.text),
      inChannel: false,
    });
  });

  /**
   * A voice clip recorded with Slack's mic button: show "Listening…", wait for Slack's transcript,
   * then answer it like a typed message, in the same reply (top level) or in the clip's thread.
   */
  const quoteHeard = (heard) => `:microphone: _You said:_ “${heard.length > 600 ? `${heard.slice(0, 600)}…` : heard}”`;

  async function handleVoiceClip({ client, message, clip, teamId }) {
    const channel = message.channel;
    const threadTs = replyThread(message);
    const listening = await client.chat.postMessage({
      channel, ...(threadTs ? { thread_ts: threadTs } : {}),
      text: 'Listening to your voice clip…',
      blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: ':microphone: _Listening to your voice clip…_' }] }],
    });
    const heard = await waitForTranscript(client, clip, { timeoutMs: cfg.voiceTranscriptTimeoutMs, log });
    if (!heard) {
      await client.chat.update({
        channel, ts: listening.ts,
        text: "I couldn't get a transcript of that clip.",
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: ":microphone: I couldn't get a transcript of that clip from Slack. Please type your question, or use *Talk by voice* to speak with the avatar." } }],
      });
      return;
    }
    const typed = stripMentions(message.text || '');
    const text = typed ? `${typed}\n\n${heard}` : heard;
    // An avatar is open for this user here (side panel, in-message player or call window):
    // hand it the words so it answers out loud; the exchange lands in the avatar transcript.
    if (inbox?.deliver(channel, message.user, text)) {
      await client.chat.update({
        channel, ts: listening.ts, text: `You said: ${heard}`,
        blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: `${quoteHeard(heard)} · _the avatar is answering out loud_` }] }],
      });
      return;
    }
    const header = quoteHeard(heard);
    if (threadTs) {
      await client.chat.update({ channel, ts: listening.ts, text: `You said: ${heard}`, blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: header }] }] });
      await runTurn({ client, channel, threadTs, userId: message.user, teamId, text, inChannel: false });
    } else {
      await runTurn({ client, channel, userId: message.user, teamId, text, inChannel: false, replyTs: listening.ts, header });
    }
  }

  // @mentions in channels.
  app.event('app_mention', async ({ event, client, context }) => {
    if (!event.user) return;
    const text = stripMentions(event.text);
    const threadTs = replyThread(event);
    if (!text) {
      await client.chat.postMessage({ channel: event.channel, ...(threadTs ? { thread_ts: threadTs } : {}), text: 'Hi! Ask me anything.' });
      return;
    }
    await runTurn({ client, channel: event.channel, threadTs, userId: event.user, teamId: context.teamId || event.team, text, inChannel: true });
  });

  // Slack's native stop button (thread replies only).
  app.event('agent_session_stopped', async ({ event, client }) => {
    const entry = active.get(sessionKey(event.channel, event.thread_ts));
    if (entry) entry.controller.abort();
    else await setStatus(client, event.channel, event.thread_ts, 'active');
  });

  // ── Buttons ─────────────────────────────────────────────────────────────────

  // Our Stop button on top-level replies.
  app.action(ACTIONS.stop, async ({ ack, action }) => {
    await ack();
    active.get(action.value)?.controller.abort();
  });

  // Start a fresh Kaltura conversation for top-level chat.
  app.action(ACTIONS.reset, async ({ ack, body, respond, client, context }) => {
    await ack();
    const channel = body.channel?.id;
    if (!channel) return;
    bridge.threads.delete(threadKey(channel, undefined, body.user.id));
    avatarLog?.forget({ channel, slackUserId: body.user.id });
    await respond({ response_type: 'ephemeral', replace_original: false, text: 'Started a new conversation. Ask me anything.' });
    if (channel.startsWith('D') && welcomes.has(channel)) await ensureWelcome({ client, channel, userId: body.user.id, teamId: context.teamId || body.team?.id, force: true }).catch(() => {});
  });

  // Suggested follow-up questions from the agent: send the question as the user's next turn.
  app.action(new RegExp(`^${ACTIONS.followup}:`), async ({ ack, body, action, client, context }) => {
    await ack();
    const question = action.value;
    const channel = body.channel?.id;
    if (!question || !channel) return;
    const threadTs = threadOf(body.message);
    await client.chat.postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), text: `<@${body.user.id}> asked: ${question}` });
    await runTurn({
      client, channel, threadTs, userId: body.user.id, teamId: context.teamId || body.team?.id,
      text: question, inChannel: !channel.startsWith('D'),
    });
  });

  // Flashcards: reveal the answer to the person who clicked.
  app.action(new RegExp(`^${ACTIONS.card}:`), async ({ ack, action, respond }) => {
    await ack();
    await respond({ response_type: 'ephemeral', replace_original: false, text: action.value || '(no answer)' });
  });

  // Thumbs up / down -> Kaltura message feedback (rated as the clicking user).
  app.action(ACTIONS.feedback, async ({ ack, action, body, context }) => {
    await ack();
    const [dir, messageId] = String(action.value || '').split('|');
    if (!messageId) return;
    try {
      await bridge.feedback({ userId: kalturaUserId(context.teamId || body.team?.id, body.user.id), messageId, positive: dir === 'up' });
    } catch (err) {
      // Kaltura only accepts feedback from the user who asked; others' clicks are ignored.
      log.warn('[slack] feedback not recorded:', err?.code || err?.message);
    }
  });

  // URL buttons still send an action we must ack.
  app.action('kaltura_oauth', async ({ ack }) => { await ack(); });
  app.action(ACTIONS.openAvatarBrowser, async ({ ack }) => { await ack(); });

  // ── Avatar panel (Work Objects embed) ───────────────────────────────────────

  // "Talk to the avatar", in order of preference, all without posting a new message:
  //  1. inline: replace the button with a Slack video block that plays the live avatar in the reply;
  //  2. card: attach a Work Object card to the reply; clicking it opens the avatar in Slack's panel;
  //  3. if Slack refuses both edits, post the card as a message at the same level.
  app.action(ACTIONS.openAvatar, async ({ ack, body, client, context }) => {
    await ack();
    if (!cfg.avatar.enabled) return;
    const channel = body.channel?.id;
    const msg = body.message;
    const teamId = context.teamId || body.team?.id;
    const threadTs = threadOf(msg);
    const withoutButton = (msg?.blocks || [])
      .map((b) => (b.type === 'actions' ? { ...b, elements: b.elements.filter((e) => e.action_id !== ACTIONS.openAvatar) } : b))
      .filter((b) => b.type !== 'actions' || b.elements.length);
    const text = msg?.text || 'Talk to the avatar';

    if (cfg.avatar.inline && cfg.avatar.thumbnailUrl) {
      const url = new URL(signedAvatarUrl({ teamId, userId: body.user.id, channel, threadTs, ttlSeconds: cfg.avatar.inlineLinkTtlSeconds, baseUrl: cfg.avatar.inlineBaseUrl || cfg.avatar.publicBaseUrl }));
      url.searchParams.set('autostart', '1');
      try {
        await client.chat.update({ channel, ts: msg.ts, text, blocks: [...withoutButton, avatarVideoBlock({ url: url.toString(), thumbnailUrl: cfg.avatar.thumbnailUrl })] });
        await avatarLog?.ensureTranscript({ channel, slackUserId: body.user.id, threadTs }).catch((err) => log.warn('[slack] transcript message:', err?.data?.error || err?.message));
        return;
      } catch (err) {
        log.warn('[slack] inline avatar refused, using the side-panel card:', err?.data?.error || err?.message, JSON.stringify(err?.data?.errors || []));
      }
    }

    const metadata = avatarWorkObject({ url: `${cfg.avatar.publicBaseUrl}${AVATAR_PATH}` });
    const blocks = [...withoutButton, { type: 'context', elements: [{ type: 'mrkdwn', text: ':point_down: Click the card to open the avatar beside this chat. While it is open, record a voice clip here and she answers out loud.' }] }];
    try {
      await client.chat.update({ channel, ts: msg.ts, text, blocks, metadata });
    } catch (err) {
      log.warn('[slack] could not attach the avatar card to the reply, posting it instead:', err?.data?.error || err?.message);
      await client.chat.postMessage({
        channel, ...(threadTs ? { thread_ts: threadTs } : {}),
        text: 'Talk to the avatar: click this card to open it beside the conversation.',
        metadata,
      });
    }
  });

  // ── The avatar waiting in the DM ────────────────────────────────────────────
  // When someone opens the agent's DM, make sure one "talk with me live" message is there:
  // the inline avatar player (or, if Slack refuses it, the side-panel card) plus a voice button.
  // The message is updated in place (fresh link, current conversation), never reposted.

  const WELCOME = 'kaltura_welcome';
  const WELCOME_VERSION = 5; // bump when the message layout changes, so existing ones are refreshed
  const welcomes = new Map(); // channel -> { ts, mode, exp, triedInlineAt }
  const nowS = () => Math.floor(Date.now() / 1000);

  function welcomeContent({ teamId, userId, channel, mode }) {
    const exp = nowS() + cfg.avatar.inlineLinkTtlSeconds;
    const voiceUrl = signedAvatarUrl({ teamId, userId, channel, ttlSeconds: cfg.avatar.inlineLinkTtlSeconds });
    const blocks = [{
      type: 'section',
      block_id: `${WELCOME}:${mode}:${exp}:${WELCOME_VERSION}`,
      text: {
        type: 'mrkdwn',
        text: mode === 'inline'
          ? "*Talk with me live.* Press play, then type under the video or record a voice clip here, and I'll answer out loud. Or just message me here."
          : "*Talk with me live.* Click the card to open me beside this chat, then type there or record a voice clip here, and I'll answer out loud. Or just message me here.",
      },
    }];
    if (mode === 'inline') {
      const url = new URL(signedAvatarUrl({ teamId, userId, channel, ttlSeconds: cfg.avatar.inlineLinkTtlSeconds, baseUrl: cfg.avatar.inlineBaseUrl || cfg.avatar.publicBaseUrl }));
      url.searchParams.set('autostart', '1');
      blocks.push(avatarVideoBlock({ url: url.toString(), thumbnailUrl: cfg.avatar.thumbnailUrl }));
    }
    const callUrl = calls ? calls.reserve({ channel, slackUserId: userId, joinUrlFor: (k) => callJoinUrl({ teamId, userId, channel, k }) }).joinUrl : voiceUrl;
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', action_id: ACTIONS.openAvatarBrowser, url: callUrl, style: 'primary', text: { type: 'plain_text', text: ':telephone_receiver: Start a live call', emoji: true } }],
    });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: "A live call is hands-free: just talk, and you can interrupt. It opens in a browser window, because Slack doesn't let apps use your microphone inside Slack. You can also type `/talk`." }] });
    const metadata = mode === 'card' ? avatarWorkObject({ url: `${cfg.avatar.publicBaseUrl}${AVATAR_PATH}` }) : undefined;
    return { blocks, exp, metadata, text: 'Talk with the Kaltura avatar live' };
  }

  async function findWelcome(client, channel, botUserId) {
    const res = await client.conversations.history({ channel, limit: 100 });
    for (const m of res.messages || []) {
      if (botUserId && m.user !== botUserId) continue;
      const b = (m.blocks || []).find((x) => String(x.block_id || '').startsWith(`${WELCOME}:`));
      if (b) {
        const [, mode, exp, version] = b.block_id.split(':');
        return { ts: m.ts, mode, exp: Number(exp) || 0, version: Number(version) || 1 };
      }
    }
    return null;
  }

  /** Make sure the DM has a fresh avatar message. force: rebuild it now (e.g. the conversation changed). */
  async function ensureWelcome({ client, channel, userId, teamId, botUserId, force = false }) {
    if (!cfg.avatar.enabled) return;
    let w = welcomes.get(channel);
    if (!w) {
      w = await findWelcome(client, channel, botUserId).catch((err) => { log.warn('[slack] history lookup failed:', err?.data?.error || err?.message); return null; });
      if (w) welcomes.set(channel, w);
    }
    const canInline = cfg.avatar.inline && Boolean(cfg.avatar.thumbnailUrl);
    const retryInline = w?.mode === 'card' && canInline && nowS() - (w.triedInlineAt || 0) > 600;
    const outdated = w && w.version && w.version !== WELCOME_VERSION;
    if (w && !force && !retryInline && !outdated && w.exp - nowS() > 3600) {
      await avatarLog?.ensureTranscript({ channel, slackUserId: userId }).catch((err) => log.warn('[slack] transcript message:', err?.data?.error || err?.message));
      return;
    }

    const modes = canInline ? ['inline', 'card'] : ['card'];
    for (const mode of modes) {
      const c = welcomeContent({ teamId, userId, channel, mode });
      const args = { channel, text: c.text, blocks: c.blocks, ...(c.metadata ? { metadata: c.metadata } : {}) };
      try {
        // Slack keeps a Work Object card on a message even when it is edited, so going from the
        // card to the player means a fresh message (and removing the app's old card message).
        const replaceCard = w && w.mode === 'card' && mode === 'inline';
        const res = w && !replaceCard ? await client.chat.update({ ...args, ts: w.ts }) : await client.chat.postMessage(args);
        if (replaceCard) await client.chat.delete({ channel, ts: w.ts }).catch((err) => log.warn('[slack] could not remove the old avatar card:', err?.data?.error || err?.message));
        welcomes.set(channel, { ts: replaceCard || !w ? res.ts : w.ts, mode, exp: c.exp, version: WELCOME_VERSION, triedInlineAt: mode === 'card' && canInline ? nowS() : w?.triedInlineAt });
        // The transcript message goes right under it now, before the player is used (see avatar-log.js).
        await avatarLog?.ensureTranscript({ channel, slackUserId: userId }).catch((err) => log.warn('[slack] transcript message:', err?.data?.error || err?.message));
        return;
      } catch (err) {
        const code = err?.data?.error;
        if (mode === 'inline' && code === 'invalid_blocks') {
          log.info?.('[slack] inline avatar not available yet, using the side-panel card:', JSON.stringify(err?.data?.response_metadata?.messages || []));
          continue;
        }
        if (w && code === 'message_not_found') { welcomes.delete(channel); w = null; return ensureWelcome({ client, channel, userId, teamId, botUserId, force }); }
        log.warn('[slack] could not show the avatar welcome:', code || err?.message);
        return;
      }
    }
  }

  app.event('app_home_opened', async ({ event, client, context }) => {
    if (event.tab !== 'messages' || !event.channel) return;
    await ensureWelcome({ client, channel: event.channel, userId: event.user, teamId: context.teamId, botUserId: context.botUserId });
  });

  // ── Live voice calls ────────────────────────────────────────────────────────

  /** Call page link: the signed avatar link (current conversation) plus the call key. */
  function callJoinUrl({ teamId, userId, channel, k }) {
    const url = new URL(signedAvatarUrl({ teamId, userId, channel, ttlSeconds: cfg.avatar.inlineLinkTtlSeconds, baseUrl: cfg.avatar.publicBaseUrl }));
    url.searchParams.set('k', k);
    return url.toString();
  }

  // /talk: post a Slack call card with a Join button that opens the hands-free call page.
  app.command('/talk', async ({ ack, command, client, context, respond }) => {
    await ack();
    if (!cfg.avatar.enabled || !calls) {
      await respond({ response_type: 'ephemeral', text: 'Live calls are not set up for this app.' });
      return;
    }
    const channel = command.channel_id;
    const teamId = context.teamId || command.team_id;
    const { k, joinUrl } = calls.reserve({ channel, slackUserId: command.user_id, joinUrlFor: (key) => callJoinUrl({ teamId, userId: command.user_id, channel, k: key }) });
    try {
      await calls.open(k);
    } catch (err) {
      // e.g. a channel the app isn't in: hand the user a private link instead.
      log.warn('[calls] could not post the call card:', err?.data?.error || err?.message);
      await respond({ response_type: 'ephemeral', text: `Start your live call with the avatar: ${joinUrl}` });
    }
  });

  app.event('entity_details_requested', async ({ event, body, client, context }) => {
    if (event.external_ref?.id !== AVATAR_ENTITY_ID || !cfg.avatar.enabled) return;
    // A card on a top-level message continues the top-level conversation; one in a thread, that thread's.
    const threadTs = event.thread_ts && event.thread_ts !== event.message_ts ? event.thread_ts : undefined;
    const url = signedAvatarUrl({ teamId: context.teamId || body.team_id, userId: event.user, channel: event.channel, threadTs });
    const wo = avatarWorkObject({ url: event.entity_url || `${cfg.avatar.publicBaseUrl}${AVATAR_PATH}` }).entities[0];
    wo.entity_payload.attributes.full_size_preview.preview_url = url;
    wo.entity_payload.attributes.metadata_last_modified = Math.floor(Date.now() / 1000);
    await client.apiCall('entity.presentDetails', {
      trigger_id: event.trigger_id,
      metadata: { entity_type: wo.entity_type, url: wo.url, external_ref: wo.external_ref, entity_payload: wo.entity_payload },
    });
  });

  /**
   * A signed avatar link that continues this user's conversation. With a channel, it also carries a
   * log key (lk) so the avatar page reports what was said and the app posts it in that conversation
   * (thread, if any). For a page on another host (the hosted inline player), lb tells it this app's host.
   */
  function signedAvatarUrl({ teamId, userId, channel, threadTs, ttlSeconds = cfg.avatar.linkTtlSeconds, baseUrl = cfg.avatar.publicBaseUrl }) {
    const kUser = kalturaUserId(teamId, userId);
    const threadId = channel ? bridge.getThread(threadKey(channel, threadTs, userId)) : undefined;
    const url = new URL(signUrl(baseUrl, AVATAR_PATH, { userId: kUser, threadId, ttlSeconds }, cfg.avatar.signingSecret));
    if (avatarLog && channel) {
      url.searchParams.set('lk', avatarLog.reserve({ channel, slackUserId: userId, threadTs }));
      if (new URL(baseUrl).origin !== new URL(cfg.avatar.publicBaseUrl).origin) url.searchParams.set('lb', new URL(cfg.avatar.publicBaseUrl).origin);
    }
    return url.toString();
  }

  return { runTurn, active, ensureWelcome, welcomes };
}
