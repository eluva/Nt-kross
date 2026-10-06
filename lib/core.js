/* NT Kross — общая логика: BILLZ, каталог, заказы.
   Используется и локальным server.js, и функциями Vercel в api/.
   Ключ BILLZ и токен бота берутся из переменных окружения и в браузер не попадают. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* ===== Настройки ===== */
loadEnv(path.join(__dirname, "..", ".env"));
const CFG = {
  billzToken: process.env.BILLZ_SECRET_TOKEN || "",
  billzHost: process.env.BILLZ_HOST || "https://api-admin.billz.ai",
  shopId: process.env.BILLZ_SHOP_ID || "",                 // пусто = первый магазин компании
  createOrders: process.env.BILLZ_CREATE_ORDERS === "1",   // создавать черновик заказа в BILLZ (не проверено)
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",          // бот, который пишет менеджеру
  managerChat: process.env.TELEGRAM_MANAGER_CHAT_ID || "", // чат/группа менеджера
  refreshMs: (+process.env.CATALOG_REFRESH_MIN || 3) * 60e3,  // как часто подтягивать изменения
  fullMs: (+process.env.CATALOG_FULL_MIN || 60) * 60e3,       // как часто перечитывать весь каталог
  ordersLog: process.env.ORDERS_LOG || "",                    // файл для заказов (только локально)
};

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
  if (!CFG.billzToken) throw new Error("BILLZ_SECRET_TOKEN не задан");
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
    if (!r.ok || j.error) throw new Error("BILLZ " + method + " " + p.split("?")[0] + ": " + ((j.error && j.error.message) || "HTTP " + r.status));
    return j;
  }
}
async function resolveShop() {
  if (CFG.shopId) return;
  const j = await billz("GET", "/v1/shop?limit=50");
  if (!j.shops || !j.shops.length) throw new Error("В BILLZ нет магазинов");
  CFG.shopId = j.shops[0].id;
}
const stockOf = x => { const v = (x.shop_measurement_values || []).find(m => m.shop_id === CFG.shopId); return v ? v.active_measurement_value : 0; };
function priceOf(x) {
  const p = (x.shop_prices || []).find(v => v.shop_id === CFG.shopId);
  if (!p || !(p.retail_price > 0)) return 0;
  return p.promo_price > 0 && p.promo_price < p.retail_price ? p.promo_price : p.retail_price;
}

/* ===== Названия =====
   В BILLZ каждая пара — отдельный товар, размер записан в названии:
   "Jordan 5 qora 46r152k" → модель "Jordan 5 qora", размер 46.
   Остаток названия (152k) — служебная пометка, клиенту не показываем. */
