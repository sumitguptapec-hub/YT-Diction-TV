// TEMPORARY diagnostic. api/summarize.js's `req.method !== "POST"` check is
// rejecting a request curl -v confirms is a genuine `POST /api/summarize
// HTTP/1.1` -- something about how this runtime represents req is not what
// it looks like from the outside. Echo back everything to find out exactly
// what's wrong, rather than guess. Delete once summarize.js is fixed.
export default async function handler(req, res) {
  res.status(200).json({
    method: req.method,
    methodType: typeof req.method,
    methodJson: JSON.stringify(req.method),
    hasBody: req.body !== undefined,
    bodyType: typeof req.body,
    url: req.url,
    keys: Object.keys(req),
  });
}
