/* NT Kross — сервер мини-приложения.
   Отдаёт index.html, берёт каталог из BILLZ и принимает заказы.
   Ключ BILLZ живёт только здесь (в .env), в браузер он не попадает.
   Запуск: node server.js  (Node 18+, без зависимостей) */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* ===== Настройки из .env ===== */
loadEnv(path.join(__dirname, ".env"));
const CFG = {
  port: +process.env.PORT || 3000,
  billzToken: process.env.BILLZ_SECRET_TOKEN || "",
  billzHost: process.env.BILLZ_HOST || "https://api-admin.billz.ai",
  shopId: process.env.BILLZ_SHOP_ID || "",                 // пусто = первый магазин компании
  createOrders: process.env.BILLZ_CREATE_ORDERS === "1",   // создавать черновик заказа в BILLZ
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",          // бот, который пишет менеджеру
  managerChat: process.env.TELEGRAM_MANAGER_CHAT_ID || "", // чат/группа менеджера
  refreshMs: (+process.env.CATALOG_REFRESH_MIN || 3) * 60e3,  // как часто подтягивать изменения
  fullMs: (+process.env.CATALOG_FULL_MIN || 60) * 60e3,       // как часто перечитывать весь каталог
  ordersLog: path.join(__dirname, "orders.jsonl"),
};
if (!CFG.billzToken) { console.error("BILLZ_SECRET_TOKEN не задан в .env"); process.exit(1); }

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  });
}

/* ===== BILLZ API ===== */
let access = null;
async function billzLogin() {
  const r = await fetch(CFG.billzHost + "/v1/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret_token: CFG.billzToken }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.data || !j.data.access_token) throw new Error("BILLZ auth failed: HTTP " + r.status);
  access = j.data.access_token;
}
async function billz(method, p, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!access) await billzLogin();
    const r = await fetch(CFG.billzHost + p, {
      method, body: body && JSON.stringify(body),
      headers: { Authorization: "Bearer " + access, "Content-Type": "application/json" },
    });
    if (r.status === 401 && attempt === 0) { access = null; continue; } // токен истёк — входим заново
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error("BILLZ " + method + " " + p + ": " + ((j.error && j.error.message) || "HTTP " + r.status));
    return j;
  }
}

/* ===== Каталог =====
   В BILLZ каждая пара — отдельный товар, размер записан в названии:
   "Jordan 5 qora 46r152k" → модель "Jordan 5 qora", размер 46.
   Пары одной модели объединяем по артикулу (sku) + названию модели. */
