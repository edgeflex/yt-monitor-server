/**
 * EDGX Studio Server — Railway deployment
 * Combines email relay (from edgx-mailer) + broadcast engine.
 *
 * Endpoints:
 *   GET  /health              — health check
 *   POST /send                — email brief relay (from mailer)
 *   POST /snapshot            — EDGX dashboard posts engine state every 30 min
 *   GET  /episodes            — list last 5 episode metadata
 *   GET  /episodes/:id/audio  — stream episode MP3
 *   GET  /episodes/:id/script — episode script JSON
 *   POST /signal-break/check  — dashboard polls; server checks thresholds
 *   GET  /episodes/latest/break/:triggerId — fetch pre-generated signal break audio
 *
 * Environment variables:
 *   GROQ_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_JANE_ID, ELEVENLABS_ALEX_ID
 *   RESEND_API_KEY, EDGX_API_SECRET, EMAIL_FROM, EMAIL_TO, PORT
 */

'use strict';

const express   = require('express');
const cron      = require('node-cron');
const { Resend } = require('resend');

const { handleYtSync } = require('./yt-sync');

const {
  EPISODE_STORE,
  SIGNAL_BREAK,
  produceBroadcast,
  generateSignalBreak,
} = require('./broadcast');

/* Inline the email builder from original mailer */
const {
  RESEND_API_KEY,
  EDGX_API_SECRET,
  EMAIL_FROM = 'EDGX Jane <onboarding@resend.dev>',
  EMAIL_TO   = '',
  PORT       = 3001,
} = process.env;

if (!EDGX_API_SECRET) { console.error('[EDGX] EDGX_API_SECRET not set'); process.exit(1); }

const resend     = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const recipients = EMAIL_TO.split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.use(express.json({ limit: '512kb' }));

