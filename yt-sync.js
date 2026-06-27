'use strict';

const { YOUTUBE_API_KEY } = process.env;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

const _fetch = typeof fetch !== 'undefined'
  ? fetch
  : (...args) => import('node-fetch').then(m => m.default(...args));

/* ── Quota-aware rate limiter ─────────────────────────────────────────────
   YouTube Data API v3 free quota: 10,000 units/day
   Each search call costs 100 units.
   Safe budget: 8,000 units/day = 80 search calls/day = ~3 calls/hour max.
   With 34 channels: poll each channel at most once every ~12 hours.
   The dashboard sends batches of 8 channels per POST (NII_YT_BATCH=8).
   We allow max 3 batch calls per hour = 24 search calls/hour = 240 units/hour.
   Daily: 240 × 24 = 5,760 units — safely within free quota.
────────────────────────────────────────────────────────────────────────── */
const QUOTA = {
  callsThisHour: 0,
  hourStart:     Date.now(),
  MAX_PER_HOUR:  3,   /* max batch POST calls per hour */
  lastCallTs:    {},  /* channelId → last fetch timestamp */
  MIN_INTERVAL:  6 * 60 * 60 * 1000, /* min 6h between fetches per channel */
};

function quotaCheck() {
  const now = Date.now();
  if (now - QUOTA.hourStart > 60 * 60 * 1000) {
    QUOTA.callsThisHour = 0;
    QUOTA.hourStart = now;
  }
  if (QUOTA.callsThisHour >= QUOTA.MAX_PER_HOUR) {
    const waitMs = 60 * 60 * 1000 - (now - QUOTA.hourStart);
    throw new Error(`Quota limit reached. Reset in ${Math.ceil(waitMs/60000)} minutes.`);
  }
  QUOTA.callsThisHour++;
}

async function getChannelVideos(channelId, publishedAfter) {
  if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY not set');

  const params = new URLSearchParams({
    part:       'snippet',
    channelId,
    order:      'date',
    type:       'video',
    maxResults: '3',  /* reduced from 5 to save quota */
    key:        YOUTUBE_API_KEY,
  });
  if (publishedAfter) params.set('publishedAfter', publishedAfter);

  const res = await _fetch(`${YT_BASE}/search?${params}`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`YT search HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(item => ({
    videoId:     item.id?.videoId,
    title:       item.snippet?.title || '',
    publishedAt: item.snippet?.publishedAt || null,
    channelId,
  }));
}

async function getTranscript(videoId) {
  try {
    const params = new URLSearchParams({ part: 'snippet', videoId, key: YOUTUBE_API_KEY });
    const res = await _fetch(`${YT_BASE}/captions?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return '';
    const data = await res.json();
    const tracks = data.items || [];
    const track = tracks.find(t => t.snippet?.trackKind === 'asr' && t.snippet?.language?.startsWith('en'))
      || tracks.find(t => t.snippet?.trackKind === 'asr')
      || tracks.find(t => t.snippet?.language?.startsWith('en'))
      || tracks[0];
    if (!track?.id) return '';
    const ttUrl = `https://www.youtube.com/api/timedtext?lang=${track.snippet?.language || 'en'}&v=${videoId}&fmt=json3`;
    const ttRes = await _fetch(ttUrl, { signal: AbortSignal.timeout(10000) });
    if (!ttRes.ok) return '';
    const ttData = await ttRes.json();
    return (ttData.events || [])
      .filter(e => e.segs)
      .map(e => e.segs.map(s => s.utf8 || '').join(''))
      .join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
  } catch (_) { return ''; }
}

async function handleYtSync(channels) {
  if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY not set in Railway Variables');
  if (!Array.isArray(channels) || !channels.length) return { videos: [] };

  /* Quota gate */
  try { quotaCheck(); } catch (err) {
    console.warn(`[EDGX YT] ${err.message}`);
    return { videos: [], quotaLimited: true };
  }

  const now = Date.now();
  const videos = [];

  /* Filter out channels fetched recently */
  const eligible = channels.filter(ch => {
    const last = QUOTA.lastCallTs[ch.channelId] || 0;
    return now - last >= QUOTA.MIN_INTERVAL;
  });

  if (!eligible.length) {
    return { videos: [], skipped: true, reason: 'All channels fetched recently' };
  }

  await Promise.allSettled(eligible.map(async ch => {
    try {
      QUOTA.lastCallTs[ch.channelId] = now;
      const raw = await getChannelVideos(ch.channelId, ch.lastVideoPublishedAt || null);
      for (const v of raw) {
        if (!v.videoId) continue;
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
    } catch (err) { console.warn(`[EDGX YT] ${ch.channelId}: ${err.message}`); }
  }));

  return { videos };
}

module.exports = { handleYtSync };
