/* Vercel: POST /api/order — оформить заказ: сервер сверяет наличие с BILLZ и отправляет заказ менеджеру и сотрудникам */
const { placeOrder } = require("../lib/core");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || typeof body !== "object") return res.status(400).json({ error: "json" });
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const [code, out] = await placeOrder(body, ip);
    res.status(code).json(out);
  } catch (e) {
    console.error("order:", e.message);
    res.status(500).json({ error: "server" });
  }
};