/* названия набирают вручную и с опечатками — бренд узнаём по ключевым словам */
const BRANDS = [
  [/\b(jordan|travis)\b/, "Jordan"],
  [/\b(nike|neki|sb|dunk|air ?max|force|forse|zoom|vomero|pegasus|peg|ja|kd|lebron|react|acg|p ?6000|kayri|harden)\b/, "Nike"],
  [/\b(adidas|adidias|adizero|yeezy|samba|campus|superstar|boost)\b/, "Adidas"],
  [/\b(new ?balans?e?|nb|530|9060|2002r?)\b/, "New Balance"],
  [/\b(asics|onitsuka)\b/, "Asics"], [/\bpuma\b/, "Puma"], [/\bvans\b/, "Vans"], [/\bhumtto\b/, "Humtto"],
  [/\bskechers\b/, "Skechers"], [/\bcrocs\b/, "Crocs"], [/\breebok\b/, "Reebok"], [/\bsala?mon\b/, "Salomon"],
  [/\bon\b/, "On"], [/\becco\b/, "Ecco"], [/\btimberland\b/, "Timberland"], [/\bcla?rk'?c?s\b/, "Clarks"],
];

function parseName(name) {
  const n = String(name || "");
  const m = n.match(/(^|[^\d.])(3[3-9]|4\d)([.,]5)?\s*r/i) || n.match(/(^|[^\d.])(3[3-9]|4\d)([.,]5)?\s*v/i);
  if (!m) return null;
  const model = n.slice(0, m.index + m[1].length).replace(/\s+/g, " ").trim();
  return model ? { model, size: m[2] + (m[3] ? ".5" : "") } : null;
}
function brandOf(model, brandName) {
  const s = (brandName + " " + model).toLowerCase();
  for (const [re, v] of BRANDS) if (re.test(s)) return v;
  return "Другое";
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

let catalog = { products: [], pairs: new Map(), updated: null };
const raw = new Map(); // id товара BILLZ → товар
let loading = null, lastFull = 0;

/* BILLZ отдаёт не дальше 10 000 товаров на один запрос (page × limit), а товаров больше.
   Поэтому полный проход идёт поиском по размеру: "33" … "49" — каждый такой срез меньше лимита,
   а вместе они покрывают все товары с размером в названии. */
const PAGE = 500;
async function fetchPages(query) {
  const out = [];
  for (let page = 1; ; page++) {
    const j = await billz("GET", "/v2/products?limit=" + PAGE + "&page=" + page + (query ? "&" + query : ""));
    const list = j.products || [];
    out.push(...list);
    if (list.length < PAGE || page * PAGE >= (j.count || 0) || page * PAGE >= 10000) return out;
  }
}
async function fullScan() {
  const sizes = [];
  for (let s = 33; s <= 49; s++) sizes.push(String(s));
  const seen = new Map();
  // по два запроса одновременно — на больший поток BILLZ отвечает блокировкой
  for (let i = 0; i < sizes.length; i += 2) {
    const parts = await Promise.all(sizes.slice(i, i + 2).map(s => fetchPages("search=" + s)));
    parts.forEach(list => list.forEach(x => seen.set(x.id, x)));
  }
  raw.clear();
  seen.forEach((x, id) => raw.set(id, x));
  lastFull = Date.now();
}
async function incremental() {
  // всё, что менялось со вчерашнего дня: продажи, приход, новые цены
  const d = new Date(Date.now() - 864e5), p = n => String(n).padStart(2, "0");
  const since = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " 00:00:00";
  (await fetchPages("last_updated_date=" + encodeURIComponent(since))).forEach(x => raw.set(x.id, x));
}
/* Живая проверка остатка конкретного товара перед заказом */
async function liveStock(pid, name) {
  const j = await billz("GET", "/v2/products?limit=50&page=1&search=" + encodeURIComponent(name));
  const x = (j.products || []).find(p => p.id === pid);
  if (!x) return 0;
  raw.set(x.id, x);
  const v = (x.shop_measurement_values || []).find(m => m.shop_id === CFG.shopId);
  return v ? v.active_measurement_value : 0;
}
async function resolveShop() {
  if (CFG.shopId) return;
  const j = await billz("GET", "/v1/shop?limit=50");
  if (!j.shops || !j.shops.length) throw new Error("В BILLZ нет магазинов");
  CFG.shopId = j.shops[0].id;
  console.log("Магазин BILLZ:", j.shops[0].name, CFG.shopId);
}
async function buildCatalog() {
  await resolveShop();
  if (!raw.size || Date.now() - lastFull > CFG.fullMs) await fullScan(); else await incremental();
  const models = new Map(), pairs = new Map();
  for (const x of raw.values()) {
    const stock = (x.shop_measurement_values || []).find(v => v.shop_id === CFG.shopId);
    const price = (x.shop_prices || []).find(v => v.shop_id === CFG.shopId);
    if (!stock || stock.active_measurement_value <= 0 || !price || !(price.retail_price > 0)) continue;
    const pn = parseName(x.name);
    if (!pn) continue;
    const key = (x.sku || "") + "|" + pn.model.toLowerCase();
    const id = crypto.createHash("sha1").update(key).digest("hex").slice(0, 10);
    let m = models.get(id);
    if (!m) { m = { id, names: {}, brand: x.brand_name, sizes: {}, imgs: [], latest: "" }; models.set(id, m); }
    m.names[pn.model] = (m.names[pn.model] || 0) + 1;
    if (x.updated_at > m.latest) m.latest = x.updated_at;
    const sale = price.promo_price > 0 && price.promo_price < price.retail_price ? price.promo_price : price.retail_price;
    const sz = m.sizes[pn.size] || (m.sizes[pn.size] = { qty: 0, price: sale, units: [] });
    sz.qty += stock.active_measurement_value;
    sz.price = Math.min(sz.price, sale);
    sz.units.push({ pid: x.id, name: x.name, qty: stock.active_measurement_value, price: sale });
    const photos = (x.photos || []).slice().sort((a, b) => (b.is_main - a.is_main) || (a.sequence - b.sequence)).map(f => f.photo_url);
    if (!photos.length && x.main_image_url) photos.push(x.main_image_url);
    photos.forEach(u => { if (u && m.imgs.length < 8 && m.imgs.indexOf(u) < 0) m.imgs.push(u); });
  }
  const products = [];
  for (const m of models.values()) {
    const name = cap(Object.entries(m.names).sort((a, b) => b[1] - a[1])[0][0]);
    const sizes = Object.keys(m.sizes).sort((a, b) => a - b);
    const ps = {}, qty = {};
    sizes.forEach(s => { ps[s] = m.sizes[s].price; qty[s] = m.sizes[s].qty; pairs.set(m.id + "|" + s, { name, ...m.sizes[s] }); });
    products.push({ id: m.id, name, tag: brandOf(name, m.brand), price: Math.min(...Object.values(ps)), ps, qty, sizes, imgs: m.imgs, latest: m.latest });
  }
  // новые поступления сверху, без фото — в конец
  products.sort((a, b) => (!!b.imgs.length - !!a.imgs.length) || (a.latest < b.latest ? 1 : -1));
  products.forEach(p => delete p.latest);
  catalog = { products, pairs, updated: new Date().toISOString() };
  console.log("Каталог обновлён:", products.length, "моделей в наличии из", raw.size, "товаров BILLZ");
}
function refresh() {
  if (!loading) loading = buildCatalog().catch(e => console.error("Каталог:", e.message)).finally(() => { loading = null; });
  return loading;
}

/* ===== Заказ ===== */
function checkInitData(initData) {
  // Проверка подписи Telegram: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
  if (!initData || !CFG.botToken) return null;
  const q = new URLSearchParams(initData), hash = q.get("hash");
  q.delete("hash");
  const dcs = [...q.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + "=" + v).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(CFG.botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  if (!hash || calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return false;
  try { return JSON.parse(q.get("user") || "null") || {}; } catch { return {}; }
}
function newOrderNo() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + p(d.getDate()) + "-" + crypto.randomInt(1000, 10000);
}
function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " сум"; }
const PAY_RU = { cash: "наличные", payme: "Payme", click: "Click" };

function orderMessage(o) {
  return ["🛒 Новый заказ №" + o.no].concat(
    o.items.map(i => "• " + i.name + " · размер " + i.size + " × " + i.qty + " — " + fmt(i.sum) +
      "\n   BILLZ: " + i.units.map(u => u.name).join("; ")),
    ["Итого: " + fmt(o.total), "Клиент: " + o.name, "Телефон: " + o.phone,
      "Получение: " + (o.delivery === "deliv" ? "доставка" + (o.addr ? ", " + o.addr : "") : "самовывоз"),
      "Оплата: " + PAY_RU[o.pay]],
    o.tgUser ? ["Telegram: " + (o.tgUser.username ? "@" + o.tgUser.username : "id " + o.tgUser.id)] : [],
    o.billzOrderId ? ["Черновик в BILLZ: " + o.billzOrderId] : []
  ).join("\n");
}
async function notifyManager(o) {
  if (!CFG.botToken || !CFG.managerChat) return false;
  const r = await fetch("https://api.telegram.org/bot" + CFG.botToken + "/sendMessage", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CFG.managerChat, text: orderMessage(o) }),
  });
  if (!r.ok) throw new Error("Telegram sendMessage: HTTP " + r.status);
  return true;
}
function normPhone(p) {
  const d = String(p).replace(/\D/g, "");
  return d.length === 9 ? "998" + d : d;
}
async function billzDraftOrder(o) {
  // черновик заказа: товары + клиент, без оплаты — менеджер проводит продажу в BILLZ сам
  const phone = normPhone(o.phone);
  const found = await billz("GET", "/v1/client?limit=1&phone_number=" + encodeURIComponent(phone));
  let clientId = found.clients && found.clients[0] && found.clients[0].id;
  if (!clientId) {
    const c = await billz("POST", "/v1/client", { first_name: o.name, phone_number: phone, chat_id: o.tgUser ? String(o.tgUser.id) : undefined });
    clientId = c.id;
  }
  const rpc = (method, params) => billz("POST", "/v1/orders", { method, params });
  const orderId = (await rpc("order.create", { shop_id: CFG.shopId })).result;
  if (!orderId) throw new Error("BILLZ order.create: пустой ответ");
  for (const i of o.items) for (const u of i.units) await rpc("order.add_item", { order_id: orderId, product_id: u.pid, measurement_value: u.take });
  await rpc("order.add_customer", { order_id: orderId, customer_id: clientId });
  return orderId;
}

