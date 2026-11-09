// Slack side of the prototype (a separate TEST app, never the "Kaltura Agent" app).
// One experience: a Genie voice call. A "Start a call" button is always in Slack (the app's Home tab,
// and the newest message in its DM). It opens the call page in a browser window, where Kaltura's Genie
// avatar has the microphone. Slack shows a native call card while it runs and the summary afterwards.
// There is no text chat inside Slack, by design.

import bolt from '@slack/bolt';

/** Same identity scheme as the existing bot, so one Slack user = one Kaltura user (shared Genie history). */
export const kalturaUserId = (teamId, userId) => `slack-${teamId || 'T'}-${userId}`;

export const START_ACTION = 'start_call';

/** The "Start a call" button. A link button: one click opens a new call in the browser. */
export const startButton = (url, label = 'Start a call') => ({
  type: 'button', action_id: START_ACTION, style: 'primary', url,
  text: { type: 'plain_text', text: `:telephone_receiver: ${label}`, emoji: true },
});

export function launcherBlocks(url) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: '*Talk to Kaltura Genie*\nAsk anything out loud. The call opens in your browser, and the summary lands here when you hang up.' } },
    { type: 'actions', elements: [startButton(url)] },
  ];
}

export function homeView(url) {
  return {
    type: 'home',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Kaltura Genie', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: 'Talk to Genie, Kaltura\'s AI avatar, in a voice call. Ask questions out loud and get answers with video from your Kaltura library.' } },
      { type: 'actions', elements: [startButton(url)] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'The call opens in your browser, because Slack doesn\'t give apps the microphone. Each call and its summary appear in *Messages*.' }] },
    ],
  };
}

export async function startSlack({ calls, startUrlFor, log = console }) {
  const app = new bolt.App({ token: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN, socketMode: true });
  calls.client = app.client;

  const dmOf = async (client, userId) => (await client.conversations.open({ users: userId })).channel.id;
  const postLauncher = async (client, { teamId, userId, channel }) => client.chat.postMessage({
    channel, text: 'Talk to Kaltura Genie: Start a call', blocks: launcherBlocks(startUrlFor({ teamId, slackUserId: userId, channel })),
  });

  app.command('/genie', async ({ ack, body, client, context }) => {
    await ack();
    const teamId = context.teamId || body.team_id;
    await postLauncher(client, { teamId, userId: body.user_id, channel: await dmOf(client, body.user_id) });
  });

  app.event('app_home_opened', async ({ event, client, context, body }) => {
    const teamId = context.teamId || body.team_id;
    if (event.tab === 'home') {
      const channel = await dmOf(client, event.user);
      await client.views.publish({ user_id: event.user, view: homeView(startUrlFor({ teamId, slackUserId: event.user, channel })) });
      return;
    }
    const hist = await client.conversations.history({ channel: event.channel, limit: 1 }).catch(() => null);
    if (!hist?.messages?.length) await postLauncher(client, { teamId, userId: event.user, channel: event.channel });
  });

  // Any DM to the app: answer with the button (Genie itself is only reachable by voice).
  app.message(async ({ message, context, body, client }) => {
    if (message.channel_type !== 'im' || message.bot_id || message.subtype) return;
    await postLauncher(client, { teamId: context.teamId || body.team_id, userId: message.user, channel: message.channel });
  });

  // Link buttons still send an action; acknowledge it so Slack doesn't show an error.
  app.action(START_ACTION, async ({ ack }) => { await ack(); });

  await app.start();
  log.log('Slack test app connected (Socket Mode, call-only mode)');
  return app;
}
