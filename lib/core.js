/* NT Kross — общая логика: BILLZ, каталог, заказы.
   Используется и локальным server.js, и функциями Vercel в api/.
   Ключ BILLZ и токен бота берутся из переменных окружения и в браузер не попадают. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const store = require("./store");
/* На Vercel: waitUntil — работа продолжается после ответа; getCache — Runtime Cache, хранилище без настройки */
let vf = null;
if (process.env.VERCEL) { try { vf = require("@vercel/functions"); } catch (e) { console.error("@vercel/functions:", e.message); } }
const background = p => { try { if (vf) vf.waitUntil(p); } catch {} return p; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ===== Настройки ===== */
loadEnv(path.join(__dirname, "..", ".env"));
const CFG = {
  billzToken: process.env.BILLZ_SECRET_TOKEN || "",
  billzHost: process.env.BILLZ_HOST || "https://api-admin.billz.ai",
  shopId: process.env.BILLZ_SHOP_ID || "",                 // пусто = первый магазин компании
  createOrders: process.env.BILLZ_CREATE_ORDERS === "1",   // проводить оплаченные заказы продажей в BILLZ (не проверено)
  // способ оплаты в BILLZ для онлайн-оплат; по умолчанию «Карта»
  billzPayType: { payme: process.env.BILLZ_PAYTYPE_PAYME || "", click: process.env.BILLZ_PAYTYPE_CLICK || "" },
  appUrl: (process.env.APP_URL || "https://nt-kross.vercel.app").replace(/\/$/, ""),
  payme: { merchantId: process.env.PAYME_MERCHANT_ID || "", key: process.env.PAYME_KEY || "", test: process.env.PAYME_TEST === "1" },
  click: { serviceId: process.env.CLICK_SERVICE_ID || "", merchantId: process.env.CLICK_MERCHANT_ID || "", secretKey: process.env.CLICK_SECRET_KEY || "" },
  orderTtlMin: +process.env.ORDER_PAY_MIN || 30,              // сколько минут ждём начала оплаты
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
/* цена без скидки — только если сейчас действует промо-цена */
function oldPriceOf(x) {
  const p = (x.shop_prices || []).find(v => v.shop_id === CFG.shopId);
  return p && p.promo_price > 0 && p.promo_price < p.retail_price ? p.retail_price : 0;
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
   а вместе они покрывают все товары с размером в названии.
   Полный проход долгий (~120 запросов, около минуты), поэтому база товаров хранится снимком
   (Redis на Vercel, файл локально): холодный старт берёт снимок и догружает только изменения. */
const PAGE = 500;
const raw = new Map(); // id товара BILLZ → компактная запись (только то, что нужно витрине)
let cache = null, lastFull = 0, lastSync = 0, lastSnap = 0, lastBuild = 0, loading = null;
let scanning = null; // база, которую сейчас собирает полный проход, — из неё отдаём то, что уже готово

/* Подборки для витрины — из тех же данных BILLZ:
   хиты — каждая пара в BILLZ отдельный товар, поэтому пара с нулевым остатком,
          изменённая за последние HIT_DAYS дней, почти всегда продана; считаем такие пары по моделям;
   новинки — все пары модели в наличии появились/менялись за последние NEW_DAYS дней;
   скидки — действующая промо-цена в BILLZ. */
const HIT_DAYS = 30, HIT_TOP = 12, HIT_MIN = 2, NEW_DAYS = 14, NEW_TOP = 24;
const dayStr = days => new Date(Date.now() - days * 864e5).toISOString().slice(0, 19).replace("T", " ");

async function fetchPages(query) {
  const out = [];
  for (let page = 1; ; page++) {
    const j = await billz("GET", "/v2/products?limit=" + PAGE + "&page=" + page + (query ? "&" + query : ""));
    const list = j.products || [];
    out.push(...list);
    if (list.length < PAGE || page * PAGE >= (j.count || 0)) return out;
    if (page * PAGE >= 10000) { out.truncated = true; return out; } // дальше BILLZ не отдаёт
  }
}
/* компактная запись: остаток, цены и фото — уже для нашего магазина */
function compact(x) {
  const c = { id: x.id, name: x.name || "", sku: x.sku || "", brand: x.brand_name || "", bc: x.barcode || "", at: x.updated_at || "",
    q: stockOf(x), p: priceOf(x), o: oldPriceOf(x) };
  if (c.q > 0) {
    const ph = (x.photos || []).slice().sort((a, b) => (b.is_main - a.is_main) || (a.sequence - b.sequence)).map(f => f.photo_url).filter(Boolean);
    if (!ph.length && x.main_image_url) ph.push(x.main_image_url);
    if (ph.length) c.ph = ph.slice(0, 8);
  }
  return c;
}
/* храним только пары в наличии и недавно проданные (для хитов) — остальное витрине не нужно */
const keep = c => !!parseName(c.name) && (c.q > 0 || c.at >= dayStr(HIT_DAYS));
function put(map, x) { const c = compact(x); if (keep(c)) map.set(c.id, c); else map.delete(c.id); }

async function fullScan() {
  // ходовые размеры первыми — если проход ещё идёт, витрина из готовых срезов уже почти полная
  const started = Date.now(), queue = ["41", "42", "40", "43", "44", "39", "38", "45", "37", "36", "46", "47", "35", "48", "34", "49", "33"];
  const fresh = scanning = new Map();
  // два потока — на больший BILLZ отвечает блокировкой; каждый берёт следующий срез, как только освободится
  const worker = async () => { while (queue.length) (await fetchPages("search=" + queue.shift())).forEach(x => put(fresh, x)); };
  try { await Promise.all([worker(), worker()]); } finally { scanning = null; }
  raw.clear();
  fresh.forEach((c, id) => raw.set(id, c));
  lastFull = lastSync = started;
}
/* всё, что менялось с прошлой синхронизации: продажи, приход, новые цены.
   Запас — сутки: часовые пояса BILLZ и сервера могут не совпадать. false — изменений больше, чем BILLZ отдаёт за раз */
async function incremental() {
  const started = Date.now(), d = new Date(lastSync - 864e5), p = n => String(n).padStart(2, "0");
  const since = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":00";
  const list = await fetchPages("last_updated_date=" + encodeURIComponent(since));
  if (list.truncated) return false;
  list.forEach(x => put(raw, x));
  lastSync = started;
  return true;
}

/* ===== Снимок базы товаров =====
   Несколько тысяч компактных записей, gzip + base64 (~0,5 МБ). Где хранится:
   Redis, если подключён; иначе на Vercel — Runtime Cache (без настройки, но может быть вытеснен); локально — файл. */
const SNAP_KEY = "ntkross:catalog:snap:v1", SNAP_FILE = path.join(__dirname, "..", ".cache", "catalog.snap");
const SNAP_MAX_AGE = 7 * 864e5, SNAP_EVERY = 10 * 60e3;
const snapWhere = store.remote ? "redis" : vf && vf.getCache ? "runtime" : !process.env.VERCEL ? "file" : "";
async function saveSnapshot() {
  if (!snapWhere) return;
  const at = Date.now();
  const body = zlib.gzipSync(JSON.stringify({ shop: CFG.shopId, full: lastFull, sync: lastSync, at, items: [...raw.values()] })).toString("base64");
  if (snapWhere === "redis") await store.set(SNAP_KEY, body, SNAP_MAX_AGE / 1000);
  else if (snapWhere === "runtime") await vf.getCache().set(SNAP_KEY, body, { ttl: SNAP_MAX_AGE / 1000, name: "catalog snapshot" });
  else { fs.mkdirSync(path.dirname(SNAP_FILE), { recursive: true }); fs.writeFileSync(SNAP_FILE, body); }
  lastSnap = at;
}
async function restoreSnapshot() {
  try {
    const body = snapWhere === "redis" ? await store.get(SNAP_KEY)
      : snapWhere === "runtime" ? await vf.getCache().get(SNAP_KEY)
      : snapWhere === "file" && fs.existsSync(SNAP_FILE) ? fs.readFileSync(SNAP_FILE, "utf8") : null;
    if (!body) return false;
    const s = JSON.parse(zlib.gunzipSync(Buffer.from(body, "base64")));
    if (s.shop !== CFG.shopId || !Array.isArray(s.items) || Date.now() - s.sync > SNAP_MAX_AGE) return false;
    raw.clear();
    s.items.forEach(c => raw.set(c.id, c));
    lastFull = s.full; lastSync = s.sync; lastSnap = s.at;
    return true;
  } catch (e) { console.error("Снимок каталога:", e.message); return false; }
}

/* Пары одной модели объединяем по артикулу (sku) + названию модели.
   Для каждого размера отдаём штрихкоды пар — по ним заказ перепроверяется в BILLZ. */
function buildFromRaw(src = raw) {
  const models = new Map(), sold = new Map(), hitSince = dayStr(HIT_DAYS), newSince = dayStr(NEW_DAYS);
  for (const x of src.values()) {
    const pn = parseName(x.name);
    if (!pn) continue;
    const id = crypto.createHash("sha1").update(x.sku + "|" + pn.model.toLowerCase()).digest("hex").slice(0, 10);
    if (x.q <= 0) { if (x.at >= hitSince) sold.set(id, (sold.get(id) || 0) + 1); continue; }
    if (!x.p || !x.bc) continue;
    let m = models.get(id);
    if (!m) { m = { id, names: {}, brand: x.brand, sizes: {}, imgs: [], latest: "", first: "9" }; models.set(id, m); }
    m.names[pn.model] = (m.names[pn.model] || 0) + 1;
    if (x.at > m.latest) m.latest = x.at;
    if (x.at < m.first) m.first = x.at;
    const sz = m.sizes[pn.size] || (m.sizes[pn.size] = { qty: 0, price: x.p, old: 0, bc: [] });
    // цена размера — самая низкая из пар; старая цена — у той же пары, если на неё действует промо
    if (x.p < sz.price) { sz.price = x.p; sz.old = x.o; } else if (x.p === sz.price) sz.old = Math.max(sz.old, x.o);
    sz.qty += x.q; sz.bc.push(x.bc);
    (x.ph || []).forEach(u => { if (m.imgs.length < 8 && m.imgs.indexOf(u) < 0) m.imgs.push(u); });
  }
  const products = [];
  for (const m of models.values()) {
    const name = cap(Object.entries(m.names).sort((a, b) => b[1] - a[1])[0][0]);
    const sizes = Object.keys(m.sizes).sort((a, b) => a - b);
    const ps = {}, qty = {}, bc = {}, old = {};
    let off = 0;
    sizes.forEach(s => {
      const z = m.sizes[s];
      ps[s] = z.price; qty[s] = z.qty; bc[s] = z.bc;
      if (z.old > z.price) { old[s] = z.old; off = Math.max(off, Math.round((1 - z.price / z.old) * 100)); }
    });
    const p = { id: m.id, name, tag: brandOf(name, m.brand), price: Math.min(...Object.values(ps)), ps, qty, bc, sizes, imgs: m.imgs, latest: m.latest, first: m.first };
    if (off > 0) { p.old = old; p.off = off; }
    const s = sold.get(m.id) || 0;
    if (s >= HIT_MIN) p.sold = s; // пар продано за HIT_DAYS дней
    products.push(p);
  }
  // хиты — самые продаваемые модели с фото; новинки — самые свежие модели, где все пары пришли недавно
  products.filter(p => p.sold && p.imgs.length).sort((a, b) => b.sold - a.sold).slice(0, HIT_TOP).forEach(p => { p.hit = true; });
  products.filter(p => p.first >= newSince && !p.hit).sort((a, b) => (a.first < b.first ? 1 : -1)).slice(0, NEW_TOP).forEach(p => { p.fresh = true; });
  // новые поступления сверху, без фото — в конец
  products.sort((a, b) => (!!b.imgs.length - !!a.imgs.length) || (a.latest < b.latest ? 1 : -1));
  products.forEach(p => { delete p.latest; delete p.first; });
  return { updated: new Date().toISOString(), products };
}
async function rebuild() {
  await resolveShop();
  // холодный старт со снимком — только изменения, ответ за секунды; полный проход — при следующих обновлениях
  const restored = !raw.size && await restoreSnapshot();
  let full = !raw.size || (!restored && Date.now() - lastFull > CFG.fullMs);
  if (!full && !(await incremental())) full = true;
  if (full) await fullScan();
  for (const c of raw.values()) if (!keep(c)) raw.delete(c.id); // проданные больше HIT_DAYS дней назад
  cache = buildFromRaw();
  lastBuild = Date.now();
  console.log("Каталог обновлён" + (full ? " (полный проход)" : restored ? " (из снимка)" : "") + ":", cache.products.length, "моделей в наличии,", raw.size, "записей в базе");
  // после полного прохода снимок обязателен; после догрузки изменений — не чаще раза в 10 минут и без ожидания
  const snap = full || Date.now() - lastSnap > SNAP_EVERY ? saveSnapshot().catch(e => console.error("Снимок каталога:", e.message)) : null;
  if (full) await snap; else if (snap) background(snap);
}
/* Каталог из памяти; если устарел — обновляем фоном и отдаём текущий.
   Холодный старт без снимка (полный проход — минута и больше): ждём до COLD_WAIT, потом отдаём то, что уже собрано,
   с пометкой incomplete — приложение покажет это и спросит ещё раз. */
const COLD_WAIT = 10e3;
async function getCatalog() {
  if (cache && Date.now() - lastBuild < CFG.refreshMs) return cache;
  if (!loading) loading = rebuild().catch(e => console.error("Каталог:", e.message)).finally(() => { loading = null; });
  background(loading); // на Vercel обновление не замораживается после ответа
  if (cache) return cache;
  const pending = loading;
  await Promise.race([pending, sleep(scanning && scanning.size ? 1500 : COLD_WAIT)]);
  if (cache) return cache;
  if (scanning && scanning.size) {
    const part = buildFromRaw(scanning);
    if (part.products.length) return { ...part, incomplete: true };
  }
  await pending;
  if (!cache) throw new Error("catalog unavailable");
  return cache;
}
/* Ответ /api/catalog. limit — только первые N моделей: приложение показывает их сразу, пока грузится остальное */
async function catalogBody(limit) {
  const c = await getCatalog(), pay = { payme: payReady("payme"), click: payReady("click") };
  const n = Math.min(200, parseInt(limit, 10) || 0);
  if (n > 0 && n < c.products.length) return { updated: c.updated, total: c.products.length, partial: true, incomplete: c.incomplete, products: c.products.slice(0, n), pay };
  return { ...c, pay };
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

function orderMessage(o, title) {
  return [title || "🛒 Новый заказ №" + o.no].concat(
    o.items.map(i => "• " + i.name + " · размер " + i.size + " × " + i.qty + " — " + fmt(i.sum) +
      "\n   BILLZ: " + i.units.map(u => u.name + " (" + u.barcode + ")").join("; ")),
    ["Итого: " + fmt(o.total), "Клиент: " + o.name, "Телефон: " + o.phone,
      "Получение: " + (o.delivery === "deliv" ? "доставка" + (o.addr ? ", " + o.addr : "") : "самовывоз"),
      "Оплата: " + PAY_RU[o.pay]],
    o.tgUser ? ["Telegram: " + (o.tgUser.username ? "@" + o.tgUser.username : "id " + o.tgUser.id)] : [],
    o.billzOrderId ? ["Продажа в BILLZ: " + o.billzOrderId] : [],
    o.billzError ? ["⚠️ В BILLZ не проведено: " + o.billzError + " — проведите продажу вручную"] : []
  ).join("\n");
}
async function notifyManager(o, title) {
  if (!CFG.botToken || !CFG.managerChat) return false;
  const r = await fetch("https://api.telegram.org/bot" + CFG.botToken + "/sendMessage", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CFG.managerChat, text: orderMessage(o, title) }),
  });
  if (!r.ok) throw new Error("Telegram sendMessage: HTTP " + r.status);
  return true;
}
function normPhone(p) {
  const d = String(p).replace(/\D/g, "");
  return d.length === 9 ? "998" + d : d;
}
/* Оплаченный заказ → продажа в BILLZ: заказ, товары, клиент и оплата (остаток списывается сразу).
   ВНИМАНИЕ: ещё не проверено на живом BILLZ — включается BILLZ_CREATE_ORDERS=1 после тестового заказа. */
async function billzSale(o) {
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
  const types = (await billz("GET", "/v1/company-payment-type")).company_payment_types || [];
  const want = CFG.billzPayType[o.pay];
  const pt = types.find(t => want ? t.id === want : t.name === "Карта") || types.find(t => !t.is_cash_payment_type);
  if (!pt) throw new Error("в BILLZ нет способа оплаты для онлайн-платежей");
  await rpc("order.make_payment", { order_id: orderId, payments: [{ id: pt.payment_type.id, company_payment_type_id: pt.id, paid_amount: o.total }] });
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

  const o = { no: await uniqueOrderNo(), created: new Date().toISOString(), lang: body.lang === "uz" ? "uz" : "ru",
    items, total: items.reduce((a, i) => a + i.sum, 0), name, phone, delivery, addr: delivery === "deliv" ? addr : "", pay,
    tgUser: tgUser ? { id: tgUser.id, username: tgUser.username || "" } : null };

  if (pay === "cash") {
    // наличные: только сообщение менеджеру, в BILLZ продажу проводят при оплате в магазине
    let notified = false;
    try { notified = await notifyManager(o, "🛒 Новый заказ №" + o.no + " · оплата наличными"); } catch (e) { o.notifyError = e.message; console.error("Telegram:", e.message); }
    logOrder("CASH", o);
    return [200, { no: o.no, total: o.total, status: "cash", notified }];
  }

  // онлайн: заказ ждёт оплаты; менеджер и BILLZ узнают о нём только после оплаты
  if (!payReady(pay)) return [503, { error: "pay_unavailable" }];
  o.status = "pending";
  o.key = crypto.randomBytes(12).toString("hex");
  o.expires = Date.now() + CFG.orderTtlMin * 60e3;
  await store.set("order:" + o.no, o, 60 * 60 * 24 * 60);
  logOrder("PENDING", o);
  return [200, { no: o.no, total: o.total, status: "pending", key: o.key, payUrl: payUrl(o) }];
}

/* ===== Онлайн-оплата ===== */
function payReady(pay) {
  // на Vercel без Redis заказ потеряется между вызовами — онлайн-оплату не включаем
  if (process.env.VERCEL && !store.remote) return false;
  if (pay === "payme") return !!(CFG.payme.merchantId && CFG.payme.key);
  if (pay === "click") return !!(CFG.click.serviceId && CFG.click.merchantId && CFG.click.secretKey);
  return false;
}
function payUrl(o) {
  const back = CFG.appUrl + "/?order=" + o.no + "&key=" + o.key;
  if (o.pay === "payme") {
    const params = "m=" + CFG.payme.merchantId + ";ac.order_id=" + o.no + ";a=" + o.total * 100 + ";c=" + back + ";l=" + o.lang;
    return (CFG.payme.test ? "https://checkout.test.paycom.uz/" : "https://checkout.paycom.uz/") + Buffer.from(params).toString("base64");
  }
  return "https://my.click.uz/services/pay?" + new URLSearchParams({ service_id: CFG.click.serviceId, merchant_id: CFG.click.merchantId,
    amount: o.total, transaction_param: o.no, return_url: back });
}
async function uniqueOrderNo() {
  for (let i = 0; i < 20; i++) {
    const no = newOrderNo();
    if (await store.set("orderno:" + no, 1, 60 * 60 * 24 * 400, true)) return no;
  }
  throw new Error("не удалось выдать номер заказа");
}
function logOrder(kind, o) {
  const { key, ...safe } = o;
  console.log("ORDER " + kind + " " + JSON.stringify(safe)); // журнал в логах Vercel
  if (CFG.ordersLog) fs.appendFileSync(CFG.ordersLog, JSON.stringify({ kind, ...safe }) + "\n");
}
const getOrder = no => store.get("order:" + String(no).slice(0, 12));
const saveOrder = o => store.set("order:" + o.no, o, 60 * 60 * 24 * 60);

/* Статус для приложения: номер + секретный ключ заказа */
async function orderStatus(no, key) {
  const o = await getOrder(no);
  if (!o || !key || o.key !== key) return [404, { error: "not found" }];
  return [200, { no: o.no, status: o.status, total: o.total, pay: o.pay, payUrl: o.status === "pending" ? payUrl(o) : undefined }];
}
/* Можно ли сейчас оплатить: заказ ждёт оплаты и все пары ещё на складе */
async function canPay(o) {
  if (!o || o.status !== "pending") return false;
  await resolveShop();
  for (const i of o.items) for (const u of i.units) {
    const x = await liveByBarcode(u.barcode);
    if (!x || stockOf(x) < u.take) return false;
  }
  return true;
}
/* Оплата прошла: проводим продажу в BILLZ и сообщаем менеджеру. Повторный вызов ничего не делает. */
async function markPaid(no, provider, txId) {
  const o = await getOrder(no);
  if (!o) throw new Error("order " + no + " not found");
  if (o.status === "paid") return o;
  o.status = "paid"; o.paidAt = new Date().toISOString(); o.payTx = provider + ":" + txId;
  await saveOrder(o);
  if (CFG.createOrders) {
    try { o.billzOrderId = await billzSale(o); } catch (e) { o.billzError = e.message; console.error("BILLZ продажа:", e.message); }
  } else {
    o.billzError = "проведение в BILLZ выключено (BILLZ_CREATE_ORDERS)";
  }
  try { await notifyManager(o, "✅ Оплачен заказ №" + o.no + " · " + PAY_RU[o.pay]); } catch (e) { o.notifyError = e.message; console.error("Telegram:", e.message); }
  await saveOrder(o);
  logOrder("PAID", o);
  return o;
}
async function markCancelled(no, reason) {
  const o = await getOrder(no);
  if (!o || o.status === "cancelled") return o;
  const wasPaid = o.status === "paid";
  o.status = "cancelled"; o.cancelReason = reason; o.cancelledAt = new Date().toISOString();
  await saveOrder(o);
  if (wasPaid) { try { await notifyManager(o, "↩️ Оплата отменена, заказ №" + o.no + " — верните продажу в BILLZ"); } catch (e) { console.error("Telegram:", e.message); } }
  logOrder("CANCELLED", o);
  return o;
}

module.exports = { CFG, store, payReady, getCatalog, catalogBody, placeOrder, orderStatus, getOrder, saveOrder, canPay, markPaid, markCancelled, parseName, brandOf, checkInitData };
