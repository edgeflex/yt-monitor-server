/**
 * EDGX Studio — Broadcast Engine
 * 
 * Produces a dual-anchor 8-minute audio newscast every 12 hours.
 * 
 * Architecture:
 *   1. selectStories()     — rank NII clusters into top 3 stories
 *   2. buildScript()       — Groq writes full dual-anchor script with
 *                            Conviction Gradient calibrated to live edge score
 *   3. synthesiseAudio()   — ElevenLabs TTS for Jane + Alex, line by line
 *   4. assembleEpisode()   — interleave segments with silence into MP3
 *   5. storeEpisode()      — persist to episode store, trim to last 5
 *   6. Signal Break loop   — polls EDGX snapshot every 60s during playback
 *                            fires mid-episode insert when thresholds crossed
 *
 * Data inputs (posted by dashboard every 30 min to /snapshot):
 *   - NII article pool (top 40 scored articles)
 *   - MCM edge state  (score, label, samples)
 *   - Engine snapshot (MGE, NEXUS, PredCache, PT stats)
 *   - Episode history (last 5 episodes for anchor memory)
 *
 * Environment variables:
 *   GROQ_API_KEY          — Groq LLM (llama-3.3-70b-versatile)
 *   ELEVENLABS_API_KEY    — ElevenLabs TTS
 *   ELEVENLABS_JANE_ID    — Jane voice ID
 *   ELEVENLABS_ALEX_ID    — Alex voice ID
 *   EDGX_API_SECRET       — Bearer auth for all endpoints
 *   RESEND_API_KEY        — Email (inherited from mailer)
 *   EMAIL_FROM / EMAIL_TO — Email config
 *   PORT                  — Set by Railway
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const cron    = require('node-cron');

/* ── Config ────────────────────────────────────────────────────────────── */
const {
  GROQ_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_JANE_ID = 'EXAVITQu4vr4xnSDxMaL', /* ElevenLabs "Sarah" — replace with your voice ID */
  ELEVENLABS_ALEX_ID = 'VR6AewLTigWG4xSOukaG', /* ElevenLabs "Arnold" — replace with your voice ID */
  EDGX_API_SECRET,
} = process.env;

const GROQ_BASE  = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const EL_BASE    = 'https://api.elevenlabs.io/v1';

/* Episode store — in-memory, last 5 episodes */
const EPISODE_STORE = {
  episodes: [],   /* [{id, ts, title, stories, script, audioUrl, durationMs, edgeAtAir}] */
  snapshot: null, /* last EDGX snapshot posted by dashboard */
  MAX: 5,
};

