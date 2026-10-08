/* NT Kross — локальный сервер для разработки (на Vercel вместо него работают api/*.js).
   Отдаёт public/ и те же /api/catalog, /api/order, /api/staffbot и /api/admin (админка — /admin.html).
   STAFF_BOT_POLL=1 — бот сотрудников забирает сообщения сам (до localhost вебхук Telegram не дойдёт).
   Запуск: node server.js  (Node 18+, без зависимостей) */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
process.env.ORDERS_LOG = process.env.ORDERS_LOG || path.join(__dirname, "orders.jsonl");
const zlib = require("zlib");
const { getCatalog, catalogBody, placeOrder } = require("./lib/core");
const staff = require("./lib/staff");
const admin = require("./lib/admin");

const PORT = +process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(type ? body : JSON.stringify(body));
}
/* JSON со сжатием (на Vercel сжимает сама платформа) */
function sendGzip(req, res, body) {
  const buf = Buffer.from(JSON.stringify(body));
  if (!/\bgzip\b/.test(req.headers["accept-encoding"] || "")) return send(res, 200, body);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip", "Cache-Control": "no-store" });
  res.end(zlib.gzipSync(buf));
}
function readBody(req, max = 64e3) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > max) { fail(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/catalog" && req.method === "GET") {
      try { return sendGzip(req, res, await catalogBody(url.searchParams.get("limit"))); } catch { return send(res, 503, { error: "catalog" }); }
    }
    if (url.pathname === "/api/order" && req.method === "POST") {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "json" }); }
      const [code, out] = await placeOrder(body || {}, req.socket.remoteAddress || "");
      return send(res, code, out);
    }
    if (url.pathname === "/api/admin") {
      let body = {};
      if (req.method === "POST") { try { body = JSON.parse(await readBody(req, 5e6)) || {}; } catch { return send(res, 400, { error: "json" }); } } // фото — до ~4 МБ
      const [code, out] = await admin.handle(req.method, body, req.headers, req.socket.remoteAddress || "");
      return send(res, code, out);
    }
    if (url.pathname.startsWith("/uploads/") && req.method === "GET") { // фото из админки (на Vercel они в Vercel Blob)
      const file = path.join(admin.UPLOADS, path.basename(url.pathname));
      const type = TYPES[path.extname(file).toLowerCase()];
      if (type && fs.existsSync(file)) return send(res, 200, fs.readFileSync(file), type);
      return send(res, 404, { error: "not found" });
    }
    if (url.pathname === "/api/staffbot" && req.method === "POST") {
      if (!staff.validSecret(req.headers["x-telegram-bot-api-secret-token"])) return send(res, 401, { error: "secret" });
      let body = null;
      try { body = JSON.parse(await readBody(req)); } catch {}
      await staff.handle(body).catch(e => console.error("staffbot:", e.message));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/staffbot" && req.method === "GET") {
      const [code, out] = await staff.setup(url.searchParams.get("setup") || "", process.env.APP_URL || "https://" + req.headers.host);
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
if (process.env.STAFF_BOT_POLL === "1") staff.poll().catch(e => console.error("Бот сотрудников:", e.message));