/* ── Auth ── */
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (token !== EDGX_API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/* ── Health ── */
app.get('/health', (_req, res) => res.json({
  ok: true, ts: new Date().toISOString(),
  episodes: EPISODE_STORE.episodes.length,
  hasSnapshot: !!EPISODE_STORE.snapshot,
  nextBroadcast: _nextBroadcastTs(),
  ytApiConfigured: !!process.env.YOUTUBE_API_KEY,
}));

/* ── POST /yt-sync — YouTube channel transcript proxy ── */
app.post('/yt-sync', auth, async (req, res) => {
  const { channels } = req.body || {};
  if (!Array.isArray(channels) || !channels.length) {
    return res.status(400).json({ error: 'channels array required' });
  }
  try {
    const result = await handleYtSync(channels);
    return res.json(result);
  } catch (err) {
    console.error('[EDGX YT] /yt-sync error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

function _nextBroadcastTs() {
  const now = new Date();
  const h   = now.getUTCHours();
  const next = new Date(now);
  if (h < 6)       { next.setUTCHours(6,0,0,0); }
  else if (h < 18) { next.setUTCHours(18,0,0,0); }
  else             { next.setUTCDate(next.getUTCDate()+1); next.setUTCHours(6,0,0,0); }
  return next.toISOString();
}

/* ── POST /snapshot — dashboard posts engine state ── */
app.post('/snapshot', auth, (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Missing payload' });
  }

  /* Check Signal Break thresholds against prior snapshot */
  const prior = EPISODE_STORE.snapshot;
  const triggers = [];

  if (prior) {
    /* NII delta */
    const prevNII = prior.engineState?.assetNewsIndex?.value;
    const currNII = payload.engineState?.assetNewsIndex?.value;
    if (prevNII != null && currNII != null) {
      const delta = currNII - prevNII;
      if (Math.abs(delta) >= SIGNAL_BREAK.thresholds.niiDelta) {
        triggers.push({ type: 'nii_surge', from: prevNII, to: currNII, windowMin: 30, delta });
      }
    }

    /* Edge flip */
    const prevEdge = prior.edgeState?.label;
    const currEdge = payload.edgeState?.label;
    if (prevEdge && currEdge && prevEdge !== currEdge && SIGNAL_BREAK.thresholds.edgeFlip) {
      triggers.push({ type: 'edge_flip', from: prevEdge, to: currEdge });
    }

    /* Cluster */
    const prevCluster = prior.engineState?.breakingClusterDetected;
    const currCluster = payload.engineState?.breakingClusterDetected;
    if (!prevCluster && currCluster && SIGNAL_BREAK.thresholds.clusterFire) {
      triggers.push({ type: 'cluster', count: 3, windowMin: 10 });
    }

    /* MGE shift */
    const prevMGE = prior.engineState?.marketGravity?.vector;
    const currMGE = payload.engineState?.marketGravity?.vector;
    if (prevMGE != null && currMGE != null) {
      if (Math.abs(currMGE - prevMGE) >= SIGNAL_BREAK.thresholds.mgeShift) {
        triggers.push({ type: 'mge_shift', from: prevMGE, to: currMGE, newVector: currMGE });
      }
    }
  }

  EPISODE_STORE.snapshot = payload;

  /* Fire signal break generation if triggered (async, non-blocking) */
  if (triggers.length > 0) {
    const trigger = triggers[0]; /* Primary trigger */
    generateSignalBreak(trigger, payload).then(breakResult => {
      if (breakResult) {
        EPISODE_STORE.pendingBreak = breakResult;
        console.log(`[EDGX Studio] Signal Break generated: ${trigger.type}`);
      }
    }).catch(err => console.warn('[EDGX Studio] Signal break generation failed:', err.message));
  }

  return res.json({
    ok: true,
    triggersDetected: triggers.length,
    triggers: triggers.map(t => t.type),
    pendingBreak: !!EPISODE_STORE.pendingBreak,
  });
});

/* ── GET /episodes — list episodes ── */
app.get('/episodes', auth, (_req, res) => {
  const list = EPISODE_STORE.episodes.map(ep => ({
    id:        ep.id,
    ts:        ep.ts,
    title:     ep.title,
    keyClaim:  ep.keyClaim,
    stories:   ep.stories,
    edgeAtAir: ep.edgeAtAir,
    edgeScore: ep.edgeScore,
    durationMs: ep.durationMs,
    hasAudio:  !!ep.audioBuffer,
  }));
  res.json({ episodes: list.reverse() }); /* newest first */
});

/* ── GET /episodes/:id/audio — stream MP3 ── */
app.get('/episodes/:id/audio', auth, (req, res) => {
  const ep = EPISODE_STORE.episodes.find(e => String(e.id) === req.params.id);
  if (!ep) return res.status(404).json({ error: 'Episode not found' });
  if (!ep.audioBuffer) return res.status(404).json({ error: 'Audio not ready' });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', ep.audioBuffer.length);
  res.setHeader('Content-Disposition', `inline; filename="edgx-ep${ep.id}.mp3"`);
  res.send(ep.audioBuffer);
});

/* ── GET /episodes/:id/script — return script JSON ── */
app.get('/episodes/:id/script', auth, (req, res) => {
  const ep = EPISODE_STORE.episodes.find(e => String(e.id) === req.params.id);
  if (!ep) return res.status(404).json({ error: 'Episode not found' });
  res.json({ script: ep.script, stories: ep.stories });
});

/* ── POST /signal-break/check — dashboard polls this ── */
app.post('/signal-break/check', auth, (req, res) => {
  const pending = EPISODE_STORE.pendingBreak;
  if (!pending) return res.json({ hasPendingBreak: false });

  /* Return metadata; audio fetched separately */
  res.json({
    hasPendingBreak: true,
    breakId:         pending.ts,
    trigger:         pending.trigger,
    text:            pending.text,
    durationMs:      pending.durationMs,
    audioUrl:        `/signal-break/${pending.ts}/audio`,
  });
});

/* ── GET /signal-break/:ts/audio — serve break audio ── */
app.get('/signal-break/:ts/audio', auth, (req, res) => {
  const pending = EPISODE_STORE.pendingBreak;
  if (!pending || String(pending.ts) !== req.params.ts) {
    return res.status(404).json({ error: 'Break not found or expired' });
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', pending.buffer.length);
  res.send(pending.buffer);
  /* Clear after serving */
  EPISODE_STORE.pendingBreak = null;
});

/* ── POST /send — email relay (from original mailer) ── */
app.post('/send', auth, async (req, res) => {
  if (!resend) return res.status(503).json({ error: 'Email not configured' });
  const payload = req.body;
  if (!payload) return res.status(400).json({ error: 'Missing payload' });
  try {
    const subject = buildEmailSubject(payload);
    const text    = buildEmailText(payload);
    const result  = await resend.emails.send({ from: EMAIL_FROM, to: recipients, subject, text });
    return res.json({ ok: true, id: result.data?.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

function buildEmailSubject(p) {
  const time  = p.time || new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const sym   = (p.symbol || 'EDGX').replace('USDT', '');
  const skew  = p.newsToneSkew === 'risk-on' ? '📈' : p.newsToneSkew === 'risk-off' ? '📉' : '◆';
  return `${skew} EDGX Jane — ${time} · ${sym}${p.breakingClusterDetected ? ' ⚡ BREAKING' : ''}`;
}

function buildEmailText(p) {
  const lines = [`EDGX JANE — ${p.time || '—'}`, '='.repeat(50)];
  (p.topHeadlines || []).forEach((h, i) => lines.push(`${i+1}. [${h.source}] ${h.headline}`));
  return lines.join('\n');
}

/* ── Cron: produce broadcast at 06:00 and 18:00 UTC ── */
cron.schedule('0 6,18 * * *', async () => {
  console.log('[EDGX Studio] Cron fired — starting broadcast production');
  await produceBroadcast();
}, { timezone: 'UTC' });

/* ── Start ── */
app.listen(PORT, () => {
  console.log(`[EDGX Studio] Server listening on port ${PORT}`);
  console.log(`[EDGX Studio] Broadcasts scheduled at 06:00 and 18:00 UTC`);
  if (!process.env.GROQ_API_KEY)        console.warn('[EDGX Studio] ⚠ GROQ_API_KEY not set');
  if (!process.env.ELEVENLABS_API_KEY)  console.warn('[EDGX Studio] ⚠ ELEVENLABS_API_KEY not set');
});
