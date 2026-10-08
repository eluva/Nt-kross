/* Vercel: GET /api/version — версия витрины. Открытое приложение спрашивает её каждые ~10 с
   и перезагружает каталог (/api/catalog?v=…), только когда она поменялась.
   Запрос сам подтягивает изменения из BILLZ, если каталог старше нескольких секунд. CDN держит ответ 2 с. */
const { catalogVersion } = require("../lib/core");

module.exports = async (req, res) => {
  try {
    const body = await catalogVersion();
    res.setHeader("Cache-Control", body.incomplete || body.stale ? "no-store" : "public, s-maxage=2");
    res.status(200).json(body);
  } catch (e) {
    console.error("version:", e.message);
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: "catalog" });
  }
};
