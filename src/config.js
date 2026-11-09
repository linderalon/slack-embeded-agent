// Reads and validates environment variables once at startup.

const env = process.env;

function required(name) {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}

const bool = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));

export function loadConfig() {
  const mockKaltura = bool(env.MOCK_KALTURA, false);

  const cfg = {
    slack: {
      botToken: required('SLACK_BOT_TOKEN'),
      appToken: required('SLACK_APP_TOKEN'), // Socket Mode, so no public URL is needed for events
      // Bot replies in channels only when @-mentioned. DMs / the agent container always get a reply.
    },
    kaltura: {
      mock: mockKaltura,
      partnerId: mockKaltura ? env.KALTURA_PARTNER_ID || '0' : required('KALTURA_PARTNER_ID'),
      adminSecret: mockKaltura ? '' : required('KALTURA_ADMIN_SECRET'),
      agentId: mockKaltura ? env.KALTURA_AGENT_ID || 'mock-agent' : required('KALTURA_AGENT_ID'),
      configId: env.KALTURA_CONFIG_ID || undefined, // optional; the SDK looks it up from the agent when absent
      region: env.KALTURA_REGION || undefined, // e.g. 'frp2' for EU partners
      uiConfId: env.KALTURA_UICONF_ID || undefined, // optional player for clip embeds
      modelType: env.KALTURA_MODEL_TYPE || undefined, // 'fast' | 'smart'
      tokenTtlSeconds: Number(env.KALTURA_TOKEN_TTL_SECONDS || 3600),
    },
    avatar: {
      // Public HTTPS origin that serves /embed/avatar (ngrok, cloudflared, or a real host).
      // Leave empty to turn the avatar panel off; the text agent still works.
      publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
      signingSecret: env.EMBED_SIGNING_SECRET || '',
      linkTtlSeconds: Number(env.EMBED_LINK_TTL_SECONDS || 600), // Slack recommends <= 10 minutes
      // Inline: play the avatar inside the reply (Slack video block). Its host must be in the app's
      // unfurl domains (changes need a reinstall) and publicly reachable; otherwise Slack refuses the
      // block and the app falls back to the side-panel card.
      inline: bool(env.AVATAR_INLINE, true),
      // Host for the inline player; defaults to PUBLIC_BASE_URL. Lets the panel and inline player use
      // different hosts (e.g. inline on K-Vibe, panel on a local tunnel).
      inlineBaseUrl: (env.AVATAR_INLINE_BASE_URL || env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
      // The inline player URL stays in the message, so it lives longer than panel links.
      inlineLinkTtlSeconds: Number(env.AVATAR_INLINE_LINK_TTL_SECONDS || 12 * 3600),
      thumbnailUrl: env.AVATAR_THUMBNAIL_URL || '', // the avatar's preview image (scripts/provision.mjs prints it)
    },
    port: Number(env.PORT || 3000),
    streamFlushMs: Number(env.STREAM_FLUSH_MS || 800),
    updateFlushMs: Number(env.UPDATE_FLUSH_MS || 1500),
    voiceTranscriptTimeoutMs: Number(env.VOICE_TRANSCRIPT_TIMEOUT_MS || 45000),
    // false (default): messages outside a thread get a top-level reply and the whole DM is one
    // conversation. true: every reply goes in a thread (Slack's native agent streaming/status).
    threadReplies: bool(env.SLACK_THREAD_REPLIES, false),
    videoBlocks: bool(env.SLACK_VIDEO_BLOCKS, true),
  };

  cfg.avatar.enabled = Boolean(cfg.avatar.publicBaseUrl);
  if (cfg.avatar.enabled) {
    if (!cfg.avatar.publicBaseUrl.startsWith('https://')) {
      throw new Error('PUBLIC_BASE_URL must be https:// (Slack only loads HTTPS embeds)');
    }
    if (cfg.avatar.signingSecret.length < 32) {
      throw new Error('EMBED_SIGNING_SECRET must be at least 32 characters when PUBLIC_BASE_URL is set');
    }
  }
  return cfg;
}
