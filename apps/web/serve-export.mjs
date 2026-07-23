// Serve the static export (out/) with the same COOP/COEP headers vercel.json sets
// in production, so cross-origin isolation (Pyodide threads) matches prod locally.
import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname, join, normalize } from "path";
const ROOT = join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "out");
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".py": "text/x-python", ".txt": "text/plain",
};
createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  let file = normalize(join(ROOT, p));
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  try {
    let buf;
    try { buf = await readFile(file); }
    catch { buf = await readFile(file + ".html"); file += ".html"; }
    res.setHeader("Content-Type", TYPES[extname(file)] || "application/octet-stream");
    res.end(buf);
  } catch { res.statusCode = 404; res.end("not found: " + p); }
}).listen(5179, () => console.log("export served on http://localhost:5179"));
