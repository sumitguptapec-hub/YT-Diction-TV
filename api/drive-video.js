// Streams a Google Drive video to the browser's <video> element in bounded
// chunks, instead of the browser downloading the entire file into memory
// before playback can start (the previous approach -- see README/git log).
// For the multi-hundred-MB to multi-GB files this app is actually used with,
// that looked exactly like a download that never finishes.
//
// Why this has to be a server-side proxy at all: a plain <video src="...">
// can't attach a custom Authorization header to the requests the browser
// makes for it, so the real Drive URL (which needs `Authorization: Bearer
// <token>`) can't be used directly. The obvious alternative -- passing the
// token as an `access_token` query parameter, which some Google APIs accept
// -- does NOT work for Drive: a direct test against
// `.../files/{id}?alt=media&access_token=...` returns HTTP 403 ("Sorry...").
// So the real header has to be attached server-side, which means the bytes
// have to pass through here.
//
// The browser's own <video> element is what drives real streaming: it sends
// Range requests as it needs more data, we forward each one to Drive (Drive
// does honor Range requests, confirmed directly -- it returns 206 with a
// correct Content-Range, even though it doesn't advertise "Accept-Ranges" up
// front), and stream the response straight back without buffering it in
// memory here. Whatever Range the browser asks for, each single request to
// this endpoint is capped to CHUNK_BYTES -- if the browser's own Range is
// open-ended or bigger than that (common: an initial "bytes=0-" probing an
// entire multi-GB file), this only fulfils the first slice of it and returns
// a normal, spec-legal 206 for that slice (with the *real* total size in
// Content-Range) -- the browser simply asks again for the next slice once it
// needs it, the same as any segmented video stream. This keeps every single
// invocation of this function fast and small regardless of file size,
// instead of one one invocation trying to hold a connection open for as
// long as an entire video takes to send.
const CHUNK_BYTES = 8 * 1024 * 1024; // 8 MB -- quick even on a slow link, nowhere near a serverless timeout

export default async function handler(req, res) {
  const fileId = req.query.fileId;
  const token = req.query.token;
  if (!fileId || typeof fileId !== "string" || !token || typeof token !== "string") {
    res.status(400).json({ error: "fileId and token are required" });
    return;
  }

  const requested = parseRange(req.headers.range);
  const start = requested?.start ?? 0;
  const end = requested?.end != null ? Math.min(requested.end, start + CHUNK_BYTES - 1) : start + CHUNK_BYTES - 1;

  let driveRes;
  try {
    driveRes = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}`, Range: `bytes=${start}-${end}` },
    });
  } catch (err) {
    res.status(502).json({ error: `Couldn't reach Google Drive: ${err}` });
    return;
  }

  if (driveRes.status === 401 || driveRes.status === 403) {
    // Same shape driveApi.js's other calls already use to detect an expired/revoked token.
    res.status(driveRes.status).json({ error: "Drive rejected the request -- expired or invalid token?" });
    return;
  }
  if (!driveRes.ok && driveRes.status !== 206) {
    res.status(driveRes.status).json({ error: `Drive returned HTTP ${driveRes.status}` });
    return;
  }

  res.status(driveRes.status); // normally 206; Drive answers a plain (Range-less, see parseRange below) request with 200
  res.setHeader("Accept-Ranges", "bytes"); // Drive doesn't send this itself, but every response from here on is Range-servable
  res.setHeader("Cache-Control", "private, max-age=3600");
  for (const h of ["Content-Type", "Content-Length", "Content-Range"]) {
    const v = driveRes.headers.get(h);
    if (v) res.setHeader(h, v);
  }

  if (!driveRes.body) {
    res.end();
    return;
  }
  const { Readable } = await import("node:stream");
  Readable.fromWeb(driveRes.body).pipe(res);
}

// Real <video> elements always send a Range header (every mainstream browser
// does, precisely because servers like this one exist) -- the no-header
// fallback below only matters for something probing this endpoint by hand.
function parseRange(header) {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d+)?$/.exec(header.trim());
  if (!match) return null;
  return { start: Number(match[1]), end: match[2] ? Number(match[2]) : null };
}