/* простое ограничение: не больше 10 заказов за 10 минут с одного IP */
const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 600e3);
  list.push(now); hits.set(ip, list);
  return list.length > 10;
}

async function placeOrder(body, ip) {
  const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
  const name = str(body.name, 60), phone = str(body.phone, 30), addr = str(body.addr, 200);
  const delivery = body.delivery === "deliv" ? "deliv" : "pickup";
  const pay = PAY_RU[body.pay] ? body.pay : "cash";
  if (!name || phone.replace(/\D/g, "").length < 9) return [400, { error: "contacts" }];
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 20) return [400, { error: "items" }];
  if (limited(ip)) return [429, { error: "rate" }];

  const tgUser = checkInitData(body.initData);
  if (tgUser === false) return [403, { error: "initData" }];

  // цены и наличие берём только из каталога, не из браузера
  const items = [], soldOut = [];
  for (const it of body.items) {
    const pair = catalog.pairs.get(String(it.id) + "|" + String(it.size));
    const qty = Math.max(1, Math.min(10, parseInt(it.qty, 10) || 1));
    if (!pair || pair.qty < qty) { soldOut.push({ id: it.id, size: it.size }); continue; }
    // каталог может отставать на несколько минут — остаток каждой пары перепроверяем в BILLZ
    let left = qty; const units = [];
    for (const u of pair.units) {
      if (!left) break;
      const have = await liveStock(u.pid, u.name);
      const take = Math.min(have, left);
      if (take > 0) { units.push({ pid: u.pid, name: u.name, take }); left -= take; }
    }
    if (left > 0) { soldOut.push({ id: it.id, size: it.size }); continue; }
    items.push({ id: it.id, name: pair.name, size: String(it.size), qty, price: pair.price, sum: pair.price * qty, units });
  }
  if (soldOut.length) { refresh(); return [409, { error: "stock", soldOut }]; }

  const o = { no: newOrderNo(), created: new Date().toISOString(), lang: body.lang === "uz" ? "uz" : "ru",
    items, total: items.reduce((a, i) => a + i.sum, 0), name, phone, delivery, addr: delivery === "deliv" ? addr : "", pay,
    tgUser: tgUser ? { id: tgUser.id, username: tgUser.username || "" } : null };

  if (CFG.createOrders) {
    try { o.billzOrderId = await billzDraftOrder(o); } catch (e) { o.billzError = e.message; console.error("BILLZ заказ:", e.message); }
  }
  let notified = false;
  try { notified = await notifyManager(o); } catch (e) { o.notifyError = e.message; console.error("Telegram:", e.message); }
  fs.appendFileSync(CFG.ordersLog, JSON.stringify(o) + "\n");
  console.log("Заказ", o.no, fmt(o.total), notified ? "→ менеджеру" : "(без уведомления)");
  return [200, { no: o.no, total: o.total, notified }];
}

