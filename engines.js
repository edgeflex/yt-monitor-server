'use strict';

/**
 * engines.js — Proprietary transcript intelligence engines
 *
 * Purpose:   Deterministic, data-derived analysis of a YouTube transcript.
 *            Every output value is computed from the real caption lines and
 *            their real timing data. No randomness, no LLM, no fabricated data.
 *
 * Engines:
 *   1. SmartChapters™   — topic-shift segmentation (lexical cohesion / TextTiling)
 *   2. KeyMoments™      — salience ranking (TF-IDF + speech-rate anomaly)
 *   3. InstantSummary™  — extractive summary (TextRank graph centrality)
 *   4. TranscriptDNA™   — readability / pace fingerprint metrics
 *
 * Input contract (shared):
 *   lines: Array<{ text: string, offset: number(ms), duration: number(ms) }>
 *
 * Determinism guarantee:
 *   Given identical input `lines`, every engine returns byte-identical output.
 *   No Date.now(), no Math.random(), no external state.
 */

// ─── Shared text utilities ──────────────────────────────────────────────────

/**
 * Common English stopwords — excluded from term-frequency analysis.
 * Static list; not generated.
 */
const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','else','when','at','by','for',
  'with','about','against','between','into','through','during','before','after',
  'above','below','to','from','up','down','in','out','on','off','over','under',
  'again','further','is','are','was','were','be','been','being','have','has',
  'had','having','do','does','did','doing','i','you','he','she','it','we','they',
  'me','him','her','us','them','my','your','his','its','our','their','this','that',
  'these','those','am','of','as','so','than','too','very','can','will','just',
  'not','no','nor','only','own','same','such','what','which','who','whom','why',
  'how','all','any','both','each','few','more','most','other','some','here','there',
  'gonna','wanna','okay','ok','yeah','um','uh','like','really','actually','basically',
  'know','going','get','got','one','also','well','right','now','thing','things','lot',
]);

/**
 * Tokenise text into lowercase word tokens, stripping punctuation.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Content tokens only (stopwords and 1-char tokens removed).
 * @param {string} text
 * @returns {string[]}
 */
