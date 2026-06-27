'use strict';

const _fetch = typeof fetch !== 'undefined'
  ? fetch
  : (...args) => import('node-fetch').then(m => m.default(...args));

const {
  GROQ_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_JANE_ID = 'EXAVITQu4vr4xnSDxMaL',
  ELEVENLABS_ALEX_ID = 'VR6AewLTigWG4xSOukaG',
} = process.env;

const GROQ_BASE  = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const EL_BASE    = 'https://api.elevenlabs.io/v1';

const EPISODE_STORE = {
  episodes: [],
  snapshot: null,
  pendingBreak: null,
  MAX: 5,
};

const SIGNAL_BREAK = {
  lastFiredTs: 0,
  COOLDOWN_MS: 8 * 60 * 1000,
  thresholds: { niiDelta: 30, edgeFlip: true, clusterFire: true, mgeShift: 0.25 },
};

function selectStories(snapshot) {
  const pool = (snapshot.articlePool || []).filter(a => a && a.title);
  if (!pool.length) return [];
  const now = Date.now();
  const tierW = { tier1: 1.0, tier2: 0.8, tier3: 0.6, tier4: 0.45 };
  const clusters = {};
  for (const a of pool) {
    const key = (a.title || '').toLowerCase().split(' ').slice(0, 4).join('_');
    if (!clusters[key]) clusters[key] = { articles: [], heat: 0, tier1: 0, minAge: Infinity };
    clusters[key].articles.push(a);
    clusters[key].heat += (a.bullishScore != null ? Math.abs(a.bullishScore - 50) : 0);
    clusters[key].tier1 += (a.tier === 'tier1' ? 1 : 0);
    clusters[key].minAge = Math.min(clusters[key].minAge, now - (a.pubTs || now));
  }
  const clusterArr = Object.values(clusters).filter(c => c.articles.length >= 1);
  clusterArr.forEach(c => {
    const recency = Math.exp(-c.minAge / (60 * 60 * 1000));
    const depth = Math.min(c.articles.length / 4, 1);
    const tier1Bonus = c.tier1 >= 2 ? 1.4 : c.tier1 === 1 ? 1.15 : 1.0;
    const breakingBonus = (c.minAge < 2 * 60 * 60 * 1000 && c.tier1 >= 2) ? 1.5 : 1.0;
    c.score = c.heat * recency * depth * tier1Bonus * breakingBonus;
    c.isBreaking = c.minAge < 2 * 60 * 60 * 1000 && c.tier1 >= 2;
    const modelDir = snapshot.engineState?.modelBias?.thirtyMinDirection || 'flat';
    const newsLong = c.heat > 0 && (c.articles[0]?.bullishScore || 50) > 55;
    const newsShort = c.heat > 0 && (c.articles[0]?.bullishScore || 50) < 45;
    c.isDivergent = (newsLong && modelDir === 'down') || (newsShort && modelDir === 'up');
    c.isAnomaly = c.minAge < 90 * 60 * 1000 && c.articles.length === 1 && c.tier1 >= 1;
  });
  clusterArr.sort((a, b) => b.score - a.score);
  const selected = [];
  const breaking  = clusterArr.find(c => c.isBreaking);
  const divergent = clusterArr.find(c => c.isDivergent && c !== breaking);
  const anomaly   = clusterArr.find(c => c.isAnomaly && c !== breaking && c !== divergent);
  if (breaking)  selected.push({ ...breaking,  slot: 1, type: 'breaking' });
  if (divergent) selected.push({ ...divergent, slot: 2, type: 'divergent' });
  if (anomaly)   selected.push({ ...anomaly,   slot: 3, type: 'anomaly' });
  for (const c of clusterArr) {
    if (selected.length >= 3) break;
    if (selected.find(s => s === c)) continue;
    selected.push({ ...c, slot: selected.length + 1, type: 'top' });
  }
  return selected.slice(0, 3).map(c => ({
    slot: c.slot, type: c.type,
    headline: c.articles[0]?.title || '',
    articles: c.articles.slice(0, 4).map(a => ({
      title: a.title, source: a.source || 'wire',
      bull: a.bullishScore || 50,
      age: Math.round((now - (a.pubTs || now)) / 60000),
    })),
    heat: Math.round(c.heat), tier1: c.tier1,
    isBreaking: c.isBreaking, isDivergent: c.isDivergent, isAnomaly: c.isAnomaly,
  }));
}

