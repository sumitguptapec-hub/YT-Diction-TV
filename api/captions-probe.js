// TEMPORARY diagnostic (delete once the caption lookup is settled): tries
// several YouTube client identities from this deployment's datacenter IP and
// reports, for each, whether YouTube answered normally, whether caption tracks
// came back, and whether the track's URL actually returned caption data.
const KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const URL = `https://www.youtube.com/youtubei/v1/player?key=${KEY}`;
const EMBED = { embedUrl: "https://www.youtube.com/" };

const CLIENTS = {
  ANDROID: {
    ctx: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en", gl: "US" },
    ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip", id: "3", ver: "20.10.38",
  },
  ANDROID_VR: {
    ctx: { clientName: "ANDROID_VR", clientVersion: "1.60.19", deviceMake: "Oculus", deviceModel: "Quest 3", androidSdkVersion: 32, osName: "Android", osVersion: "12L", hl: "en", gl: "US" },
    ua: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip", id: "28", ver: "1.60.19",
  },
  IOS: {
    ctx: { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82", hl: "en", gl: "US" },
    ua: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)", id: "5", ver: "20.10.4",
  },
  TVHTML5: {
    ctx: { clientName: "TVHTML5", clientVersion: "7.20250101.16.00", hl: "en", gl: "US" },
    ua: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version", id: "7", ver: "7.20250101.16.00",
  },
  TV_EMBEDDED: {
    ctx: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0", hl: "en", gl: "US" },
    ua: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version", id: "85", ver: "2.0", thirdParty: EMBED,
  },
  WEB_EMBEDDED: {
    ctx: { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "1.20250101.01.00", hl: "en", gl: "US" },
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", id: "56", ver: "1.20250101.01.00", thirdParty: EMBED,
  },
  MWEB: {
    ctx: { clientName: "MWEB", clientVersion: "2.20250101.00.00", hl: "en", gl: "US" },
    ua: "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1", id: "2", ver: "2.20250101.00.00",
  },
};

async function tryClient(name, cfg, videoId) {
  const out = { client: name };
  try {
    const context = { client: cfg.ctx };
    if (cfg.thirdParty) context.thirdParty = cfg.thirdParty;
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": cfg.ua, "X-YouTube-Client-Name": cfg.id, "X-YouTube-Client-Version": cfg.ver },
      body: JSON.stringify({ videoId, context, contentCheckOk: true, racyCheckOk: true }),
    });
    out.http = res.status;
    if (!res.ok) return out;
    const data = await res.json();
    out.playability = data?.playabilityStatus?.status;
    out.reason = (data?.playabilityStatus?.reason || "").slice(0, 60);
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    out.tracks = tracks.map((t) => `${t.languageCode}${t.kind === "asr" ? "*" : ""}`);
    const pick = tracks.find((t) => t.languageCode === "en" && t.kind !== "asr") || tracks.find((t) => t.languageCode === "en") || tracks.find((t) => t.languageCode === "hi") || tracks[0];
    if (pick) {
      out.hasPot = /[?&]pot=/.test(pick.baseUrl);
      const x = await fetch(pick.baseUrl);
      const body = await x.text();
      out.captionHttp = x.status;
      out.captionBytes = body.length;
    }
  } catch (err) {
    out.error = String(err).slice(0, 80);
  }
  return out;
}

export default async function handler(req, res) {
  const videoId = req.query.videoId;
  if (!videoId) { res.status(400).json({ error: "videoId required" }); return; }
  const results = await Promise.all(Object.entries(CLIENTS).map(([name, cfg]) => tryClient(name, cfg, videoId)));
  res.status(200).json({ videoId, results });
}
