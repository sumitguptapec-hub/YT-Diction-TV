// Produces one HLS segment (a few seconds of MPEG-TS) for
// api/drive-hls-playlist.js's playlist -- see that file for the full
// explanation of why this exists at all (Safari/iOS can't play .mkv, this
// remuxes it into something they can, on demand, per segment).
//
// ffmpeg reads directly from Drive over HTTPS itself (not piped through this
// function first) -- its own -ss before -i does a real, fast byte-range seek
// against Drive's alt=media URL when the requested start is well into a
// large file, confirmed locally: pulling frames at 0s/600s/1200s from the
// same file took about the same ~5s regardless of offset, and the frames
// were genuinely different, not the same one three times. -c copy means
// this is a container remux, not a re-encode: fast, and no quality change.
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const SPAWN_TIMEOUT_MS = 25_000; // generous for a few-second segment; a real hang shouldn't run this long

export default async function handler(req, res) {
  const fileId = req.query.fileId;
  const token = req.query.token;
  const start = Number(req.query.start);
  const duration = Number(req.query.duration);
  if (!fileId || typeof fileId !== "string" || !token || typeof token !== "string" || !Number.isFinite(start) || !Number.isFinite(duration)) {
    res.status(400).json({ error: "fileId, token, start and duration are required" });
    return;
  }

  const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const args = [
    "-loglevel", "error",
    "-headers", `Authorization: Bearer ${token}\r\n`,
    "-ss", start.toFixed(3),
    "-i", driveUrl,
    "-t", duration.toFixed(3),
    "-c", "copy",
    "-f", "mpegts",
    "-mpegts_flags", "+resend_headers",
    "pipe:1",
  ];

  let result;
  try {
    result = await runFfmpeg(args);
  } catch (err) {
    res.status(502).json({ error: `Couldn't start ffmpeg: ${err}` });
    return;
  }

  if (result.code !== 0 || result.stdout.length === 0) {
    res.status(502).json({ error: `ffmpeg failed (exit ${result.code}): ${result.stderr.slice(0, 500) || "no output"}` });
    return;
  }

  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.status(200).end(result.stdout);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }

    const stdoutChunks = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdoutChunks), stderr });
    });
  });
}
