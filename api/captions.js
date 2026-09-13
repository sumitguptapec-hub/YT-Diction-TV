// Fetches caption cues for a YouTube video via the same "innertube" player
// endpoint the Android app uses -- YouTube's older public timedtext-list
// endpoint reliably returns empty now. This has to run server-side (not in
// the browser) because youtube.com doesn't send CORS headers permitting a
// third-party page to call it directly.
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_URL = `https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`;

// Only ever accept English or Hindi -- YouTube's caption track list for a
// given video isn't stable across requests, and has been observed handing
// back completely unrelated languages (e.g. Bangla) for videos that are
// actually in English. No captions is better than the wrong language.
const ACCEPTABLE_LANGS = ["en", "hi"];

export default async function handler(req, res) {
  const videoId = req.query.videoId;
  if (!videoId || typeof videoId !== "string") {
    res.status(400).json({ error: "videoId is required" });
    return;
  }

  try {
    const { track, availableLangs } = await pickTrack(videoId);
    if (!track) {
      res.status(200).json({ cues: [], availableLangs });
      return;
    }
    const xmlRes = await fetch(track.baseUrl);
    const xml = await xmlRes.text();
    const cues = parseCues(xml);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({ cues, availableLangs });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}

// Returns availableLangs (every language code innertube reported, empty if
// none at all) alongside the picked track, so the client can tell "this
// video genuinely has no captions" apart from "it has captions, just not in
// English or Hindi" apart from "the innertube call itself failed" -- these
// used to all look identical (an empty cues list) with nothing to go on.
async function pickTrack(videoId) {
  const body = {
    videoId,
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "20.10.38",
        androidSdkVersion: 30,
        hl: "en",
        gl: "US",
      },
    },
  };
  // A generic Node fetch (no User-Agent, no YouTube client headers) gets
  // treated differently than a real app's request by this reverse-engineered
  // endpoint -- confirmed by videoId 2BXpDnXPbOs returning zero caption
  // tracks from this deployment while the exact same request body returned
  // a real track when sent from a different origin. Adding the headers a
  // genuine Android app would send is standard practice for this class of
  // API and costs nothing if it isn't the deciding factor.
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
    "X-YouTube-Client-Name": "3",
    "X-YouTube-Client-Version": "20.10.38",
  };

  // Also retry once after a short pause -- Vercel's serverless IPs are
  // shared across countless apps hitting this same endpoint, so an empty
  // captionTracks list isn't necessarily permanent for a given video.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(400);
    const playerRes = await fetch(INNERTUBE_URL, { method: "POST", headers, body: JSON.stringify(body) });
    if (!playerRes.ok) continue;
    const data = await playerRes.json();
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (tracks.length === 0) continue;

    const availableLangs = tracks.map((t) => t.languageCode);
    for (const lang of ACCEPTABLE_LANGS) {
      const track = tracks.find((t) => t.languageCode === lang && t.kind !== "asr");
      if (track) return { track, availableLangs };
    }
    for (const lang of ACCEPTABLE_LANGS) {
      const track = tracks.find((t) => t.languageCode === lang);
      if (track) return { track, availableLangs };
    }
    return { track: null, availableLangs };
  }
  return { track: null, availableLangs: [] };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Innertube-provided baseUrls return YouTube's word-by-word caption format
// (<p t="ms" d="ms"><s>word</s>...</p>), so try that first and fall back to
// the older simple <text start="sec" dur="sec">line</text> format.
function parseCues(xml) {
  const fromWordFormat = parseWordFormat(xml);
  if (fromWordFormat.length > 0) return fromWordFormat;
  return parseLineFormat(xml);
}

function parseWordFormat(xml) {
  const cues = [];
  const pRegex = /<p t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
  let match;
  while ((match = pRegex.exec(xml)) !== null) {
    const startMs = Number(match[1]);
    const durMs = match[2] ? Number(match[2]) : 0;
    const text = stripTagsAndDecode(match[3]).trim();
    if (text) {
      cues.push({ startSec: startMs / 1000, endSec: (startMs + durMs) / 1000, text });
    }
  }
  return cues;
}

function parseLineFormat(xml) {
  const cues = [];
  const textRegex = /<text start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = textRegex.exec(xml)) !== null) {
    const start = Number(match[1]);
    const dur = match[2] ? Number(match[2]) : 0;
    const text = stripTagsAndDecode(match[3]).trim();
    if (text) {
      cues.push({ startSec: start, endSec: start + dur, text });
    }
  }
  return cues;
}

function stripTagsAndDecode(s) {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
