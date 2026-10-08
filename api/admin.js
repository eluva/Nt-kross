/* Vercel: GET /api/admin — всё для админки; POST /api/admin { action, … } — вход и правки (lib/admin.js) */
require("../lib/core"); // первым — он читает .env и подключает admin
const admin = require("../lib/admin");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
    if (req.method === "POST" && (!body || typeof body !== "object")) return res.status(400).json({ error: "json" });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const [code, out] = await admin.handle(req.method, body || {}, req.headers, ip);
    res.status(code).json(out);
  } catch (e) {
    console.error("admin:", e.message);
    res.status(500).json({ error: "server" });
  }
};
