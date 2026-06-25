"use strict";

/**
 * server.js — YouTube Transcript Monitor API Server
 *
 * Purpose:
 *   Standalone Express server that acts as a server-side proxy for the
 *   yt-monitor frontend. Eliminates all browser CORS restrictions by
 *   fetching YouTube RSS feeds, YouTube Data API v3, and transcripts
 *   entirely server-side.
 *
 * Endpoints:
 *   POST /sync     — fetch recent videos + transcripts for a channel batch
 *   GET  /health   — liveness check
 *
 * Environment variables required:
 *   YOUTUBE_API_KEY   — YouTube Data API v3 key
 *   ALLOWED_ORIGIN    — Frontend URL (e.g. https://your-site.netlify.app)
 *                       Set to * during development only
 *   PORT              — Railway sets this automatically
 *
 * Deploy to Railway:
 *   1. Push this repo to GitHub
 *   2. New Railway project → Deploy from GitHub repo
 *   3. Set YOUTUBE_API_KEY and ALLOWED_ORIGIN in Railway environment variables
 *   4. Railway auto-detects Node, runs `npm start`
 *   5. Copy the Railway public URL into your frontend as API_BASE_URL
 *
 * Assumptions:
 *   - Caller sends batches of ≤ 8 channels
 *   - YouTube RSS feeds return Atom XML (max 15 videos per channel)
 *   - youtube-transcript fetches auto/manual captions from YouTube's timedtext API
 *
 * Known limitations:
 *   - Transcripts unavailable for live streams, age-restricted, or private videos
 *   - YouTube Data API v3 search.list costs 100 quota units/call (10k/day free tier)
 *   - RSS is always tried first (zero quota cost)
 */

const https   = require("https");
const express = require("express");
const cors    = require("cors");
const { YoutubeTranscript } = require("youtube-transcript");

/* ─── Config ─────────────────────────────────────────────────────────────── */

const PORT               = process.env.PORT || 3000;
const YOUTUBE_API_KEY    = process.env.YOUTUBE_API_KEY;
const ALLOWED_ORIGIN     = process.env.ALLOWED_ORIGIN || "*";

const YT_RSS_BASE            = "https://www.youtube.com/feeds/videos.xml?channel_id=";
const YT_API_BASE            = "https://www.googleapis.com/youtube/v3";
const MAX_VIDEOS_PER_CHANNEL = 5;
const TRANSCRIPT_TIMEOUT_MS  = 12000;

/* ─── Startup validation ─────────────────────────────────────────────────── */

if (!YOUTUBE_API_KEY) {
  console.error("FATAL: YOUTUBE_API_KEY environment variable is not set. Exiting.");
  process.exit(1);
}

/* ─── App ────────────────────────────────────────────────────────────────── */

const app = express();

app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "64kb" }));

/* ─── Health check ───────────────────────────────────────────────────────── */

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

/* ─── POST /sync ─────────────────────────────────────────────────────────── */

/**
 * Request body:
 *   {
 *     channels: Array<{
 *       channelId: string,              // UC-prefixed, 24 chars
 *       name: string,
 *       lastVideoPublishedAt: string | null   // ISO 8601
 *     }>
 *   }
 *
 * Response:
 *   {
 *     videos: Array<{
 *       videoId: string,
 *       channelId: string,
 *       channelName: string,
 *       title: string,
 *       publishedAt: string,
 *       transcript: string
 *     }>,
 *     errors: Array<{ channelId: string, stage: string, message: string }>
 *   }
 */
