// Generates an HLS playlist (.m3u8) for a Drive video that the browser
// can't play directly -- in practice, always because it's an .mkv file:
// Safari, and every browser on iPhone/iPad (Apple requires them all to use
// Safari's engine), refuses the Matroska container outright, even when the
// video/audio inside is ordinary H.264/AAC (confirmed via search, not
// assumption -- see describeUnplayableVideo() in public/js/app.js, which
// this is the automatic fix for rather than just a better error message).
//
// This is the client's automatic *fallback* -- api/drive-video.js's direct
// byte-range proxy is tried first and works for anything the browser can
// already decode (which is most files here; Chrome/Firefox play .mkv
// directly too), so this only runs for the files that would otherwise fail.
//
// Each segment is produced on demand by api/drive-hls-segment.js, which
// remuxes (not re-encodes -- `-c copy`, a fast, lossless container swap)
// a bounded time window of the source into MPEG-TS via ffmpeg, seeking
// ffmpeg's own HTTPS input directly against Drive (confirmed locally before
// writing this: ffmpeg's `-ss` before `-i` does a real, fast, byte-range
// seek against Drive's alt=media URL -- verified with three actually-
// different frames pulled from three timestamps, each taking about the same
// few seconds regardless of offset). Segment length is chosen per file from
// its own bitrate so no single segment is likely to exceed Vercel's hard
// 4.5 MB function-response limit (confirmed against Vercel's current docs,
// not the older/looser number some guides still quote) -- comfortably
// undershooting it, since real footage varies around its average bitrate.
const SAFE_SEGMENT_BYTES = 2.5 * 1024 * 1024; // budget per segment; real limit is 4.5 MB
const MIN_SEGMENT_SEC = 2;
const MAX_SEGMENT_SEC = 8;

export default async function handler(req, res) {
  const fileId = req.query.fileId;
  const token = req.query.token;
  if (!fileId || typeof fileId !== "string" || !token || typeof token !== "string") {
    res.status(400).json({ error: "fileId and token are required" });
    return;
  }

  let meta;
  try {
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=size,videoMediaMetadata`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (metaRes.status === 401 || metaRes.status === 403) {
      res.status(metaRes.status).json({ error: "Drive rejected the request -- expired or invalid token?" });
      return;
    }
    if (!metaRes.ok) {
      res.status(metaRes.status).json({ error: `Drive returned HTTP ${metaRes.status}` });
      return;
    }
    meta = await metaRes.json();
  } catch (err) {
    res.status(502).json({ error: `Couldn't reach Google Drive: ${err}` });
    return;
  }

  const sizeBytes = Number(meta.size);
  const durationSec = Number(meta.videoMediaMetadata?.durationMillis) / 1000;
  if (!sizeBytes || !durationSec) {
    res.status(422).json({ error: "Drive didn't report this file's size/duration -- can't plan segments." });
    return;
  }

  const avgBytesPerSec = sizeBytes / durationSec;
  const segmentSec = Math.min(MAX_SEGMENT_SEC, Math.max(MIN_SEGMENT_SEC, Math.floor(SAFE_SEGMENT_BYTES / avgBytesPerSec)));

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentSec)}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  for (let start = 0; start < durationSec; start += segmentSec) {
    const length = Math.min(segmentSec, durationSec - start);
    const segUrl =
      `/api/drive-hls-segment?fileId=${encodeURIComponent(fileId)}&token=${encodeURIComponent(token)}` +
      `&start=${start.toFixed(3)}&duration=${length.toFixed(3)}`;
    lines.push(`#EXTINF:${length.toFixed(3)},`, segUrl);
  }
  lines.push("#EXT-X-ENDLIST");

  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.status(200).end(lines.join("\n") + "\n");
}
