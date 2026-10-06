/* NT Kross — локальный сервер для разработки (на Vercel вместо него работают api/*.js).
   Отдаёт public/ и те же /api/catalog и /api/order.
   Запуск: node server.js  (Node 18+, без зависимостей) */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
process.env.ORDERS_LOG = process.env.ORDERS_LOG || path.join(__dirname, "orders.jsonl");
const { getCatalog, placeOrder } = require("./lib/core");

const PORT = +process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(type ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 64e3) { fail(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/catalog" && req.method === "GET") {
      try { return send(res, 200, await getCatalog()); } catch { return send(res, 503, { error: "catalog" }); }
    }
    if (url.pathname === "/api/order" && req.method === "POST") {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "json" }); }
      const [code, out] = await placeOrder(body || {}, req.socket.remoteAddress || "");
      return send(res, code, out);
    }
    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const file = path.join(PUBLIC, rel);
      const type = TYPES[path.extname(file).toLowerCase()];
      if (type && file.startsWith(PUBLIC + path.sep) && fs.existsSync(file)) return send(res, 200, fs.readFileSync(file), type);
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(req.method, url.pathname, e);
    send(res, 500, { error: "server" });
  }
});

server.listen(PORT, () => console.log("NT Kross: http://localhost:" + PORT));
getCatalog().catch(e => console.error("Каталог:", e.message)); // прогреваем каталог сразу