app.post("/sync", async (req, res) => {
  const { channels } = req.body;

  // Input validation
  if (!Array.isArray(channels) || channels.length === 0) {
    return res.status(400).json({ error: "channels must be a non-empty array" });
  }

  if (channels.length > 8) {
    return res.status(400).json({ error: "channels batch size must not exceed 8" });
  }

  for (const ch of channels) {
    if (
      typeof ch.channelId !== "string" ||
      !ch.channelId.startsWith("UC") ||
      ch.channelId.length !== 24
    ) {
      return res.status(400).json({ error: `Invalid channelId: ${ch.channelId}` });
    }
    if (typeof ch.name !== "string" || ch.name.trim() === "") {
      return res.status(400).json({ error: `Missing name for channelId: ${ch.channelId}` });
    }
  }

  const videos = [];
  const errors = [];

  // Process channels sequentially — avoids hammering upstream APIs
  for (const channel of channels) {
    const { channelId, name, lastVideoPublishedAt } = channel;
    const since = lastVideoPublishedAt ? new Date(lastVideoPublishedAt) : null;

    // Stage 1: RSS (free, no quota)
    let rawVideos = [];
    let rssOk = false;

    try {
      rawVideos = await fetchRssFeed(channelId, since);
      rssOk = true;
    } catch (rssErr) {
      errors.push({ channelId, stage: "rss", message: rssErr.message });
    }

    // Stage 2: YouTube Data API v3 fallback
    if (!rssOk || rawVideos.length === 0) {
      try {
        rawVideos = await fetchApiVideos(channelId, since);
      } catch (apiErr) {
        errors.push({ channelId, stage: "youtube_api", message: apiErr.message });
        continue; // Both sources failed — skip channel
      }
    }

    const candidates = rawVideos.slice(0, MAX_VIDEOS_PER_CHANNEL);

    // Stage 3: Transcripts (non-fatal failures)
    for (const v of candidates) {
      let transcript = "";
      try {
        transcript = await fetchTranscriptWithTimeout(v.videoId, TRANSCRIPT_TIMEOUT_MS);
      } catch (txErr) {
        errors.push({
          channelId,
          stage: "transcript",
          message: `${v.videoId}: ${txErr.message}`
        });
      }

      videos.push({
        videoId:     v.videoId,
        channelId,
        channelName: name,
        title:       v.title,
        publishedAt: v.publishedAt,
        transcript
      });
    }
  }

  res.json({ videos, errors });
});

/* ─── 404 catch-all ──────────────────────────────────────────────────────── */

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

/* ─── RSS feed fetch ─────────────────────────────────────────────────────── */

async function fetchRssFeed(channelId, since) {
  const url = `${YT_RSS_BASE}${encodeURIComponent(channelId)}`;
  const xml = await httpGet(url);

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  const results = [];

  for (const [, entry] of entries) {
    const videoIdMatch   = entry.match(/<yt:videoId>([\w-]+)<\/yt:videoId>/);
    const titleMatch     = entry.match(/<title>([^<]*)<\/title>/);
    const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);

    if (!videoIdMatch || !titleMatch || !publishedMatch) continue;

    const publishedAt = publishedMatch[1].trim();
    if (since && new Date(publishedAt) <= since) continue;

    results.push({
      videoId:     videoIdMatch[1].trim(),
      title:       decodeXmlEntities(titleMatch[1].trim()),
      publishedAt
    });
  }

  return results;
}

/* ─── YouTube Data API v3 fallback ───────────────────────────────────────── */

async function fetchApiVideos(channelId, since) {
  const params = new URLSearchParams({
    part:       "snippet",
    channelId,
    order:      "date",
    maxResults: String(MAX_VIDEOS_PER_CHANNEL),
    type:       "video",
    key:        YOUTUBE_API_KEY
  });

  if (since) {
    params.set("publishedAfter", since.toISOString());
  }

  const url = `${YT_API_BASE}/search?${params.toString()}`;
  const raw = await httpGet(url);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("YouTube API returned non-JSON response");
  }

  if (parsed.error) {
    throw new Error(`YouTube API error ${parsed.error.code}: ${parsed.error.message}`);
  }

  if (!Array.isArray(parsed.items)) return [];

  return parsed.items
    .filter(item => item.id?.videoId && item.snippet)
    .map(item => ({
      videoId:     item.id.videoId,
      title:       item.snippet.title || "",
      publishedAt: item.snippet.publishedAt || ""
    }));
}

/* ─── Transcript fetch ───────────────────────────────────────────────────── */

async function fetchTranscriptWithTimeout(videoId, timeoutMs) {
  const transcriptPromise = YoutubeTranscript.fetchTranscript(videoId)
    .then(segments => {
      if (!Array.isArray(segments) || segments.length === 0) return "";
      return segments
        .map(s => (typeof s.text === "string" ? s.text.trim() : ""))
        .filter(Boolean)
        .join(" ");
    });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Transcript fetch timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
  );

  return Promise.race([transcriptPromise, timeoutPromise]);
}

/* ─── HTTP helper ────────────────────────────────────────────────────────── */

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; yt-monitor/1.0)" } },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      }
    ).on("error", reject);
  });
}

/* ─── XML entity decoder ─────────────────────────────────────────────────── */

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'");
}

/* ─── Start ──────────────────────────────────────────────────────────────── */

app.listen(PORT, () => {
  console.log(`yt-monitor server running on port ${PORT}`);
  console.log(`CORS allowed origin: ${ALLOWED_ORIGIN}`);
});