function contentTokens(text) {
  return tokenize(text).filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Format milliseconds → MM:SS.
 * @param {number} ms
 * @returns {string}
 */
function fmtTimestamp(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * Reconstruct full transcript text and split into sentence-like units.
 * Caption lines often fragment sentences, so we rejoin then re-split on
 * terminal punctuation. Falls back to line-level units when punctuation
 * is absent (common in auto-captions).
 *
 * @param {Array} lines
 * @returns {Array<{ text, offset }>}
 */
function buildSentences(lines) {
  // Join all caption text, tracking where each line starts (for timestamps)
  const sentences = [];
  let buffer = '';
  let bufferStart = lines.length ? lines[0].offset : 0;

  for (const line of lines) {
    if (!buffer) bufferStart = line.offset;
    buffer += (buffer ? ' ' : '') + line.text.trim();

    // Sentence terminator found → flush
    if (/[.!?]$/.test(line.text.trim())) {
      const clean = buffer.trim();
      if (clean.split(/\s+/).length >= 3) {
        sentences.push({ text: clean, offset: bufferStart });
      }
      buffer = '';
    }
  }
  // Flush remainder
  if (buffer.trim().split(/\s+/).length >= 3) {
    sentences.push({ text: buffer.trim(), offset: bufferStart });
  }

  // Fallback: if punctuation produced too few sentences, chunk by line groups
  if (sentences.length < 4 && lines.length >= 4) {
    const chunkSize = Math.max(2, Math.floor(lines.length / 12));
    const chunked = [];
    for (let i = 0; i < lines.length; i += chunkSize) {
      const slice = lines.slice(i, i + chunkSize);
      chunked.push({
        text: slice.map(l => l.text.trim()).join(' '),
        offset: slice[0].offset,
      });
    }
    return chunked;
  }
  return sentences;
}

// ─── Engine 1: SmartChapters™ ────────────────────────────────────────────────

/**
 * Segment the transcript into chapters by detecting topic shifts.
 *
 * Method (TextTiling-inspired, fully deterministic):
 *   1. Group lines into fixed-size blocks.
 *   2. Build a term-frequency vector for each block.
 *   3. Compute cosine similarity between adjacent blocks.
 *   4. A "valley" in the similarity curve (a local minimum below the mean
 *      minus one standard deviation) marks a topic boundary.
 *   5. Title each chapter from its most salient content terms.
 *
 * @param {Array} lines
 * @returns {Array<{ index, title, startMs, startLabel, lineCount }>}
 */
function smartChapters(lines) {
  if (lines.length < 8) {
    // Too short to segment meaningfully — return single chapter
    return [{
      index: 0,
      title: titleFromLines(lines),
      startMs: lines.length ? lines[0].offset : 0,
      startLabel: fmtTimestamp(lines.length ? lines[0].offset : 0),
      lineCount: lines.length,
    }];
  }

  // 1. Group lines into blocks (~6 lines each, min 8 blocks for resolution)
  const blockSize = Math.max(3, Math.round(lines.length / Math.max(8, Math.min(40, lines.length / 4))));
  const blocks = [];
  for (let i = 0; i < lines.length; i += blockSize) {
    const slice = lines.slice(i, i + blockSize);
    blocks.push({
      startLine: i,
      offset: slice[0].offset,
      tokens: slice.flatMap(l => contentTokens(l.text)),
    });
  }

  if (blocks.length < 3) {
    return [{
      index: 0,
      title: titleFromLines(lines),
      startMs: lines[0].offset,
      startLabel: fmtTimestamp(lines[0].offset),
      lineCount: lines.length,
    }];
  }

  // 2-3. Cosine similarity between adjacent blocks
  const sims = [];
  for (let i = 0; i < blocks.length - 1; i++) {
    sims.push(cosineSim(termFreq(blocks[i].tokens), termFreq(blocks[i + 1].tokens)));
  }

  // 4. Boundary detection: local minima below (mean - 0.5*stdev)
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
  const variance = sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length;
  const stdev = Math.sqrt(variance);
  const threshold = mean - 0.5 * stdev;

  const boundaries = [0]; // first chapter always starts at block 0
  for (let i = 1; i < sims.length - 1; i++) {
    const isLocalMin = sims[i] < sims[i - 1] && sims[i] <= sims[i + 1];
    if (isLocalMin && sims[i] < threshold) {
      // The boundary falls between block i and i+1 → chapter starts at block i+1
      boundaries.push(i + 1);
    }
  }

  // 5. Build chapters from boundaries
  const chapters = [];
  for (let b = 0; b < boundaries.length; b++) {
    const startBlock = boundaries[b];
    const endBlock = b + 1 < boundaries.length ? boundaries[b + 1] : blocks.length;
    const startLineIdx = blocks[startBlock].startLine;
    const endLineIdx = endBlock < blocks.length ? blocks[endBlock].startLine : lines.length;
    const chapterLines = lines.slice(startLineIdx, endLineIdx);

    chapters.push({
      index: b,
      title: titleFromLines(chapterLines),
      startMs: blocks[startBlock].offset,
      startLabel: fmtTimestamp(blocks[startBlock].offset),
      lineCount: chapterLines.length,
    });
  }
  return chapters;
}

/**
 * Generate a chapter title from its most salient content terms.
 * Picks the top-frequency content terms and presents them title-cased.
 * @param {Array} lines
 * @returns {string}
 */
function titleFromLines(lines) {
  const tokens = lines.flatMap(l => contentTokens(l.text));
  if (tokens.length === 0) return 'Untitled section';
  const tf = termFreq(tokens);
  const top = [...tf.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([term]) => term.charAt(0).toUpperCase() + term.slice(1));
  return top.join(' · ');
}

// ─── Engine 2: KeyMoments™ ───────────────────────────────────────────────────

/**
 * Rank transcript lines by information salience to surface key moments.
 *
 * Salience score per line = normalised TF-IDF mass of its content terms,
 * boosted by speech-rate anomaly (lines spoken slower than the speaker's
 * baseline often mark emphasis). All derived from real caption timings.
 *
 * @param {Array} lines
 * @param {number} topN
 * @returns {Array<{ offset, startLabel, text, score }>}
 */
function keyMoments(lines, topN = 8) {
  if (lines.length === 0) return [];

  // Document frequency across lines (each line = a "document")
  const df = new Map();
  const lineTokenSets = lines.map(l => {
    const toks = contentTokens(l.text);
    const uniq = new Set(toks);
    for (const t of uniq) df.set(t, (df.get(t) || 0) + 1);
    return toks;
  });

  const N = lines.length;

  // Baseline speech rate: words per second across the whole transcript
  let totalWords = 0, totalDurMs = 0;
  for (const l of lines) {
    totalWords += tokenize(l.text).length;
    totalDurMs += Math.max(1, l.duration || 0);
  }
  const baselineWps = totalDurMs > 0 ? totalWords / (totalDurMs / 1000) : 0;

  // Score each line
  const scored = lines.map((l, i) => {
    const toks = lineTokenSets[i];
    if (toks.length === 0) return { ...l, score: 0 };

    // TF-IDF mass
    const tf = termFreq(toks);
    let tfidf = 0;
    for (const [term, freq] of tf) {
      const idf = Math.log((N + 1) / ((df.get(term) || 0) + 1)) + 1;
      tfidf += (freq / toks.length) * idf;
    }

    // Speech-rate anomaly factor (slower-than-baseline → emphasis boost)
    const durSec = Math.max(0.1, (l.duration || 0) / 1000);
    const lineWps = tokenize(l.text).length / durSec;
    const rateFactor = baselineWps > 0
      ? 1 + Math.max(0, (baselineWps - lineWps) / baselineWps) * 0.5
      : 1;

    return { ...l, score: tfidf * rateFactor };
  });

  // Normalise scores to 0–100 for display
  const maxScore = Math.max(...scored.map(s => s.score), 1e-9);

  return scored
    .map(s => ({
      offset: s.offset,
      startLabel: fmtTimestamp(s.offset),
      text: s.text.trim(),
      score: Math.round((s.score / maxScore) * 100),
    }))
    .filter(s => s.text.split(/\s+/).length >= 4) // skip trivial lines
    .sort((a, b) => b.score - a.score || a.offset - b.offset)
    .slice(0, topN)
    .sort((a, b) => a.offset - b.offset); // present chronologically
}

// ─── Engine 3: InstantSummary™ ───────────────────────────────────────────────

/**
 * Extractive summary via TextRank (graph centrality over sentences).
 *
 * Method:
 *   1. Build sentence units from the transcript.
 *   2. Construct a similarity graph (edge weight = content-term overlap).
 *   3. Run weighted PageRank to convergence (deterministic iteration).
 *   4. Return the top-ranked sentences in original chronological order.
 *
 * No LLM, no paraphrasing — these are real sentences from the transcript.
 *
 * @param {Array} lines
 * @param {number} maxSentences
 * @returns {Array<{ offset, startLabel, text }>}
 */
function instantSummary(lines, maxSentences = 5) {
  const sentences = buildSentences(lines);
  if (sentences.length === 0) return [];
  if (sentences.length <= maxSentences) {
    return sentences.map(s => ({
      offset: s.offset,
      startLabel: fmtTimestamp(s.offset),
      text: s.text,
    }));
  }

  // Pre-tokenise
  const tokenSets = sentences.map(s => new Set(contentTokens(s.text)));

  // Build adjacency: similarity = shared terms / log-length normalisation
  const n = sentences.length;
  const weights = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = tokenSets[i], b = tokenSets[j];
      if (a.size === 0 || b.size === 0) continue;
      let shared = 0;
      for (const t of a) if (b.has(t)) shared++;
      const norm = Math.log(a.size + 1) + Math.log(b.size + 1);
      const sim = norm > 0 ? shared / norm : 0;
      weights[i][j] = sim;
      weights[j][i] = sim;
    }
  }

  // Weighted PageRank (deterministic: fixed damping, fixed iterations)
  const damping = 0.85;
  let scores = new Array(n).fill(1 / n);
  const outSum = weights.map(row => row.reduce((a, b) => a + b, 0));

  for (let iter = 0; iter < 40; iter++) {
    const next = new Array(n).fill((1 - damping) / n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j || weights[j][i] === 0 || outSum[j] === 0) continue;
        next[i] += damping * (weights[j][i] / outSum[j]) * scores[j];
      }
    }
    scores = next;
  }

  // Top sentences by score, then restore chronological order
  return scores
    .map((score, i) => ({ score, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, maxSentences)
    .sort((a, b) => a.i - b.i)
    .map(({ i }) => ({
      offset: sentences[i].offset,
      startLabel: fmtTimestamp(sentences[i].offset),
      text: sentences[i].text,
    }));
}

// ─── Engine 4: TranscriptDNA™ ────────────────────────────────────────────────

/**
 * Compute a readability / pace fingerprint from real transcript data.
 *
 * Metrics (all 0–100 normalised for radar display, plus raw values):
 *   - pace          : words per minute (from real caption timings)
 *   - lexicalDiversity : unique words / total words (type-token ratio)
 *   - vocabularyTier   : share of "rare" words (>6 chars, non-stopword)
 *   - talkDensity      : fraction of video time containing speech
 *   - sentenceComplexity : avg words per sentence unit
 *
 * @param {Array} lines
 * @returns {Object}
 */
function transcriptDNA(lines) {
  if (lines.length === 0) {
    return {
      wordCount: 0, durationSec: 0,
      metrics: { pace: 0, lexicalDiversity: 0, vocabularyTier: 0, talkDensity: 0, sentenceComplexity: 0 },
      raw: { wpm: 0, ttr: 0, rareWordPct: 0, talkPct: 0, avgWordsPerSentence: 0 },
    };
  }

  const allTokens = lines.flatMap(l => tokenize(l.text));
  const wordCount = allTokens.length;

  // Duration: last line end − first line start
  const firstOffset = lines[0].offset;
  const lastLine = lines[lines.length - 1];
  const lastEnd = lastLine.offset + (lastLine.duration || 0);
  const durationMs = Math.max(1, lastEnd - firstOffset);
  const durationSec = durationMs / 1000;

  // 1. Pace (words per minute)
  const wpm = wordCount / (durationSec / 60);

  // 2. Lexical diversity (type-token ratio)
  const uniqueWords = new Set(allTokens).size;
  const ttr = wordCount > 0 ? uniqueWords / wordCount : 0;

  // 3. Vocabulary tier (share of long, non-stopword content words)
  const rareWords = allTokens.filter(t => t.length > 6 && !STOPWORDS.has(t)).length;
  const rareWordPct = wordCount > 0 ? rareWords / wordCount : 0;

  // 4. Talk density (sum of caption durations / total span)
  const speechMs = lines.reduce((a, l) => a + Math.max(0, l.duration || 0), 0);
  const talkPct = Math.min(1, speechMs / durationMs);

  // 5. Sentence complexity (avg words per sentence unit)
  const sentences = buildSentences(lines);
  const avgWordsPerSentence = sentences.length > 0
    ? sentences.reduce((a, s) => a + tokenize(s.text).length, 0) / sentences.length
    : 0;

  // Normalise each to 0–100 against sensible reference ranges
  const norm = (v, lo, hi) => Math.round(Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100)));

  return {
    wordCount,
    durationSec: Math.round(durationSec),
    metrics: {
      pace:               norm(wpm, 80, 200),         // 80–200 wpm typical speech range
      lexicalDiversity:   norm(ttr, 0.15, 0.55),      // type-token ratio range
      vocabularyTier:     norm(rareWordPct, 0.05, 0.30),
      talkDensity:        Math.round(talkPct * 100),
      sentenceComplexity: norm(avgWordsPerSentence, 6, 30),
    },
    raw: {
      wpm:                 Math.round(wpm),
      ttr:                 Math.round(ttr * 1000) / 1000,
      rareWordPct:         Math.round(rareWordPct * 1000) / 1000,
      talkPct:             Math.round(talkPct * 1000) / 1000,
      avgWordsPerSentence: Math.round(avgWordsPerSentence * 10) / 10,
    },
  };
}

// ─── Shared math helpers ─────────────────────────────────────────────────────

/**
 * Term frequency map for a token array.
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
function termFreq(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

/**
 * Cosine similarity between two term-frequency maps.
 * @param {Map} a
 * @param {Map} b
 * @returns {number} 0–1
 */
function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (const [, v] of a) magA += v * v;
  for (const [, v] of b) magB += v * v;
  for (const [k, v] of a) if (b.has(k)) dot += v * b.get(k);
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Run all four engines on a transcript and return a combined analysis object.
 * @param {Array<{text, offset, duration}>} lines
 * @returns {Object}
 */
function analyzeTranscript(lines) {
  return {
    smartChapters:  smartChapters(lines),
    keyMoments:     keyMoments(lines),
    instantSummary: instantSummary(lines),
    transcriptDNA:  transcriptDNA(lines),
  };
}

module.exports = {
  analyzeTranscript,
  smartChapters,
  keyMoments,
  instantSummary,
  transcriptDNA,
};
