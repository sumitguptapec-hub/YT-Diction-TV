// TEMPORARY diagnostic endpoint. The caption fetch works from a residential
// connection but comes back empty from this deployment for most videos, and
// testing client variants locally proves nothing -- the whole question is
// what this *serverless function's* IP can reach. So try every candidate
// client identity from here and report which ones actually return tracks.
// Delete once a working client is identified and moved into captions.js.
const INNERTUBE_URL = "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

const CLIENTS = {
  ANDROID: {
    body: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en", gl: "US" },
    ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
  },
  // yt-dlp's notes flag this one as not requiring the attestation token the
  // plain ANDROID/WEB clients started demanding -- the main reason to expect
  // a different outcome from a datacenter IP.
  ANDROID_VR: {
    body: {
      clientName: "ANDROID_VR",
      clientVersion: "1.60.19",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      osName: "Android",
      osVersion: "12",
      androidSdkVersion: 32,
      hl: "en",
      gl: "US",
    },
    ua: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; GB; Quest 3) gzip",
  },
  IOS: {
    body: { clientName: "IOS", clientVersion: "19.29.1", deviceModel: "iPhone14,3", hl: "en", gl: "US" },
    ua: "com.google.ios.youtube/19.29.1 (iPhone14,3; U; CPU iOS 17_5_1 like Mac OS X)",
  },
  TVHTML5_SIMPLY_EMBEDDED_PLAYER: {
    body: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0", hl: "en", gl: "US" },
    ua: "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
  },
  WEB_EMBEDDED_PLAYER: {
    body: { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "1.20240101.00.00", hl: "en", gl: "US" },
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  },
  MWEB: {
    body: { clientName: "MWEB", clientVersion: "2.20240101.00.00", hl: "en", gl: "US" },
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
};

export default async function handler(req, res) {
  const videoId = req.query.videoId;
  if (!videoId) {
    res.status(400).json({ error: "videoId is required" });
    return;
  }

  const results = {};
  for (const [name, cfg] of Object.entries(CLIENTS)) {
    try {
      const r = await fetch(INNERTUBE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": cfg.ua },
        body: JSON.stringify({ videoId, context: { client: cfg.body } }),
      });
      if (!r.ok) {
        results[name] = { httpStatus: r.status };
        continue;
      }
      const data = await r.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      results[name] = {
        playability: data?.playabilityStatus?.status ?? null,
        reason: data?.playabilityStatus?.reason ?? null,
        trackCount: tracks.length,
        langs: tracks.map((t) => `${t.languageCode}${t.kind === "asr" ? "(asr)" : ""}`),
      };
    } catch (err) {
      results[name] = { error: String(err) };
    }
  }
  res.status(200).json({ videoId, region: process.env.VERCEL_REGION ?? null, results });
}
