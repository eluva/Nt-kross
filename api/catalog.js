/* Vercel: GET /api/catalog — каталог в наличии из BILLZ.
   CDN держит ответ 3 минуты и ещё сутки отдаёт старый, пока обновляется новый. */
const { getCatalog } = require("../lib/core");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "method" });
  try {
    const c = await getCatalog();
    res.setHeader("Cache-Control", "public, s-maxage=180, stale-while-revalidate=86400");
    res.status(200).json(c);
  } catch (e) {
    console.error("catalog:", e.message);
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: "catalog" });
  }
};
