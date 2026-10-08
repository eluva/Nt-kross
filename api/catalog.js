/* Vercel: GET /api/catalog — каталог в наличии из BILLZ (?limit=N — только первые N моделей).
   ?v=<версия> — приложение пришло за конкретной версией (узнало её из /api/version): такой ответ CDN держит 10 минут,
   все покупатели берут его из кэша. Без v — при запуске приложения: CDN держит 5 с и, пока обновляет, отдаёт прежний —
   через несколько секунд /api/version всё равно сообщит, если что-то поменялось.
   Неполный каталог (идёт первый полный проход) и снимок без последних изменений не кэшируем — приложение спросит ещё раз. */
const { catalogBody } = require("../lib/core");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "method" });
  try {
    const q = req.query || {}, body = await catalogBody(q.limit);
    res.setHeader("Cache-Control", body.incomplete || body.stale ? "no-store" : q.v ? "public, s-maxage=600" : "public, s-maxage=5, stale-while-revalidate=300");
    res.status(200).json(body);
  } catch (e) {
    console.error("catalog:", e.message);
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: "catalog" });
  }
};