function convictionGradientInstruction(edgeState) {
  const score   = edgeState?.score ?? null;
  const label   = edgeState?.label || 'warm';
  const samples = edgeState?.samples || 0;
  const acc5m   = edgeState?.acc5m ?? null;
  if (samples < 20 || label === 'warm') {
    return `CONVICTION LEVEL: WARMING (${samples}/20 samples). Both anchors must be exploratory. Use language like "the data suggests", "we're watching", "it's too early to say".`;
  }
  if (label === 'active' && score >= 0.72) {
    return `CONVICTION LEVEL: HIGH (edge score ${Math.round(score*100)}%, 5m accuracy ${acc5m != null ? Math.round(acc5m*100)+'%' : 'strong'}). Both anchors may speak with directional confidence. Use declarative language: "the data is clear here", "the signal is unusually clean".`;
  }
  if (label === 'active') {
    return `CONVICTION LEVEL: MODERATE (edge score ${Math.round(score*100)}%). Directional language is appropriate but qualified. "The balance of signals favours", "the model leans", "on balance we'd read this as".`;
  }
  if (label === 'reduced') {
    return `CONVICTION LEVEL: REDUCED (edge score ${Math.round(score*100)}%). Both anchors must be explicitly cautious. "I want to be careful here", "the signal exists but the recent track record is mixed".`;
  }
  return `CONVICTION LEVEL: ABSENT (edge score ${Math.round((score||0)*100)}%). Both anchors MUST acknowledge this. "The system doesn't have a strong view here", "recent settlements have been inconclusive".`;
}

async function buildScript(stories, snapshot, episodeHistory) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  const edgeState  = snapshot.edgeState || {};
  const engState   = snapshot.engineState || {};
  const conviction = convictionGradientInstruction(edgeState);
  const priorSummary = episodeHistory.length
    ? episodeHistory.slice(-3).map(ep => `Episode ${ep.id} (edge: ${ep.edgeAtAir}): "${ep.title}". Key claim: ${ep.keyClaim || 'none'}.`).join('\n')
    : 'No prior episodes.';

  const systemPrompt = `You are the scriptwriter for EDGX Studio, an institutional crypto analytics broadcast.

ANCHORS:
- JANE: Lead anchor. Narrative-driven. Weights NII sentiment, story clustering, macro tone. Opens the show, drives transitions, challenges Alex, closes.
- ALEX: Co-anchor. Data-driven. Weights model settlement history, CRPS gradient, vol calibration. Takes harder analytical positions. Willing to disagree.

${conviction}

PUNCTUATION AND DELIVERY RULES:
- Use ellipsis (...) for deliberate pauses mid-thought.
- Use em dash (—) for sharp pivots.
- Vary sentence length: short punchy lines after long analytical builds.
- No markdown, bullets, asterisks, or headers in any line.
- Contractions are fine. Numbers written as spoken: "forty-four percent".
- Add [PAUSE:600] for 600ms silence between major transitions.

OUTPUT: Valid JSON only, matching this exact schema:
{
  "title": "Episode title, max 8 words",
  "keyClaim": "One sentence — main directional claim for settlement tracking",
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

STRUCTURE: cold_open (Jane, 30s) → story 1 (2 min) → transition → story 2 (2 min) → transition → story 3 (2 min) → data segment (Alex leads, 90s) → close (Jane, 15s).
Total: 900-1100 words spoken.`;

  const userContent = `STORIES:\n${JSON.stringify(stories, null, 2)}\n\nENGINE STATE:\n${JSON.stringify({
    edgeScore: edgeState.score, edgeLabel: edgeState.label, edgeSamples: edgeState.samples,
    acc5m: edgeState.acc5m, crpsTrend: edgeState.crpsTrend,
    mgeGravity: engState.marketGravity?.vector, nexusPhase: engState.nexus?.phase,
    modelBias: engState.modelBias, newsTone: engState.newsToneSkew, activeAsset: engState.symbol,
  }, null, 2)}\n\nPRIOR EPISODES:\n${priorSummary}\n\nWrite the complete dual-anchor script now. Return only valid JSON.`;

  const res = await _fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, max_tokens: 3500, temperature: 0.52,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }] }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = (data.choices?.[0]?.message?.content || '').trim();
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(clean); } catch (e) { throw new Error(`Script JSON parse failed: ${e.message}`); }
}

