// Turns Kaltura GenUI widget descriptors ({kind, data}) into Slack Block Kit.
// Pure functions: no Slack or Kaltura calls, so they are easy to test.

export const ACTIONS = {
  followup: 'kaltura_followup', // + `:<index>`
  feedback: 'kaltura_feedback',
  openAvatar: 'kaltura_open_avatar',
  openAvatarBrowser: 'kaltura_open_avatar_browser',
  card: 'kaltura_card', // + `:<index>` flashcard reveal
  stop: 'kaltura_stop',
  reset: 'kaltura_reset',
};

const clamp = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// Slack mrkdwn needs &, <, > escaped in user-visible text.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const link = (url, label) => (url ? `<${url}|${esc(label || url).replace(/\|/g, '¦')}>` : esc(label));
const plain = (text, n = 75) => ({ type: 'plain_text', text: clamp(text, n) || ' ', emoji: true });
const section = (mrkdwn) => ({ type: 'section', text: { type: 'mrkdwn', text: clamp(mrkdwn, 3000) } });

function fmtTime(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '';
  const s = Math.max(0, Math.floor(Number(sec)));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
const range = (a, b) => {
  const s = fmtTime(a); const e = fmtTime(b);
  return s && e ? `${s}–${e}` : s ? `from ${s}` : '';
};

/**
 * @param {{kind:string, data:any}[]} widgets
 * @param {{videoBlocks?:boolean}} [opts]  videoBlocks:false renders clips as links (no links.embed:write needed)
 * @returns {object[]} blocks
 */
export function widgetsToBlocks(widgets, opts = {}) {
  const videoBlocks = opts.videoBlocks !== false;
  const blocks = [];
  let followupIdx = 0;

  for (const w of widgets || []) {
    const d = w.data || {};
    switch (w.kind) {
      case 'video-gallery': {
        const vids = (d.videos || []).slice(0, 5);
        if (!vids.length) break;
        if (d.title) blocks.push(section(`*${esc(d.title)}*`));
        for (const v of vids) {
          const title = v.title || v.entryId || 'Video';
          const when = range(v.startTime, v.endTime);
          const target = v.url || v.embedUrl;
          if (videoBlocks && v.embedUrl && v.thumbnailUrl) {
            blocks.push({
              type: 'video',
              title: plain(when ? `${title} (${when})` : title, 199),
              title_url: target || undefined,
              alt_text: clamp(v.alt || title, 200),
              thumbnail_url: v.thumbnailUrl,
              video_url: v.embedUrl,
              provider_name: 'Kaltura',
              ...(v.description ? { description: plain(v.description, 199) } : {}),
            });
          } else {
            const line = `:clapper: ${link(target, title)}${when ? `  _${when}_` : ''}`;
            blocks.push(v.thumbnailUrl
              ? { ...section(line), accessory: { type: 'image', image_url: v.thumbnailUrl, alt_text: clamp(title, 200) } }
              : section(line));
          }
        }
        break;
      }
      case 'sources': {
        const items = (d.sources || []).slice(0, 10);
        if (!items.length) break;
        const els = items.map((s, i) => ({
          type: 'mrkdwn',
          text: clamp(`${i + 1}. ${link(s.url, s.title || s.entryId || 'Source')}${s.startTime != null ? ` (${fmtTime(s.startTime)})` : ''}`, 300),
        }));
        // A context block holds at most 10 elements.
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '*Sources*' }, ...els].slice(0, 10) });
        break;
      }
      case 'followups': {
        const qs = (d.questions || []).map((q) => (typeof q === 'string' ? q : q?.text || q?.question || '')).filter(Boolean).slice(0, 5);
        if (!qs.length) break;
        blocks.push({
          type: 'actions',
          elements: qs.map((q) => ({
            type: 'button',
            action_id: `${ACTIONS.followup}:${followupIdx++}`,
            text: plain(q, 75),
            value: clamp(q, 2000),
          })),
        });
        break;
      }
      case 'summary': {
        const lines = [];
        if (d.title) lines.push(`*${esc(d.title)}*`);
        if (d.summary) lines.push(esc(d.summary));
        for (const b of d.bullets || []) lines.push(`• ${esc(b)}`);
        for (const c of d.chapters || []) lines.push(`• ${c.startTime != null ? `\`${fmtTime(c.startTime)}\` ` : ''}${esc(c.title || c.text || '')}`);
        if (lines.length) blocks.push(section(lines.join('\n')));
        break;
      }
      case 'flashcards': {
        const cards = (d.cards || []).slice(0, 10);
        if (!cards.length) break;
        if (d.title) blocks.push(section(`*${esc(d.title)}*`));
        cards.forEach((c, i) => {
          blocks.push({
            ...section(`*Q${i + 1}.* ${esc(c.front)}`),
            accessory: { type: 'button', action_id: `${ACTIONS.card}:${i}`, text: plain('Show answer'), value: clamp(c.back, 2000) },
          });
        });
        break;
      }
      case 'show-link':
        if (d.safe && d.url) blocks.push(section(`:link: ${link(d.url, d.label)}${d.description ? `\n${esc(d.description)}` : ''}`));
        break;
      case 'external-video':
        if (d.safe && d.url) blocks.push(section(`:tv: ${link(d.url, d.title || d.url)}${d.description ? `\n${esc(d.description)}` : ''}`));
        break;
      case 'content-gallery': {
        for (const it of (d.items || []).slice(0, 5)) {
          const line = `${link(it.url, it.title || 'Item')}${it.description ? `\n${esc(it.description)}` : ''}`;
          blocks.push(it.imageUrl
            ? { ...section(line), accessory: { type: 'image', image_url: it.imageUrl, alt_text: clamp(it.alt || it.title || 'image', 200) } }
            : section(line));
        }
        break;
      }
      case 'user-properties-form':
        // Forms need a modal round-trip; point people to the avatar/web experience for now.
        blocks.push(section('_The agent asked for some details. Open the avatar panel to fill in the form._'));
        break;
      default:
        break;
    }
  }
  return blocks.slice(0, 45); // leave room under Slack's 50-block limit for feedback/actions
}

/** Same widgets with every video block downgraded to a link (fallback when Slack rejects video blocks). */
export const widgetsToLinkBlocks = (widgets) => widgetsToBlocks(widgets, { videoBlocks: false });

/** Thumbs up/down that rate the Kaltura message, plus the avatar / new-conversation buttons. */
export function footerBlocks({ messageId, avatarEnabled, resetEnabled = false }) {
  const blocks = [];
  if (messageId) {
    blocks.push({
      type: 'context_actions',
      elements: [{
        type: 'feedback_buttons',
        action_id: ACTIONS.feedback,
        positive_button: { text: plain('Good response'), accessibility_label: 'Mark this response as good', value: `up|${messageId}` },
        negative_button: { text: plain('Bad response'), accessibility_label: 'Mark this response as bad', value: `down|${messageId}` },
      }],
    });
  }
  const buttons = [];
  if (avatarEnabled) buttons.push({ type: 'button', action_id: ACTIONS.openAvatar, text: plain(':bust_in_silhouette: Talk to the avatar'), value: 'open' });
  if (resetEnabled) buttons.push({ type: 'button', action_id: ACTIONS.reset, text: plain('New conversation'), value: 'reset' });
  if (buttons.length) blocks.push({ type: 'actions', elements: buttons });
  return blocks;
}

/** Inline live avatar: a Slack video block whose player is the avatar page. */
export function avatarVideoBlock({ url, thumbnailUrl, title = 'Talk to the avatar' }) {
  return {
    type: 'video',
    block_id: `kaltura_avatar_${Date.now()}`,
    title: plain(title, 199),
    alt_text: 'Live Kaltura avatar',
    thumbnail_url: thumbnailUrl,
    video_url: url,
    provider_name: 'Kaltura',
    description: plain('Press play to talk to the avatar here.', 199),
  };
}

/** Work Object card that opens the avatar page in Slack's side panel (flexpane). */
export function avatarWorkObject({ url, title = 'Talk to the avatar', productName = 'Kaltura' }) {
  return {
    entities: [{
      url,
      external_ref: { id: 'kaltura-avatar', type: 'avatar' },
      entity_type: 'slack#/entities/file',
      entity_payload: {
        attributes: {
          title: { text: title },
          product_name: productName,
          full_size_preview: { is_supported: true, mime_type: 'application/vnd.slack-embed' },
        },
        fields: {},
      },
    }],
  };
}