/* Signal Break state */
const SIGNAL_BREAK = {
  lastFiredTs:   0,
  COOLDOWN_MS:   8 * 60 * 1000,  /* min 8 min between breaks */
  thresholds: {
    niiDelta:    30,   /* NII moves ±30 points in window */
    edgeFlip:    true, /* edge state changes */
    clusterFire: true, /* tier-1 cluster detected */
    mgeShift:    0.25, /* MGE gravity crosses ±0.25 */
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   STORY SELECTION
   Ranks NII article clusters into exactly 3 stories using:
   1. Breaking cluster (corroborating tier-1 coverage < 2h) → slot 1
   2. Signal-narrative divergence (news tone vs model bias conflict) → slot 2
   3. Statistical anomaly (heat spike from zero) → slot 3
   Falls back to top-NII clusters if no perfect candidates.
═══════════════════════════════════════════════════════════════════════════ */
function selectStories(snapshot) {
  const pool = (snapshot.articlePool || []).filter(a => a && a.title);
  if (!pool.length) return [];

  const now = Date.now();

  /* Cluster articles by topic using shared first-word fingerprint */
  const clusters = {};
  for (const a of pool) {
    const key = (a.title || '').toLowerCase().split(' ').slice(0, 4).join('_');
    if (!clusters[key]) clusters[key] = { articles: [], heat: 0, tier1: 0, minAge: Infinity };
    clusters[key].articles.push(a);
    clusters[key].heat    += (a.bullishScore != null ? Math.abs(a.bullishScore - 50) : 0);
    clusters[key].tier1   += (a.tier === 'tier1' ? 1 : 0);
    clusters[key].minAge   = Math.min(clusters[key].minAge, now - (a.pubTs || now));
  }

  const clusterArr = Object.values(clusters).filter(c => c.articles.length >= 1);

  /* Score each cluster */
  clusterArr.forEach(c => {
    const recency   = Math.exp(-c.minAge / (60 * 60 * 1000)); /* decay over 1h */
    const depth     = Math.min(c.articles.length / 4, 1);
    const tier1Bonus = c.tier1 >= 2 ? 1.4 : c.tier1 === 1 ? 1.15 : 1.0;
    const breakingBonus = (c.minAge < 2 * 60 * 60 * 1000 && c.tier1 >= 2) ? 1.5 : 1.0;
    c.score = c.heat * recency * depth * tier1Bonus * breakingBonus;
    c.isBreaking   = c.minAge < 2 * 60 * 60 * 1000 && c.tier1 >= 2;
    /* Signal-narrative divergence: high news heat but model leans opposite */
    const modelDir = snapshot.engineState?.modelBias?.thirtyMinDirection || 'flat';
    const newsLong = c.heat > 0 && (c.articles[0]?.bullishScore || 50) > 55;
    const newsShort = c.heat > 0 && (c.articles[0]?.bullishScore || 50) < 45;
    c.isDivergent  = (newsLong && modelDir === 'down') || (newsShort && modelDir === 'up');
    /* Anomaly: cluster appeared in last 90 min with no prior coverage */
    c.isAnomaly    = c.minAge < 90 * 60 * 1000 && c.articles.length === 1 && c.tier1 >= 1;
  });

  clusterArr.sort((a, b) => b.score - a.score);

  const selected = [];
  let breaking  = clusterArr.find(c => c.isBreaking);
  let divergent = clusterArr.find(c => c.isDivergent && c !== breaking);
  let anomaly   = clusterArr.find(c => c.isAnomaly && c !== breaking && c !== divergent);

  if (breaking)  selected.push({ ...breaking, slot: 1, type: 'breaking' });
  if (divergent) selected.push({ ...divergent, slot: 2, type: 'divergent' });
  if (anomaly)   selected.push({ ...anomaly, slot: 3, type: 'anomaly' });

  /* Fill remaining slots from top clusters */
  for (const c of clusterArr) {
    if (selected.length >= 3) break;
    if (selected.find(s => s === c)) continue;
    selected.push({ ...c, slot: selected.length + 1, type: 'top' });
  }

  return selected.slice(0, 3).map(c => ({
    slot:       c.slot,
    type:       c.type,
    headline:   c.articles[0]?.title || '',
    articles:   c.articles.slice(0, 4).map(a => ({
      title:   a.title,
      source:  a.source || 'wire',
      bull:    a.bullishScore || 50,
      age:     Math.round((now - (a.pubTs || now)) / 60000),
    })),
    heat:       Math.round(c.heat),
    tier1:      c.tier1,
    isBreaking: c.isBreaking,
    isDivergent: c.isDivergent,
    isAnomaly:  c.isAnomaly,
  }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   CONVICTION GRADIENT
   Maps MCM edge state → language register for Claude system prompt.
   Five levels — from declarative high-conviction to explicit uncertainty.
═══════════════════════════════════════════════════════════════════════════ */
function convictionGradientInstruction(edgeState) {
  const score   = edgeState?.score ?? null;
  const label   = edgeState?.label || 'warm';
  const samples = edgeState?.samples || 0;
  const acc5m   = edgeState?.acc5m ?? null;

  if (samples < 20 || label === 'warm') {
    return `CONVICTION LEVEL: WARMING (${samples}/20 samples).
The model has insufficient settlement history to assert directional confidence. Both anchors must be exploratory — describe what the data shows but never imply predictive certainty. Use language like "the data suggests", "we're watching", "it's too early to say".`;
  }

  if (label === 'active' && score >= 0.72) {
    return `CONVICTION LEVEL: HIGH (edge score ${Math.round(score*100)}%, 5m accuracy ${acc5m != null ? Math.round(acc5m*100)+'%' : 'strong'}).
The model's settlement record is unusually coherent. Both anchors may speak with appropriate directional confidence. Use declarative language: "the data is clear here", "the signal is unusually clean", "three independent layers are aligned". This is one of the cleaner reads the system has produced.`;
  }

  if (label === 'active') {
    return `CONVICTION LEVEL: MODERATE (edge score ${Math.round(score*100)}%, 5m accuracy ${acc5m != null ? Math.round(acc5m*100)+'%' : 'above baseline'}).
The model has a positive edge but not an exceptional one. Anchors should be measured — directional language is appropriate but should be qualified. Avoid superlatives. "The balance of signals favours", "the model leans", "on balance we'd read this as".`;
  }

  if (label === 'reduced') {
    return `CONVICTION LEVEL: REDUCED (edge score ${Math.round(score*100)}%).
The model's recent calibration has drifted. Both anchors must be explicitly cautious. Every directional claim needs a qualifier. Use language like "I want to be careful here", "the signal exists but the recent track record in these conditions is mixed", "we can describe what the data shows but the predictive value is unclear right now".`;
  }

  /* absent */
  return `CONVICTION LEVEL: ABSENT (edge score ${Math.round((score||0)*100)}%).
The model does not have a read worth trading on right now. This is not editorial — it is an empirical statement about recent settlement accuracy. Both anchors MUST acknowledge this explicitly at least once during the data segment. Use language like "the system doesn't have a strong view here", "recent settlements have been inconclusive", "we'd be reluctant to attach directional conviction to this read". Never overstate certainty when the edge is absent.`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCRIPT BUILDER — Groq dual-anchor script
═══════════════════════════════════════════════════════════════════════════ */
async function buildScript(stories, snapshot, episodeHistory) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');

  const edgeState  = snapshot.edgeState || {};
  const engState   = snapshot.engineState || {};
  const conviction = convictionGradientInstruction(edgeState);

  /* Prior episode summary for anchor memory */
  const priorSummary = episodeHistory.length
    ? episodeHistory.slice(-3).map((ep, i) => {
        const ago = Math.round((Date.now() - ep.ts) / 60000);
        return `Episode ${ep.id} (${ago}m ago): "${ep.title}" — edge was ${ep.edgeAtAir}. ` +
               `Key claim: ${ep.keyClaim || 'none recorded'}.`;
      }).join('\n')
    : 'No prior episodes this session.';

  /* Correction segment — check if prior claims settled against model */
  const corrections = episodeHistory
    .filter(ep => ep.keyClaimSettledAgainst)
    .slice(-1)
    .map(ep => `CORRECTION REQUIRED: In episode ${ep.id}, ${ep.keyClaimSettledAgainst}`)
    .join('\n') || '';

  const systemPrompt = `You are the scriptwriter for EDGX Studio, an institutional crypto analytics broadcast.

ANCHORS:
- JANE: Lead anchor. Narrative-driven. Weights NII sentiment, story clustering, macro tone. Opens the show, drives transitions, challenges Alex, closes. Warm but precise.
- ALEX: Co-anchor. Data-driven. Weights model settlement history, CRPS gradient, vol calibration. Takes harder analytical positions. Willing to disagree with Jane where the data warrants.

${conviction}

PUNCTUATION AND DELIVERY RULES (critical for TTS quality):
- Use ellipsis (...) for deliberate pauses mid-thought: "The funding rate moved... and the model didn't follow."
- Use em dash (—) for sharp pivots: "Three signals aligned—and then the print came in."
- End questions with genuine rising inflection markers: write them as natural spoken questions.
- Sentences should vary: short declarative punches after long analytical builds.
- Never write bullet points or lists — everything must flow as natural speech.
- No markdown, no headers, no asterisks in any line.
- Contractions are fine: "it's", "we'd", "that's", "I'd".
- Numbers: write as spoken — "forty-four percent", "two point three billion", not "44%" or "$2.3B".
- Pauses: add [PAUSE:600] for a 600ms silence, [PAUSE:1200] for a 1.2 second pause between major segment transitions.

SHOW STRUCTURE — output valid JSON exactly matching this schema:
{
  "title": "Episode title — punchy, max 8 words",
  "keyClaim": "One sentence — the main directional or analytical claim made this episode, for settlement tracking",
  "correction": "One sentence correction of prior episode, or null if none needed",
  "segments": [
    {
      "type": "cold_open|story|transition|data|close",
      "storySlot": 1|2|3|null,
      "lines": [
        { "anchor": "JANE|ALEX", "text": "...", "pause_after_ms": 400 }
      ]
    }
  ]
}

SEGMENT GUIDELINES:
- cold_open: Jane only, 2-3 lines, 25-35 seconds. Names all three stories. Sets energy.
- correction (if needed): Jane reads it. 1-2 lines. Direct. No defensiveness.
- story (x3): 6-10 lines alternating Jane/Alex. Jane introduces, Alex takes first position, genuine back-and-forth. Story 2 should have a moment of real disagreement if the data supports it. Story 3 (anomaly) — both anchors more speculative, more honest about uncertainty.
- transition: 1 line, Jane only. Bridges between stories.
- data: 8-12 lines. Alex leads with numbers, Jane interprets implications. Apply conviction gradient strictly here. Report MCM edge state explicitly.
- close: Jane only, 2 lines. Outlook posture. Sign-off. Next broadcast time.

Total spoken word count: 900-1100 words (approximately 7-8 minutes at broadcast pace).`;

  const userContent = `STORIES:
${JSON.stringify(stories, null, 2)}

ENGINE STATE:
${JSON.stringify({
  edgeScore:    edgeState.score,
  edgeLabel:    edgeState.label,
  edgeSamples:  edgeState.samples,
  acc2m:        edgeState.acc2m,
  acc5m:        edgeState.acc5m,
  acc30m:       edgeState.acc30m,
  crpsTrend:    edgeState.crpsTrend,
  pitKL:        edgeState.pitKL,
  mgeGravity:   engState.marketGravity?.vector,
  nexusPhase:   engState.nexus?.phase,
  modelBias:    engState.modelBias,
  pcd:          engState.predictiveConsensusDivergence,
  newsTone:     engState.newsToneSkew,
  activeAsset:  engState.symbol,
}, null, 2)}

PRIOR EPISODES:
${priorSummary}

${corrections ? 'CORRECTION REQUIRED:\n' + corrections : ''}

Write the complete dual-anchor script now. Return only valid JSON.`;

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      max_tokens:  3500,
      temperature: 0.52,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);

  const data  = await res.json();
  const raw   = (data.choices?.[0]?.message?.content || '').trim();
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    throw new Error(`Script JSON parse failed: ${e.message}\nRaw: ${clean.slice(0, 200)}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   AUDIO SYNTHESIS — ElevenLabs TTS
   One call per line. Returns Buffer (MP3 bytes).
   Voice settings tuned for news broadcast delivery.
═══════════════════════════════════════════════════════════════════════════ */
async function synthesiseLine(text, anchor) {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set');

  const voiceId = anchor === 'ALEX' ? ELEVENLABS_ALEX_ID : ELEVENLABS_JANE_ID;

  /* Strip delivery markers before sending to TTS */
  const cleanText = text
    .replace(/\[PAUSE:\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanText) return Buffer.alloc(0);

  const res = await fetch(`${EL_BASE}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'xi-api-key':    ELEVENLABS_API_KEY,
      'Accept':        'audio/mpeg',
    },
    body: JSON.stringify({
      text:           cleanText,
      model_id:       'eleven_turbo_v2_5',
      voice_settings: {
        stability:         anchor === 'ALEX' ? 0.72 : 0.65,  /* Alex more stable/authoritative */
        similarity_boost:  anchor === 'ALEX' ? 0.80 : 0.78,
        style:             anchor === 'ALEX' ? 0.18 : 0.22,  /* Jane slightly more expressive */
        use_speaker_boost: true,
      },
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) throw new Error(`ElevenLabs ${res.status} for ${anchor}: ${await res.text()}`);

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/* Generate silence buffer — raw PCM silence as MP3-compatible filler.
   For proper silence between segments we use a pre-encoded 1s silent MP3.
   In production replace this with a real silent MP3 file. */
function silenceBuffer(ms) {
  /* Minimal valid MP3 frame (silent) repeated. 
     Using empty buffer as placeholder — Railway ffmpeg would handle this properly.
     In pure Node without ffmpeg: concatenate empty audio and rely on player buffering. */
  return Buffer.alloc(Math.round(ms * 16)); /* ~16 bytes/ms at 128kbps approximation */
}

/* ═══════════════════════════════════════════════════════════════════════════
   EPISODE ASSEMBLY
   Synthesises all lines, inserts silences, concatenates into single buffer.
═══════════════════════════════════════════════════════════════════════════ */
async function synthesiseEpisode(script) {
  const segments = [];
  let totalMs    = 0;

  for (const segment of script.segments) {
    for (const line of segment.lines) {
      if (!line.text?.trim()) continue;

      /* Extract pause markers */
      const pauseMatch = line.text.match(/\[PAUSE:(\d+)\]/);
      const pauseMs    = pauseMatch ? parseInt(pauseMatch[1]) : (line.pause_after_ms || 300);

      try {
        const audioBuf = await synthesiseLine(line.text, line.anchor);
        if (audioBuf.length > 0) {
          segments.push({ type: 'audio', anchor: line.anchor, buf: audioBuf });
          /* Estimate duration: ~128kbps MP3 = 16KB/s */
          totalMs += (audioBuf.length / 16000) * 1000;
        }

        /* Inter-line silence */
        if (pauseMs > 0) {
          segments.push({ type: 'silence', ms: pauseMs, buf: silenceBuffer(pauseMs) });
          totalMs += pauseMs;
        }

        /* Standard gap between anchor switches: 350ms */
        const nextLine = segment.lines[segment.lines.indexOf(line) + 1];
        if (nextLine && nextLine.anchor !== line.anchor) {
          segments.push({ type: 'silence', ms: 350, buf: silenceBuffer(350) });
          totalMs += 350;
        }

      } catch (err) {
        console.warn(`[EDGX Studio] TTS error for line: ${err.message}`);
        /* Insert silence placeholder so timing roughly holds */
        segments.push({ type: 'silence', ms: 2000, buf: silenceBuffer(2000) });
        totalMs += 2000;
      }
    }

    /* Segment break: 800ms between major segments */
    segments.push({ type: 'silence', ms: 800, buf: silenceBuffer(800) });
    totalMs += 800;
  }

  const combined = Buffer.concat(segments.map(s => s.buf));
  return { buffer: combined, durationMs: Math.round(totalMs) };
}

/* ═══════════════════════════════════════════════════════════════════════════
   SIGNAL BREAK GENERATOR
   Called when a threshold is crossed during playback.
   Returns a synthesised audio buffer of Jane's insert (~15s).
═══════════════════════════════════════════════════════════════════════════ */
async function generateSignalBreak(trigger, snapshot) {
  const now = Date.now();
  if (now - SIGNAL_BREAK.lastFiredTs < SIGNAL_BREAK.COOLDOWN_MS) return null;

  SIGNAL_BREAK.lastFiredTs = now;

  const edge = snapshot.edgeState || {};
  const eng  = snapshot.engineState || {};

  /* Build the break text from trigger type */
  let breakText = 'This is a Signal Break. ';

  if (trigger.type === 'nii_surge') {
    breakText += `During this broadcast the EDGX News Intelligence Index moved from ${trigger.from} to ${trigger.to} — a ${Math.abs(trigger.to - trigger.from)}-point shift in ${trigger.windowMin} minutes. `;
  } else if (trigger.type === 'edge_flip') {
    breakText += `The model edge state has shifted to ${(edge.label || '').toUpperCase()}. `;
    if (edge.label === 'active') breakText += `Recent settlements are aligning. `;
    if (edge.label === 'absent') breakText += `Calibration has drifted — reduce sizing. `;
  } else if (trigger.type === 'cluster') {
    breakText += `A tier-one breaking cluster has formed. ${trigger.count || 'Multiple'} corroborating sources filed within the past ${trigger.windowMin || 10} minutes. `;
  } else if (trigger.type === 'mge_shift') {
    const gv = trigger.newVector;
    const word = gv > 0.15 ? 'risk-on' : gv < -0.15 ? 'risk-off' : 'balanced';
    breakText += `Market Gravity Engine has crossed its divergence threshold — now reading ${word} at ${gv.toFixed(3)}. `;
  }

  /* Conviction qualifier on the break itself */
  if (edge.label === 'active' && (edge.score || 0) >= 0.65) {
    breakText += `Edge state is active at ${Math.round((edge.score||0)*100)} percent confidence. We continue.`;
  } else if (edge.label === 'reduced') {
    breakText += `Edge state is reduced — treat this signal with appropriate caution. We continue.`;
  } else {
    breakText += `We continue.`;
  }

  try {
    const audioBuf = await synthesiseLine(breakText, 'JANE');
    return {
      text:      breakText,
      buffer:    audioBuf,
      trigger:   trigger.type,
      ts:        now,
      durationMs: Math.round((audioBuf.length / 16000) * 1000),
    };
  } catch (err) {
    console.warn('[EDGX Studio] Signal break synthesis failed:', err.message);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN BROADCAST FUNCTION
   Called by cron every 12 hours.
═══════════════════════════════════════════════════════════════════════════ */
async function produceBroadcast() {
  const snapshot = EPISODE_STORE.snapshot;
  if (!snapshot) {
    console.log('[EDGX Studio] No snapshot available — skipping broadcast');
    return null;
  }

  console.log('[EDGX Studio] Starting broadcast production...');
  const startTs = Date.now();

  try {
    /* 1. Select stories */
    const stories = selectStories(snapshot);
    if (!stories.length) {
      console.log('[EDGX Studio] No stories available — skipping');
      return null;
    }
    console.log(`[EDGX Studio] Selected ${stories.length} stories:`, stories.map(s => s.headline.slice(0, 50)));

    /* 2. Build script */
    console.log('[EDGX Studio] Generating script...');
    const script = await buildScript(stories, snapshot, EPISODE_STORE.episodes);

    /* 3. Synthesise audio */
    console.log('[EDGX Studio] Synthesising audio...');
    const { buffer, durationMs } = await synthesiseEpisode(script);

    /* 4. Store episode */
    const episodeId = EPISODE_STORE.episodes.length + 1;
    const episode = {
      id:           episodeId,
      ts:           Date.now(),
      title:        script.title || `Episode ${episodeId}`,
      keyClaim:     script.keyClaim || null,
      stories:      stories.map(s => ({ slot: s.slot, type: s.type, headline: s.headline })),
      edgeAtAir:    snapshot.edgeState?.label || 'unknown',
      edgeScore:    snapshot.edgeState?.score || null,
      durationMs,
      audioBuffer:  buffer,  /* stored in memory — in production write to disk/S3 */
      script,
    };

    EPISODE_STORE.episodes.push(episode);
    if (EPISODE_STORE.episodes.length > EPISODE_STORE.MAX) {
      EPISODE_STORE.episodes.shift();
    }

    const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
    console.log(`[EDGX Studio] Episode ${episodeId} produced in ${elapsed}s — ${Math.round(durationMs/1000)}s audio, ${buffer.length} bytes`);
    return episode;

  } catch (err) {
    console.error('[EDGX Studio] Broadcast production failed:', err.message);
    return null;
  }
}

module.exports = {
  EPISODE_STORE,
  SIGNAL_BREAK,
  produceBroadcast,
  generateSignalBreak,
  selectStories,
  buildScript,
  synthesiseEpisode,
  convictionGradientInstruction,
};
