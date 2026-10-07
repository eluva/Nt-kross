/* Vercel: GET /api/catalog — каталог в наличии из BILLZ (?limit=N — только первые N моделей).
   CDN держит ответ 3 минуты и ещё сутки отдаёт старый, пока обновляется новый.
   Неполный каталог (идёт первый полный проход) и снимок без последних изменений не кэшируем — приложение спросит ещё раз. */
const { catalogBody } = require("../lib/core");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "method" });
  try {
    const body = await catalogBody(req.query && req.query.limit);
    res.setHeader("Cache-Control", body.incomplete || body.stale ? "no-store" : "public, s-maxage=180, stale-while-revalidate=86400");
    res.status(200).json(body);
  } catch (e) {
    console.error("catalog:", e.message);
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: "catalog" });
  }
};