/* ===== HTTP ===== */
const STATIC = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };
function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(type ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 64e3) { fail(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/catalog" && req.method === "GET") {
      if (!catalog.updated) await refresh();
      if (!catalog.updated) return send(res, 503, { error: "catalog" });
      return send(res, 200, { updated: catalog.updated, products: catalog.products });
    }
    if (url.pathname === "/api/order" && req.method === "POST") {
      if (!catalog.updated) await refresh();
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "json" }); }
      const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      const [code, out] = await placeOrder(body || {}, ip);
      return send(res, code, out);
    }
    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const ext = path.extname(rel).toLowerCase();
      const file = path.join(__dirname, rel);
      const allowed = rel === "index.html" || (rel.startsWith("img/") && STATIC[ext]);
      if (allowed && file.startsWith(__dirname + path.sep) && fs.existsSync(file)) return send(res, 200, fs.readFileSync(file), STATIC[ext]);
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(req.method, url.pathname, e);
    send(res, 500, { error: "server" });
  }
});

if (require.main === module) {
  server.listen(CFG.port, () => console.log("NT Kross: http://localhost:" + CFG.port));
  refresh();
  setInterval(refresh, CFG.refreshMs).unref();
}
module.exports = { parseName, brandOf, checkInitData, placeOrder, server, _setCatalog: c => { catalog = c; } };
