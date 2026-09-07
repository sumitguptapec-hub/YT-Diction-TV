// Lets something outside the browser -- specifically, an iPhone Action
// Button running a Shortcut -- advance the currently-open player by one
// slot without touching the screen. A Shortcut can only open a URL or make
// an HTTP request; it has no way to reach into an already-open tab's
// JavaScript. So this endpoint is the go-between: the Shortcut writes a
// command here, and the open page (see pollRemoteCommands() in app.js)
// polls it every couple seconds and acts locally when it sees a new one.
// The write has to land somewhere both requests can see it, and Vercel's
// serverless functions don't share memory between invocations, so a real
// (tiny) datastore is needed -- Upstash Redis, connected via Vercel's
// Storage tab, which is what REST_URL/REST_TOKEN below point at.
const REST_URL = process.env.KV_REST_API_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN;
const REMOTE_TOKEN = process.env.REMOTE_TOKEN;
const COMMAND_KEY = "ytdictationweb:lastCommand";

export default async function handler(req, res) {
  if (!REST_URL || !REST_TOKEN) {
    res.status(500).json({ error: "Redis isn't connected to this project yet (see README)" });
    return;
  }

  if (req.query.action) {
    // Issuing a command -- e.g. the Shortcut hitting
    // /api/remote?action=next&token=... A GET (not POST) so Shortcuts'
    // simplest "Get Contents of URL" action, with no method/body to
    // configure, works out of the box.
    if (!REMOTE_TOKEN || req.query.token !== REMOTE_TOKEN) {
      res.status(403).json({ error: "bad or missing token" });
      return;
    }
    const action = req.query.action === "prev" ? "prev" : "next";
    const value = JSON.stringify({ action, at: Date.now() });
    const setRes = await redis(["set", COMMAND_KEY, value]);
    if (!setRes.ok) {
      res.status(502).json({ error: "redis write failed" });
      return;
    }
    res.status(200).json({ ok: true });
    return;
  }

  // The open page polling for a new command -- no token needed, this only
  // ever reveals "next"/"prev" plus a timestamp, nothing sensitive.
  const getRes = await redis(["get", COMMAND_KEY]);
  if (!getRes.ok) {
    res.status(502).json({ error: "redis read failed" });
    return;
  }
  const data = await getRes.json();
  res.status(200).json(data.result ? JSON.parse(data.result) : null);
}

function redis(command) {
  return fetch(`${REST_URL}/${command.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${REST_TOKEN}` },
  });
}
