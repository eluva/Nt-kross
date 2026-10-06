/* Vercel: POST /api/click — адрес Prepare и Complete для Click (указывается в кабинете Click Merchant) */
const click = require("../lib/click");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  let body = req.body;
  if (typeof body === "string") body = Object.fromEntries(new URLSearchParams(body));
  res.status(200).json(await click.handle(body || {}));
};
