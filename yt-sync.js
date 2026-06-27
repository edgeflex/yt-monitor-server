/**
 * EDGX Studio — YouTube Channel Sync
 * 
 * POST /yt-sync
 * Body: { channels: [{ channelId, name, lastVideoPublishedAt }] }
 * Returns: { videos: [{ videoId, channelId, channelName, title, publishedAt, transcript }] }
 *
 * For each channel in the batch:
 *   1. Calls YouTube Data API v3 /search to get recent videos
 *   2. For each new video (after lastVideoPublishedAt): calls /captions 
 *      and fetches the auto-generated transcript via timedtext endpoint
 *   3. Returns all new videos with title + transcript text
 *
 * Environment variable required:
 *   YOUTUBE_API_KEY — YouTube Data API v3 key (console.cloud.google.com)
 */

'use strict';

const { YOUTUBE_API_KEY } = process.env;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

/* fetch polyfill — Node 18+ has it natively */
const _fetch = typeof fetch !== 'undefined' ? fetch : (...args) => import('node-fetch').then(m => m.default(...args));

/* ── Fetch recent videos for one channel ──────────────────────────────── */
async function getChannelVideos(channelId, publishedAfter) {
  if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY not set');

  const params = new URLSearchParams({
    part:       'snippet',
    channelId,
    order:      'date',
    type:       'video',
    maxResults: '5',
    key:        YOUTUBE_API_KEY,
  });
  if (publishedAfter) params.set('publishedAfter', publishedAfter);

  const url = `${YT_BASE}/search?${params}`;
  const res = await _fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`YT search HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(item => ({
    videoId:     item.id?.videoId,
    title:       item.snippet?.title || '',
    publishedAt: item.snippet?.publishedAt || null,
    channelId,
  }));
}

/* ── Fetch auto-generated transcript for one video ───────────────────── */
async function getTranscript(videoId) {
  try {
    /* Step 1: get caption track list */
    const params = new URLSearchParams({ part: 'snippet', videoId, key: YOUTUBE_API_KEY });
    const res = await _fetch(`${YT_BASE}/captions?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return '';
    const data = await res.json();
    const tracks = data.items || [];

    /* Prefer: en auto-generated, then any auto-generated, then first en */
    const asr   = tracks.find(t => t.snippet?.trackKind === 'asr' && t.snippet?.language?.startsWith('en'));
    const anyAsr = tracks.find(t => t.snippet?.trackKind === 'asr');
    const en    = tracks.find(t => t.snippet?.language?.startsWith('en'));
    const track = asr || anyAsr || en || tracks[0];
    if (!track?.id) return '';

    /* Step 2: fetch raw timed-text XML (no API key needed for this endpoint) */
    const ttUrl = `https://www.youtube.com/api/timedtext?lang=${track.snippet?.language || 'en'}&v=${videoId}&fmt=json3`;
    const ttRes = await _fetch(ttUrl, { signal: AbortSignal.timeout(10000) });
    if (!ttRes.ok) return '';
    const ttData = await ttRes.json();

    /* Flatten events into plain text */
    const text = (ttData.events || [])
      .filter(e => e.segs)
      .map(e => e.segs.map(s => s.utf8 || '').join(''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);

    return text;
  } catch (_) {
    return '';
  }
}

/* ── Main handler — called from server.js ─────────────────────────────── */
async function handleYtSync(channels) {
  if (!YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY environment variable is not set. Add it in Railway dashboard.');
  }
  if (!Array.isArray(channels) || !channels.length) return { videos: [] };

  const videos = [];

  await Promise.allSettled(channels.map(async ch => {
    try {
      const raw = await getChannelVideos(ch.channelId, ch.lastVideoPublishedAt || null);
      for (const v of raw) {
        if (!v.videoId) continue;
        /* Skip if no newer than lastVideoPublishedAt */
        if (ch.lastVideoPublishedAt && v.publishedAt && v.publishedAt <= ch.lastVideoPublishedAt) continue;
        const transcript = await getTranscript(v.videoId);
        videos.push({
          videoId:     v.videoId,
          channelId:   ch.channelId,
          channelName: ch.name || ch.channelId,
          title:       v.title,
          publishedAt: v.publishedAt,
          transcript,
        });
      }
    } catch (err) {
      console.warn(`[EDGX YT] Channel ${ch.channelId}: ${err.message}`);
    }
  }));

  return { videos };
}

module.exports = { handleYtSync };
