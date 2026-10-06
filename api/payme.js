/* Vercel: POST /api/payme — адрес для Payme Merchant API (указывается в кабинете Payme Business) */
const payme = require("../lib/payme");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  if (req.method !== "POST") return res.status(200).json({ id: null, error: { code: -32300, message: { ru: "Метод запроса должен быть POST", uz: "POST", en: "POST required" } } });
  res.status(200).json(await payme.handle(body, req.headers.authorization || ""));
};
