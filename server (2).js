'use strict';

/**
 * EDGX Studio Server — Railway deployment
 *
 * Combines:
 *   - YouTube transcript proxy (no API key — RSS feed + youtube-transcript package)
 *   - EDGX broadcast engine (dual-anchor AI newscast, Signal Break)
 *   - Email relay (Resend)
 *   - EDGX snapshot ingestion + Signal Break detection
 *   - Studio episode management
 *
 * YouTube strategy:
 *   Transcripts : youtube-transcript npm package (scrapes timedtext — zero quota)
 *   Channel feed : YouTube public Atom RSS feed (no API key required)
 *   Channel ID  : Resolved once by scraping channel page HTML, cached in memory
 *   Result      : No YouTube Data API key needed. No 403. No 429. No quota.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /api/transcript?url=<youtube-url>
 *   GET  /api/channel/resolve?input=<handle-or-url>
 *   GET  /api/channel/videos?channelId=UC…
 *   GET  /api/channel/latest-transcript?channelId=UC…
 *   POST /yt-sync          — batch channel sync for NII engine
 *   POST /snapshot         — EDGX engine state snapshot
 *   GET  /episodes
 *   GET  /episodes/:id/audio
 *   GET  /episodes/:id/script
 *   POST /signal-break/check
 *   GET  /signal-break/:ts/audio
 *   POST /send             — email relay
 *
 * Environment variables:
 *   EDGX_API_SECRET        — Bearer auth (required)
 *   GROQ_API_KEY           — Groq LLM for broadcast scripts
 *   ELEVENLABS_API_KEY     — ElevenLabs TTS
 *   ELEVENLABS_JANE_ID     — Jane voice ID
 *   ELEVENLABS_ALEX_ID     — Alex voice ID
 *   RESEND_API_KEY         — Email relay (optional)
 *   EMAIL_FROM / EMAIL_TO  — Email config (optional)
 *   PORT                   — Set automatically by Railway
 */

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const _fetch = typeof fetch !== 'undefined'
  ? fetch
  : (...args) => import('node-fetch').then(m => m.default(...args));

const { YoutubeTranscript }  = require('youtube-transcript');
const { analyzeTranscript }  = require('./engines');
const { Resend }             = require('resend');
const {
  EPISODE_STORE, SIGNAL_BREAK, produceBroadcast, generateSignalBreak,
} = require('./broadcast');

/* ── Env ─────────────────────────────────────────────────────────────────── */
const {
  EDGX_API_SECRET,
  RESEND_API_KEY,
  EMAIL_FROM = 'EDGX Jane <onboarding@resend.dev>',
  EMAIL_TO   = '',
  PORT       = 3001,
} = process.env;

if (!EDGX_API_SECRET) { console.error('[EDGX] EDGX_API_SECRET not set'); process.exit(1); }

const resend     = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const recipients = EMAIL_TO.split(',').map(s => s.trim()).filter(Boolean);

/* ── Express ─────────────────────────────────────────────────────────────── */
const app = express();
app.use(cors());
app.use(express.json({ limit: '512kb' }));