async function synthesiseLine(text, anchor) {
  if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY not set');
  const voiceId = anchor === 'ALEX' ? ELEVENLABS_ALEX_ID : ELEVENLABS_JANE_ID;
  const cleanText = text.replace(/\[PAUSE:\d+\]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleanText) return Buffer.alloc(0);
  const res = await _fetch(`${EL_BASE}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY, 'Accept': 'audio/mpeg' },
    body: JSON.stringify({
      text: cleanText, model_id: 'eleven_turbo_v2_5',
      voice_settings: {
        stability: anchor === 'ALEX' ? 0.72 : 0.65,
        similarity_boost: anchor === 'ALEX' ? 0.80 : 0.78,
        style: anchor === 'ALEX' ? 0.18 : 0.22,
        use_speaker_boost: true,
      },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function silenceBuffer(ms) { return Buffer.alloc(Math.round(ms * 16)); }

async function synthesiseEpisode(script) {
  const segments = [];
  let totalMs = 0;
  for (const segment of script.segments) {
    for (let idx = 0; idx < segment.lines.length; idx++) {
      const line = segment.lines[idx];
      if (!line.text?.trim()) continue;
      const pauseMatch = line.text.match(/\[PAUSE:(\d+)\]/);
      const pauseMs = pauseMatch ? parseInt(pauseMatch[1]) : (line.pause_after_ms || 300);
      try {
        const audioBuf = await synthesiseLine(line.text, line.anchor);
        if (audioBuf.length > 0) { segments.push({ buf: audioBuf }); totalMs += (audioBuf.length / 16000) * 1000; }
        if (pauseMs > 0) { segments.push({ buf: silenceBuffer(pauseMs) }); totalMs += pauseMs; }
        const nextLine = segment.lines[idx + 1];
        if (nextLine && nextLine.anchor !== line.anchor) { segments.push({ buf: silenceBuffer(350) }); totalMs += 350; }
      } catch (err) {
        console.warn(`[EDGX Studio] TTS error: ${err.message}`);
        segments.push({ buf: silenceBuffer(2000) }); totalMs += 2000;
      }
    }
    segments.push({ buf: silenceBuffer(800) }); totalMs += 800;
  }
  return { buffer: Buffer.concat(segments.map(s => s.buf)), durationMs: Math.round(totalMs) };
}

async function generateSignalBreak(trigger, snapshot) {
  const now = Date.now();
  if (now - SIGNAL_BREAK.lastFiredTs < SIGNAL_BREAK.COOLDOWN_MS) return null;
  SIGNAL_BREAK.lastFiredTs = now;
  const edge = snapshot.edgeState || {};
  let breakText = 'This is a Signal Break. ';
  if (trigger.type === 'nii_surge') breakText += `The EDGX News Intelligence Index moved from ${trigger.from} to ${trigger.to} — a ${Math.abs(trigger.to - trigger.from)}-point shift in ${trigger.windowMin} minutes. `;
  else if (trigger.type === 'edge_flip') breakText += `The model edge state has shifted to ${(edge.label || '').toUpperCase()}. ${edge.label === 'absent' ? 'Calibration has drifted — reduce sizing. ' : ''}`;
  else if (trigger.type === 'cluster') breakText += `A tier-one breaking cluster has formed. Multiple corroborating sources filed in the past ${trigger.windowMin || 10} minutes. `;
  else if (trigger.type === 'mge_shift') { const gv = trigger.newVector; breakText += `Market Gravity Engine now reading ${gv > 0.15 ? 'risk-on' : gv < -0.15 ? 'risk-off' : 'balanced'} at ${gv.toFixed(3)}. `; }
  if (edge.label === 'active' && (edge.score || 0) >= 0.65) breakText += `Edge state is active at ${Math.round((edge.score||0)*100)} percent confidence. We continue.`;
  else if (edge.label === 'reduced') breakText += `Edge state is reduced — treat this signal with caution. We continue.`;
  else breakText += `We continue.`;
  try {
    const audioBuf = await synthesiseLine(breakText, 'JANE');
    return { text: breakText, buffer: audioBuf, trigger: trigger.type, ts: now, durationMs: Math.round((audioBuf.length / 16000) * 1000) };
  } catch (err) { console.warn('[EDGX Studio] Signal break synthesis failed:', err.message); return null; }
}

async function produceBroadcast() {
  const snapshot = EPISODE_STORE.snapshot;
  if (!snapshot) { console.log('[EDGX Studio] No snapshot — skipping'); return null; }
  console.log('[EDGX Studio] Starting broadcast production...');
  const startTs = Date.now();
  try {
    const stories = selectStories(snapshot);
    if (!stories.length) { console.log('[EDGX Studio] No stories — skipping'); return null; }
    const script = await buildScript(stories, snapshot, EPISODE_STORE.episodes);
    const { buffer, durationMs } = await synthesiseEpisode(script);
    const episodeId = EPISODE_STORE.episodes.length + 1;
    const episode = {
      id: episodeId, ts: Date.now(), title: script.title || `Episode ${episodeId}`,
      keyClaim: script.keyClaim || null,
      stories: stories.map(s => ({ slot: s.slot, type: s.type, headline: s.headline })),
      edgeAtAir: snapshot.edgeState?.label || 'unknown',
      edgeScore: snapshot.edgeState?.score || null,
      durationMs, audioBuffer: buffer, script,
    };
    EPISODE_STORE.episodes.push(episode);
    if (EPISODE_STORE.episodes.length > EPISODE_STORE.MAX) EPISODE_STORE.episodes.shift();
    console.log(`[EDGX Studio] Episode ${episodeId} done in ${((Date.now()-startTs)/1000).toFixed(1)}s — ${Math.round(durationMs/1000)}s audio`);
    return episode;
  } catch (err) { console.error('[EDGX Studio] Production failed:', err.message); return null; }
}

module.exports = { EPISODE_STORE, SIGNAL_BREAK, produceBroadcast, generateSignalBreak, selectStories, buildScript, synthesiseEpisode, convictionGradientInstruction };