function parseName(name) {
  const n = String(name || "");
  const m = n.match(/(^|[^\d.])(3[3-9]|4\d)([.,]5)?\s*r/i) || n.match(/(^|[^\d.])(3[3-9]|4\d)([.,]5)?\s*v/i);
  if (!m) return null;
  const model = n.slice(0, m.index + m[1].length).replace(/\s+/g, " ").trim();
  return model ? { model, size: m[2] + (m[3] ? ".5" : "") } : null;
}
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
function brandOf(model, brandName) {
  const s = ((brandName || "") + " " + model).toLowerCase();
  for (const [re, v] of BRANDS) if (re.test(s)) return v;
  return "Другое";
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/* ===== Каталог =====
   BILLZ отдаёт не дальше 10 000 товаров на запрос (page × limit), а товаров больше.
   Поэтому полный проход идёт поиском по размеру: "33" … "49" — каждый срез меньше лимита,
   а вместе они покрывают все товары с размером в названии. */
const PAGE = 500;
const raw = new Map(); // id товара BILLZ → товар
let cache = null, lastFull = 0, lastBuild = 0, loading = null;

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

/* Пары одной модели объединяем по артикулу (sku) + названию модели.
   Для каждого размера отдаём штрихкоды пар — по ним заказ перепроверяется в BILLZ. */
function buildFromRaw() {
  const models = new Map();
  for (const x of raw.values()) {
    const qty = stockOf(x), price = priceOf(x), pn = parseName(x.name);
    if (qty <= 0 || !price || !pn || !x.barcode) continue;
    const id = crypto.createHash("sha1").update((x.sku || "") + "|" + pn.model.toLowerCase()).digest("hex").slice(0, 10);
    let m = models.get(id);
    if (!m) { m = { id, names: {}, brand: x.brand_name, sizes: {}, imgs: [], latest: "" }; models.set(id, m); }
    m.names[pn.model] = (m.names[pn.model] || 0) + 1;
    if (x.updated_at > m.latest) m.latest = x.updated_at;
    const sz = m.sizes[pn.size] || (m.sizes[pn.size] = { qty: 0, price, bc: [] });
    sz.qty += qty; sz.price = Math.min(sz.price, price); sz.bc.push(x.barcode);
    const photos = (x.photos || []).slice().sort((a, b) => (b.is_main - a.is_main) || (a.sequence - b.sequence)).map(f => f.photo_url);
    if (!photos.length && x.main_image_url) photos.push(x.main_image_url);
    photos.forEach(u => { if (u && m.imgs.length < 8 && m.imgs.indexOf(u) < 0) m.imgs.push(u); });
  }
  const products = [];
  for (const m of models.values()) {
    const name = cap(Object.entries(m.names).sort((a, b) => b[1] - a[1])[0][0]);
    const sizes = Object.keys(m.sizes).sort((a, b) => a - b);
    const ps = {}, qty = {}, bc = {};
    sizes.forEach(s => { ps[s] = m.sizes[s].price; qty[s] = m.sizes[s].qty; bc[s] = m.sizes[s].bc; });
    products.push({ id: m.id, name, tag: brandOf(name, m.brand), price: Math.min(...Object.values(ps)), ps, qty, bc, sizes, imgs: m.imgs, latest: m.latest });
  }
  // новые поступления сверху, без фото — в конец
  products.sort((a, b) => (!!b.imgs.length - !!a.imgs.length) || (a.latest < b.latest ? 1 : -1));
  products.forEach(p => delete p.latest);
  return { updated: new Date().toISOString(), products };
}
async function rebuild() {
  await resolveShop();
  if (!raw.size || Date.now() - lastFull > CFG.fullMs) await fullScan(); else await incremental();
  cache = buildFromRaw();
  lastBuild = Date.now();
  console.log("Каталог обновлён:", cache.products.length, "моделей в наличии из", raw.size, "товаров BILLZ");
}
/* Каталог из памяти; если устарел — обновляем (при первом запросе ждём полный проход) */
async function getCatalog() {
  if (cache && Date.now() - lastBuild < CFG.refreshMs) return cache;
  if (!loading) loading = rebuild().catch(e => console.error("Каталог:", e.message)).finally(() => { loading = null; });
  if (!cache) await loading;
  if (!cache) throw new Error("catalog unavailable");
  return cache;
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
const fmt = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " сум";
const PAY_RU = { cash: "наличные", payme: "Payme", click: "Click" };

function orderMessage(o) {
  return ["🛒 Новый заказ №" + o.no].concat(
    o.items.map(i => "• " + i.name + " · размер " + i.size + " × " + i.qty + " — " + fmt(i.sum) +
      "\n   BILLZ: " + i.units.map(u => u.name + " (" + u.barcode + ")").join("; ")),
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
/* Живая проверка пары по штрихкоду: товар, остаток и цена прямо из BILLZ */
async function liveByBarcode(code) {
  const j = await billz("GET", "/v2/products?limit=5&page=1&search=" + encodeURIComponent(code));
  return (j.products || []).find(x => x.barcode === code) || null;
}

/* простое ограничение: не больше 10 заказов за 10 минут с одного IP (в пределах одного экземпляра) */
const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 600e3);
  list.push(now); hits.set(ip, list);
  return list.length > 10;
}

/* Возвращает [HTTP-код, ответ] */
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

  await resolveShop();
  // цены и наличие берём только из BILLZ, не из браузера
  const items = [], soldOut = [];
  for (const it of body.items) {
    const size = str(it.size, 6), qty = Math.max(1, Math.min(10, parseInt(it.qty, 10) || 1));
    const codes = (Array.isArray(it.bc) ? it.bc : []).map(c => str(c, 32)).filter(c => /^\d{6,20}$/.test(c)).slice(0, 10);
    let left = qty, sum = 0, model = ""; const units = [];
    for (const code of codes) {
      if (!left) break;
      const x = await liveByBarcode(code);
      const pn = x && parseName(x.name), price = x && priceOf(x);
      if (!x || !pn || pn.size !== size || !price) continue;
      const take = Math.min(stockOf(x), left);
      if (take <= 0) continue;
      units.push({ pid: x.id, barcode: code, name: x.name, take });
      model = model || cap(pn.model); sum += price * take; left -= take;
    }
    if (left > 0) { soldOut.push({ id: it.id, size }); continue; }
    items.push({ id: str(it.id, 20), name: model, size, qty, sum, units });
  }
  if (soldOut.length) { lastBuild = 0; return [409, { error: "stock", soldOut }]; }

  const o = { no: newOrderNo(), created: new Date().toISOString(), lang: body.lang === "uz" ? "uz" : "ru",
    items, total: items.reduce((a, i) => a + i.sum, 0), name, phone, delivery, addr: delivery === "deliv" ? addr : "", pay,
    tgUser: tgUser ? { id: tgUser.id, username: tgUser.username || "" } : null };

  if (CFG.createOrders) {
    try { o.billzOrderId = await billzDraftOrder(o); } catch (e) { o.billzError = e.message; console.error("BILLZ заказ:", e.message); }
  }
  let notified = false;
  try { notified = await notifyManager(o); } catch (e) { o.notifyError = e.message; console.error("Telegram:", e.message); }
  // журнал заказа: в логах Vercel / в файле при локальном запуске
  console.log("ORDER " + JSON.stringify(o));
  if (CFG.ordersLog) fs.appendFileSync(CFG.ordersLog, JSON.stringify(o) + "\n");
  return [200, { no: o.no, total: o.total, notified }];
}

module.exports = { CFG, getCatalog, placeOrder, parseName, brandOf, checkInitData };