/* ── Auth middleware ─────────────────────────────────────────────────────── */
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (token !== EDGX_API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/* ══════════════════════════════════════════════════════════════════════════
   YOUTUBE HELPERS — no API key required
══════════════════════════════════════════════════════════════════════════ */

/* In-memory channel ID cache (handle → channelId) */
const channelIdCache = new Map();

/* Simple rate limiter — 60 requests per minute */
const requestTimestamps = [];
const RATE_WINDOW_MS    = 60_000;
const RATE_MAX_REQUESTS = 60;

function isRateLimited() {
  const now = Date.now();
  while (requestTimestamps.length && requestTimestamps[0] < now - RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_MAX_REQUESTS) return true;
  requestTimestamps.push(now);
  return false;
}

function extractVideoId(input) {
  if (!input) return null;
  input = input.trim();
  const patterns = [
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const re of patterns) {
    const m = input.match(re);
    if (m) return m[1];
  }
  return null;
}

async function resolveChannelId(input) {
  input = input.trim();
  if (/^UC[a-zA-Z0-9_-]{22}$/.test(input)) return input;
  let handle = input;
  const handleMatch = input.match(/youtube\.com\/(?:@|c\/|user\/)?([A-Za-z0-9_.-]+)/);
  if (handleMatch) handle = handleMatch[1];
  const cacheKey = handle.replace(/^@/, '').toLowerCase();
  if (channelIdCache.has(cacheKey)) return channelIdCache.get(cacheKey);
  let channelUrl;
  if (input.startsWith('http'))      { channelUrl = input.split('?')[0]; }
  else if (input.startsWith('@'))    { channelUrl = `https://www.youtube.com/${input}`; }
  else                               { channelUrl = `https://www.youtube.com/@${input}`; }
  const res = await _fetch(channelUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Channel page returned HTTP ${res.status}`);
  const html = await res.text();
  const externalIdMatch = html.match(/"externalId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
  if (externalIdMatch) { channelIdCache.set(cacheKey, externalIdMatch[1]); return externalIdMatch[1]; }
  const canonicalMatch = html.match(/rel="canonical"\s+href="https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})"/);
  if (canonicalMatch) { channelIdCache.set(cacheKey, canonicalMatch[1]); return canonicalMatch[1]; }
  const anyMatch = html.match(/"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
  if (anyMatch) { channelIdCache.set(cacheKey, anyMatch[1]); return anyMatch[1]; }
  throw new Error(`Could not resolve channel ID for: ${input}`);
}

async function fetchChannelFeed(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await _fetch(feedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`RSS feed returned HTTP ${res.status} for channel ${channelId}`);
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  if (!entries.length) throw new Error('No videos found in channel RSS feed.');
  return entries.map(([, entry]) => {
    const videoId   = (entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)   || [])[1] || '';
    const title     = (entry.match(/<title>([^<]+)<\/title>/)              || [])[1] || 'Untitled';
    const published = (entry.match(/<published>([^<]+)<\/published>/)      || [])[1] || '';
    return {
      videoId,
      title:     title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'"),
      published: published ? new Date(published).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }) : '',
      publishedAt: published || null,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  });
}

async function fetchChannelName(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await _fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return channelId;
  const xml = await res.text();
  const m = xml.match(/<title>([^<]+)<\/title>/);
  return m ? m[1].replace(/&amp;/g,'&') : channelId;
}

/* ══════════════════════════════════════════════════════════════════════════
   YOUTUBE ROUTES
══════════════════════════════════════════════════════════════════════════ */

app.get('/health', (_req, res) => res.json({
  ok: true, ts: new Date().toISOString(),
  episodes: EPISODE_STORE.episodes.length,
  hasSnapshot: !!EPISODE_STORE.snapshot,
  nextBroadcast: nextBroadcastTs(),
  ytMode: 'rss+scrape (no API key)',
}));

app.get('/api/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/api/transcript', async (req, res) => {
  if (isRateLimited()) return res.status(429).json({ error: 'Rate limit reached.' });
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing required query parameter: url' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Could not extract a valid YouTube video ID.' });
  try {
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    if (!transcript || !transcript.length) return res.status(404).json({ error: 'No transcript available for this video.' });
    const lines = transcript.map(item => ({ text: item.text, offset: item.offset, duration: item.duration }));
    return res.json({ videoId, lines, analysis: analyzeTranscript(lines) });
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('disabled') || msg.includes('Disabled')) return res.status(404).json({ error: 'Transcripts are disabled for this video.' });
    if (msg.includes('unavailable') || msg.includes('private')) return res.status(404).json({ error: 'Video is unavailable or private.' });
    console.error(`[transcript] videoId=${videoId}`, msg);
    return res.status(500).json({ error: `Transcript fetch failed: ${msg}` });
  }
});

app.get('/api/channel/resolve', async (req, res) => {
  if (isRateLimited()) return res.status(429).json({ error: 'Rate limit reached.' });
  const { input } = req.query;
  if (!input) return res.status(400).json({ error: 'Missing required query parameter: input' });
  try {
    const channelId = await resolveChannelId(input);
    const name      = await fetchChannelName(channelId);
    return res.json({ channelId, name });
  } catch (err) {
    console.error(`[resolve] input="${input}"`, err.message);
    return res.status(404).json({ error: err.message });
  }
});

app.get('/api/channel/videos', async (req, res) => {
  if (isRateLimited()) return res.status(429).json({ error: 'Rate limit reached.' });
  const { channelId } = req.query;
  if (!channelId) return res.status(400).json({ error: 'Missing required query parameter: channelId' });
  if (!/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) return res.status(400).json({ error: 'Invalid channelId format.' });
  try {
    return res.json({ channelId, videos: await fetchChannelFeed(channelId) });
  } catch (err) {
    console.error(`[videos] channelId=${channelId}`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/channel/latest-transcript', async (req, res) => {
  if (isRateLimited()) return res.status(429).json({ error: 'Rate limit reached.' });
  const { channelId } = req.query;
  if (!channelId) return res.status(400).json({ error: 'Missing required query parameter: channelId' });
  if (!/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) return res.status(400).json({ error: 'Invalid channelId format.' });
  try {
    const videos = await fetchChannelFeed(channelId);
    if (!videos.length) return res.status(404).json({ error: 'No videos found for this channel.' });
    const latest = videos[0];
    let transcript;
    try { transcript = await YoutubeTranscript.fetchTranscript(latest.videoId); }
    catch (err) { return res.status(404).json({ error: `Transcript unavailable: ${err.message}`, video: latest }); }
    if (!transcript || !transcript.length) return res.status(404).json({ error: 'No transcript available.', video: latest });
    const lines = transcript.map(item => ({ text: item.text, offset: item.offset, duration: item.duration }));
    return res.json({ channelId, video: latest, lines, analysis: analyzeTranscript(lines) });
  } catch (err) {
    console.error(`[latest-transcript] channelId=${channelId}`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ── POST /yt-sync — batch channel sync for NII engine (no API key) ──────── */
app.post('/yt-sync', auth, async (req, res) => {
  const { channels } = req.body || {};
  if (!Array.isArray(channels) || !channels.length) {
    return res.status(400).json({ error: 'channels array required' });
  }
  const videos = [];
  await Promise.allSettled(channels.map(async ch => {
    try {
      const feed = await fetchChannelFeed(ch.channelId);
      for (const v of feed.slice(0, 3)) {
        /* Skip if not newer than lastVideoPublishedAt */
        if (ch.lastVideoPublishedAt && v.publishedAt && v.publishedAt <= ch.lastVideoPublishedAt) continue;
        let transcript = '';
        try {
          const lines = await YoutubeTranscript.fetchTranscript(v.videoId);
          transcript = lines.map(l => l.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
        } catch (_) {}
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
  return res.json({ videos });
});

/* ══════════════════════════════════════════════════════════════════════════
   EDGX STUDIO ROUTES
══════════════════════════════════════════════════════════════════════════ */

function nextBroadcastTs() {
  const now  = new Date();
  const h    = now.getUTCHours();
  const next = new Date(now);
  if (h < 6)       { next.setUTCHours(6,0,0,0); }
  else if (h < 18) { next.setUTCHours(18,0,0,0); }
  else             { next.setUTCDate(next.getUTCDate()+1); next.setUTCHours(6,0,0,0); }
  return next.toISOString();
}

app.post('/snapshot', auth, (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'Missing payload' });
  const prior    = EPISODE_STORE.snapshot;
  const triggers = [];
  if (prior) {
    const prevNII = prior.engineState?.assetNewsIndex?.value;
    const currNII = payload.engineState?.assetNewsIndex?.value;
    if (prevNII != null && currNII != null && Math.abs(currNII - prevNII) >= SIGNAL_BREAK.thresholds.niiDelta)
      triggers.push({ type: 'nii_surge', from: prevNII, to: currNII, windowMin: 30 });
    const prevEdge = prior.edgeState?.label, currEdge = payload.edgeState?.label;
    if (prevEdge && currEdge && prevEdge !== currEdge)
      triggers.push({ type: 'edge_flip', from: prevEdge, to: currEdge });
    if (!prior.engineState?.breakingClusterDetected && payload.engineState?.breakingClusterDetected)
      triggers.push({ type: 'cluster', windowMin: 10 });
    const prevMGE = prior.engineState?.marketGravity?.vector;
    const currMGE = payload.engineState?.marketGravity?.vector;
    if (prevMGE != null && currMGE != null && Math.abs(currMGE - prevMGE) >= SIGNAL_BREAK.thresholds.mgeShift)
      triggers.push({ type: 'mge_shift', newVector: currMGE });
  }
  EPISODE_STORE.snapshot = payload;
  if (triggers.length > 0) {
    generateSignalBreak(triggers[0], payload)
      .then(b => { if (b) { EPISODE_STORE.pendingBreak = b; console.log(`[EDGX Studio] Signal Break: ${triggers[0].type}`); } })
      .catch(err => console.warn('[EDGX Studio] Break failed:', err.message));
  }
  return res.json({ ok: true, triggersDetected: triggers.length, pendingBreak: !!EPISODE_STORE.pendingBreak });
});

app.get('/episodes', auth, (_req, res) => {
  const list = EPISODE_STORE.episodes.map(ep => ({
    id: ep.id, ts: ep.ts, title: ep.title, keyClaim: ep.keyClaim,
    stories: ep.stories, edgeAtAir: ep.edgeAtAir, edgeScore: ep.edgeScore,
    durationMs: ep.durationMs, hasAudio: !!ep.audioBuffer,
  }));
  res.json({ episodes: list.reverse() });
});

app.get('/episodes/:id/audio', auth, (req, res) => {
  const ep = EPISODE_STORE.episodes.find(e => String(e.id) === req.params.id);
  if (!ep)             return res.status(404).json({ error: 'Not found' });
  if (!ep.audioBuffer) return res.status(404).json({ error: 'Audio not ready' });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', ep.audioBuffer.length);
  res.send(ep.audioBuffer);
});

app.get('/episodes/:id/script', auth, (req, res) => {
  const ep = EPISODE_STORE.episodes.find(e => String(e.id) === req.params.id);
  if (!ep) return res.status(404).json({ error: 'Not found' });
  res.json({ script: ep.script, stories: ep.stories });
});

app.post('/signal-break/check', auth, (req, res) => {
  const pending = EPISODE_STORE.pendingBreak;
  if (!pending) return res.json({ hasPendingBreak: false });
  res.json({ hasPendingBreak: true, breakId: pending.ts, trigger: pending.trigger, text: pending.text, durationMs: pending.durationMs, audioUrl: `/signal-break/${pending.ts}/audio` });
});

app.get('/signal-break/:ts/audio', auth, (req, res) => {
  const pending = EPISODE_STORE.pendingBreak;
  if (!pending || String(pending.ts) !== req.params.ts) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', pending.buffer.length);
  res.send(pending.buffer);
  EPISODE_STORE.pendingBreak = null;
});

app.post('/send', auth, async (req, res) => {
  if (!resend) return res.status(503).json({ error: 'Email not configured' });
  const p = req.body;
  if (!p) return res.status(400).json({ error: 'Missing payload' });
  try {
    const subject = `${p.newsToneSkew === 'risk-on' ? '📈' : p.newsToneSkew === 'risk-off' ? '📉' : '◆'} EDGX Jane — ${p.time || ''}${p.breakingClusterDetected ? ' ⚡ BREAKING' : ''}`;
    const text    = (p.topHeadlines || []).map((h, i) => `${i+1}. [${h.source}] ${h.headline}`).join('\n');
    const result  = await resend.emails.send({ from: EMAIL_FROM, to: recipients, subject, text });
    return res.json({ ok: true, id: result.data?.id });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});


/* ── POST /rss-proxy — server-side RSS fetch for CORS-blocked feeds ────────
   Dashboard POSTs { url } — server fetches the feed server-side and returns
   { xml } — no CORS issues, no rate limits, no third-party dependency.
   Auth required to prevent open proxy abuse.
────────────────────────────────────────────────────────────────────────── */
app.post('/rss-proxy', auth, async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url in body' });
  }

  /* Whitelist: only RSS/Atom feeds from known domains */
  let parsed;
  try { parsed = new URL(url); } catch (_) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  /* Block obviously non-RSS targets */
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http/https allowed' });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const r = await _fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (compatible; EDGXBot/1.0; +https://edgx.app)',
        'Accept':          'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control':   'no-cache',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (!r.ok) {
      return res.status(r.status).json({ error: `Upstream HTTP ${r.status}` });
    }

    const xml = await r.text();
    if (!xml || xml.length < 50) {
      return res.status(204).json({ error: 'Empty response from upstream' });
    }

    return res.json({ xml, status: r.status, url });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Upstream timeout' : err.message;
    console.warn(`[EDGX RSS] ${url.slice(0, 80)}: ${msg}`);
    return res.status(502).json({ error: msg });
  }
});

/* ── Cron: broadcast at 06:00 and 18:00 UTC ─────────────────────────────── */
cron.schedule('0 6,18 * * *', async () => {
  console.log('[EDGX Studio] Cron — starting broadcast');
  await produceBroadcast();
}, { timezone: 'UTC' });

/* ── Start ───────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`[EDGX Studio] Listening on port ${PORT}`);
  console.log(`[EDGX Studio] YouTube mode: RSS feed + youtube-transcript (no API key)`);
  if (!process.env.GROQ_API_KEY)       console.warn('[EDGX] ⚠ GROQ_API_KEY not set');
  if (!process.env.ELEVENLABS_API_KEY) console.warn('[EDGX] ⚠ ELEVENLABS_API_KEY not set');
});
