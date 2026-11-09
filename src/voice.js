// Voice clips recorded with Slack's mic button: find them on a message and get Slack's own
// transcript. Slack transcribes audio/video clips asynchronously, so the transcript may appear a
// few seconds after the message. Reading it with files.info needs the files:read scope.

/** Audio or video clips attached to a message (Slack's recorded clips, or uploaded audio/video). */
export function voiceClips(message) {
  return (message?.files || []).filter((f) =>
    f && (f.subtype === 'slack_audio' || f.subtype === 'slack_video' || /^(audio|video)\//.test(f.mimetype || '')));
}

/** Plain text from WebVTT captions: drops the header, cue ids, timings, notes and voice tags. */
export function parseVtt(vtt) {
  const out = [];
  let inNote = false;
  for (const raw of String(vtt || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { inNote = false; continue; }
    if (inNote || /^WEBVTT/.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line)) { if (/^NOTE\b/.test(line)) inNote = true; continue; }
    if (line.includes('-->') || /^\d+$/.test(line)) continue;
    out.push(line.replace(/<[^>]+>/g, '').trim());
  }
  return out.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * What we know about a file's transcript right now.
 * @returns {{status:'complete', text:string} | {status:'pending'|'unavailable'}}
 */
export function transcriptOf(file) {
  if (!file) return { status: 'pending' };
  if (file.vtt) {
    const text = parseVtt(file.vtt);
    if (text) return { status: 'complete', text };
  }
  const t = file.transcription;
  const preview = t?.preview?.content?.trim();
  if (t?.status === 'complete') return preview ? { status: 'complete', text: preview } : { status: 'unavailable' };
  if (t?.status === 'failed' || file.is_transcription_region_supported === false) return { status: 'unavailable' };
  return { status: 'pending' };
}

/**
 * Wait for Slack to finish transcribing a clip. Returns the text, or null if Slack gives none in time.
 * @param {any} client  Slack WebClient (files.info)
 * @param {object} file the file object from the message event
 * @param {{timeoutMs?:number, intervalMs?:number, sleep?:(ms:number)=>Promise<void>, log?:Console}} [o]
 */
export async function waitForTranscript(client, file, o = {}) {
  const { timeoutMs = 45_000, intervalMs = 2_500, log = console } = o;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let current = file;
  let fetched = false;
  for (;;) {
    const r = transcriptOf(current);
    if (r.status === 'complete') return r.text;
    // The event's copy can be partial: only give up after reading the full file at least once.
    if (r.status === 'unavailable' && fetched) return null;
    if (fetched && Date.now() >= deadline) return null;
    if (fetched) await sleep(intervalMs);
    try {
      current = (await client.files.info({ file: file.id })).file || current;
    } catch (err) {
      log.warn('[voice] files.info failed:', err?.data?.error || err?.message);
      if (err?.data?.error === 'missing_scope') return null;
    }
    fetched = true;
  }
}
