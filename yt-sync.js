'use strict';

const { YOUTUBE_API_KEY } = process.env;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

const _fetch = typeof fetch !== 'undefined'
  ? fetch
  : (...args) => import('node-fetch').then(m => m.default(...args));

async function getChannelVideos(channelId, publishedAfter) {
  if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY not set');
  const params = new URLSearchParams({
    part: 'snippet', channelId, order: 'date', type: 'video',
    maxResults: '5', key: YOUTUBE_API_KEY,
  });
  if (publishedAfter) params.set('publishedAfter', publishedAfter);
  const res = await _fetch(`${YT_BASE}/search?${params}`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`YT search HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(item => ({
    videoId: item.id?.videoId,
    title: item.snippet?.title || '',
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
  const videos = [];
  await Promise.allSettled(channels.map(async ch => {
    try {
      const raw = await getChannelVideos(ch.channelId, ch.lastVideoPublishedAt || null);
      for (const v of raw) {
        if (!v.videoId) continue;
        if (ch.lastVideoPublishedAt && v.publishedAt && v.publishedAt <= ch.lastVideoPublishedAt) continue;
        const transcript = await getTranscript(v.videoId);
        videos.push({
          videoId: v.videoId, channelId: ch.channelId,
          channelName: ch.name || ch.channelId,
          title: v.title, publishedAt: v.publishedAt, transcript,
        });
      }
    } catch (err) { console.warn(`[EDGX YT] ${ch.channelId}: ${err.message}`); }
  }));
  return { videos };
}

module.exports = { handleYtSync };
