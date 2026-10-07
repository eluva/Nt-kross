/* Vercel: POST /api/staffbot — вебхук бота сотрудников (Telegram присылает сюда сообщения и нажатия кнопок).
           GET  /api/staffbot?setup=<STAFF_WEBHOOK_SECRET> — открыть один раз после деплоя: привязывает вебхук к этому сайту */
const staff = require("../lib/staff");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
      const [code, out] = await staff.setup((req.query && req.query.setup) || "", "https://" + host);
      return res.status(code).json(out);
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    if (!staff.validSecret(req.headers["x-telegram-bot-api-secret-token"])) return res.status(401).json({ error: "secret" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
    await staff.handle(body);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("staffbot:", e.message);
    res.status(200).json({ ok: false }); // не 5xx — иначе Telegram будет присылать то же обновление снова
  }
};
