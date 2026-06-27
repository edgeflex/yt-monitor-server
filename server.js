'use strict';

const express    = require('express');
const cron       = require('node-cron');
const { Resend } = require('resend');
const { handleYtSync }   = require('./yt-sync');
const { EPISODE_STORE, SIGNAL_BREAK, produceBroadcast, generateSignalBreak } = require('./broadcast');

const {
  RESEND_API_KEY, EDGX_API_SECRET,
  EMAIL_FROM = 'EDGX Jane <onboarding@resend.dev>',
  EMAIL_TO   = '',
  PORT       = 3001,
} = process.env;

if (!EDGX_API_SECRET) { console.error('[EDGX] EDGX_API_SECRET not set'); process.exit(1); }

const resend     = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const recipients = EMAIL_TO.split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.use(express.json({ limit: '512kb' }));

/* ── CORS — allow browser dashboard to call Railway directly ── */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (token !== EDGX_API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function nextBroadcastTs() {
  const now = new Date();
  const h = now.getUTCHours();
  const next = new Date(now);
  if (h < 6) { next.setUTCHours(6,0,0,0); }
  else if (h < 18) { next.setUTCHours(18,0,0,0); }
  else { next.setUTCDate(next.getUTCDate()+1); next.setUTCHours(6,0,0,0); }
  return next.toISOString();
}

app.get('/health', (_req, res) => res.json({
  ok: true, ts: new Date().toISOString(),
  episodes: EPISODE_STORE.episodes.length,
  hasSnapshot: !!EPISODE_STORE.snapshot,
  nextBroadcast: nextBroadcastTs(),
  ytApiConfigured: !!process.env.YOUTUBE_API_KEY,
}));

app.post('/yt-sync', auth, async (req, res) => {
  const { channels } = req.body || {};
  if (!Array.isArray(channels) || !channels.length) return res.status(400).json({ error: 'channels array required' });
  try { return res.json(await handleYtSync(channels)); }
  catch (err) { console.error('[EDGX YT]', err.message); return res.status(500).json({ error: err.message }); }
});

app.post('/snapshot', auth, (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'Missing payload' });
  const prior = EPISODE_STORE.snapshot;
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
    generateSignalBreak(triggers[0], payload).then(b => {
      if (b) { EPISODE_STORE.pendingBreak = b; console.log(`[EDGX Studio] Signal Break: ${triggers[0].type}`); }
    }).catch(err => console.warn('[EDGX Studio] Break failed:', err.message));
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
  if (!ep) return res.status(404).json({ error: 'Not found' });
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
    const text = (p.topHeadlines || []).map((h, i) => `${i+1}. [${h.source}] ${h.headline}`).join('\n');
    const result = await resend.emails.send({ from: EMAIL_FROM, to: recipients, subject, text });
    return res.json({ ok: true, id: result.data?.id });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

cron.schedule('0 6,18 * * *', async () => {
  console.log('[EDGX Studio] Cron — starting broadcast');
  await produceBroadcast();
}, { timezone: 'UTC' });

app.listen(PORT, () => {
  console.log(`[EDGX Studio] Listening on port ${PORT}`);
  if (!process.env.GROQ_API_KEY)       console.warn('[EDGX] ⚠ GROQ_API_KEY not set');
  if (!process.env.ELEVENLABS_API_KEY) console.warn('[EDGX] ⚠ ELEVENLABS_API_KEY not set');
  if (!process.env.YOUTUBE_API_KEY)    console.warn('[EDGX] ⚠ YOUTUBE_API_KEY not set');
});
