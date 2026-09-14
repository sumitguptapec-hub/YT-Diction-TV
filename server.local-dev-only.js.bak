// Local-only dev server -- NOT used in the Vercel deployment (Vercel serves
// public/ and api/*.js natively with zero config). This just lets you test
// the whole thing, captions API included, on your own machine first.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    const modPath = path.join(__dirname, "api", url.pathname.slice(5) + ".js");
    try {
      const mod = await import(`${pathToFileURL(modPath).href}?t=${Date.now()}`);
      const fakeReq = { query: Object.fromEntries(url.searchParams) };
      const fakeRes = {
        _status: 200,
        status(code) {
          this._status = code;
          return this;
        },
        setHeader(k, v) {
          res.setHeader(k, v);
        },
        json(body) {
          res.writeHead(this._status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        },
      };
      await mod.default(fakeReq, fakeRes);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  const filePath = path.join(PUBLIC_DIR, url.pathname === "/" ? "/index.html" : url.pathname);
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => console.log(`Local dev server running at http://localhost:${PORT}`));
