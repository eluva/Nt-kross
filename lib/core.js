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
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",          // бот мини-приложения, пишет менеджеру
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
/* остаток в нашем магазине: в GET /v2/products — active_measurement_value, в поиске с фильтрами — total_active_measurement_value */
const stockOf = x => {
  const v = (x.shop_measurement_values || []).find(m => m.shop_id === CFG.shopId);
  return !v ? 0 : v.active_measurement_value != null ? v.active_measurement_value : v.total_active_measurement_value || 0;
};
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
   "Jordan 5 qora 46r152k" → модель "Jordan 5 qora", размер 46. Размеры 33–50 (50 — «великаны»).
   Остаток названия (152k) — служебная пометка, клиенту не показываем. */
function parseName(name) {
  const n = String(name || "");
  const m = n.match(/(^|[^\d.])(3[3-9]|4\d|50)([.,]5)?\s*r/i) || n.match(/(^|[^\d.])(3[3-9]|4\d|50)([.,]5)?\s*v/i);
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
   В BILLZ ~25 000 карточек (каждая пара — отдельная, проданные тоже остаются), а GET /v2/products отдаёт не дальше 10 000.
   Постраничный поиск там «плавает»: между страницами порядок меняется, и до четверти товаров теряется.
   Поэтому полный проход: все пары в наличии — одним запросом поиска с фильтром «остаток ≥ 1»,
   плюс всё, что менялось за HIT_DAYS дней (обычный список без поиска — его порядок стабилен).
   База товаров хранится снимком (Redis на Vercel, файл локально): холодный старт берёт снимок и догружает только изменения. */
const PAGE = 500;
const raw = new Map(); // id товара BILLZ → компактная запись (только то, что нужно витрине)
let cache = null, lastFull = 0, lastSync = 0, lastSnap = 0, lastBuild = 0, loading = null;
let scanning = null; // база, которую сейчас собирает полный проход, — из неё отдаём то, что уже готово
let snapCat = null;  // каталог из снимка при холодном старте — отдаём сразу, пока догружаются изменения

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
/* все пары в наличии одним ответом: у фильтра limit до 10 000, а пар в наличии ~4 500.
   В этом ответе нет бренда и галереи — только главное фото */
const STOCK_PAGE = 10000;
async function fetchInStock() {
  const out = [];
  for (let page = 1; ; page++) {
    const j = await billz("POST", "/v2/product-search-with-filters", { page, limit: STOCK_PAGE, shop_ids: [CFG.shopId], measurement_value_from: 1 });
    const list = j.products || [];
    out.push(...list);
    if (list.length < STOCK_PAGE || out.length >= (j.count || 0)) return out;
  }
}
/* BILLZ иногда отдаёт адрес фото с повторённым префиксом хранилища: "https://…/billz2-minio-billz/https://…/x.jpg" */
const photoUrl = u => { u = String(u || ""); const i = u.lastIndexOf("https://"); return i > 0 ? u.slice(i) : u; };
/* компактная запись: остаток, цены и фото — уже для нашего магазина */
function compact(x) {
  const c = { id: x.id, name: x.name || "", sku: x.sku || "", brand: x.brand_name || "", bc: x.barcode || "", at: x.updated_at || "",
    q: stockOf(x), p: priceOf(x), o: oldPriceOf(x) };
  if (c.q > 0) {
    const ph = (x.photos || []).slice().sort((a, b) => (b.is_main - a.is_main) || (a.sequence - b.sequence)).map(f => photoUrl(f.photo_url)).filter(Boolean);
    if (!ph.length && x.main_image_url) ph.push(photoUrl(x.main_image_url));
    if (ph.length) c.ph = ph.slice(0, 8);
  }
  return c;
}
/* храним только пары в наличии и недавно проданные (для хитов) — остальное витрине не нужно */
const keep = c => !!parseName(c.name) && (c.q > 0 || c.at >= dayStr(HIT_DAYS));
function put(map, x) { const c = compact(x); if (keep(c)) map.set(c.id, c); else map.delete(c.id); }

async function fullScan() {
  const started = Date.now(), fresh = scanning = new Map();
  try {
    // бренда и галереи в ответе фильтра нет — берём из прошлой базы; недавние пары получат их ниже из обычного списка
    for (const x of await fetchInStock()) {
      const c = compact(x), old = raw.get(c.id);
      if (old) { c.brand = c.brand || old.brand; if (old.ph && (!c.ph || old.ph.length > c.ph.length)) c.ph = old.ph; }
      if (keep(c)) fresh.set(c.id, c);
    }
    // менявшееся за месяц: проданные пары (для хитов) и полные данные недавних пар; время для BILLZ — в UTC
    (await fetchPages("last_updated_date=" + encodeURIComponent(dayStr(HIT_DAYS)))).forEach(x => put(fresh, x));
  } finally { scanning = null; }
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
  if (restored && !cache) snapCat = { ...buildFromRaw(), stale: true };
  let full = !raw.size || (!restored && Date.now() - lastFull > CFG.fullMs);
  if (!full && !(await incremental())) full = true;
  if (full) await fullScan();
  for (const c of raw.values()) if (!keep(c)) raw.delete(c.id); // проданные больше HIT_DAYS дней назад
  cache = buildFromRaw();
  snapCat = null;
  lastBuild = Date.now();
  console.log("Каталог обновлён" + (full ? " (полный проход)" : restored ? " (из снимка)" : "") + ":", cache.products.length, "моделей в наличии,", raw.size, "записей в базе");
  // после полного прохода снимок обязателен; после догрузки изменений — не чаще раза в 10 минут и без ожидания
  const snap = full || Date.now() - lastSnap > SNAP_EVERY ? saveSnapshot().catch(e => console.error("Снимок каталога:", e.message)) : null;
  if (full) await snap; else if (snap) background(snap);
}
/* Каталог из памяти; если устарел — обновляем фоном и отдаём текущий.
   Холодный старт со снимком: отдаём снимок сразу с пометкой stale — приложение покажет его и спросит ещё раз за свежим.
   Холодный старт без снимка (полный проход — минута и больше): ждём до COLD_WAIT, потом отдаём то, что уже собрано,
   с пометкой incomplete — приложение покажет это и спросит ещё раз. */
const COLD_WAIT = 10e3;
async function getCatalog() {
  if (cache && Date.now() - lastBuild < CFG.refreshMs) return cache;
  if (!loading) loading = rebuild().catch(e => console.error("Каталог:", e.message)).finally(() => { loading = null; });
  background(loading); // на Vercel обновление не замораживается после ответа
  if (cache) return cache;
  const pending = loading, until = Date.now() + (scanning && scanning.size ? 1500 : COLD_WAIT);
  let done = false;
  pending.then(() => { done = true; });
  while (!done && !snapCat && Date.now() < until) await Promise.race([pending, sleep(100)]);
  if (cache) return cache;
  if (snapCat) return snapCat;
  if (scanning && scanning.size) {
    const part = buildFromRaw(scanning);
    if (part.products.length) return { ...part, incomplete: true };
  }
  await pending;
  if (cache || snapCat) return cache || snapCat;
  throw new Error("catalog unavailable");
}
/* ===== Доставка =====
   pickup — самовывоз; deliv — курьер по Ташкенту и области (zone); bts — в регион через BTS (region), условия обсуждает менеджер.
   Красная зона (red) — заказ принимаем с пометкой: стоимость и сроки доставки уточняет менеджер.
   Списки уходят в приложение вместе с каталогом — менять их только здесь. */
const ZONES = [
  { id: "tash", ru: "Ташкент", uz: "Toshkent" },
  { id: "chirchiq", ru: "Чирчик", uz: "Chirchiq", red: true },
  { id: "tashobl", ru: "Ташкентская область", uz: "Toshkent viloyati", red: true },
];
const REGIONS = [
  { id: "andijan", ru: "Андижанская область", uz: "Andijon viloyati" },
  { id: "bukhara", ru: "Бухарская область", uz: "Buxoro viloyati" },
  { id: "jizzakh", ru: "Джизакская область", uz: "Jizzax viloyati" },
  { id: "kashkadarya", ru: "Кашкадарьинская область", uz: "Qashqadaryo viloyati" },
  { id: "navoi", ru: "Навоийская область", uz: "Navoiy viloyati" },
  { id: "namangan", ru: "Наманганская область", uz: "Namangan viloyati" },
  { id: "samarkand", ru: "Самаркандская область", uz: "Samarqand viloyati" },
  { id: "surkhandarya", ru: "Сурхандарьинская область", uz: "Surxondaryo viloyati" },
  { id: "syrdarya", ru: "Сырдарьинская область", uz: "Sirdaryo viloyati" },
  { id: "fergana", ru: "Ферганская область", uz: "Farg‘ona viloyati" },
  { id: "khorezm", ru: "Хорезмская область", uz: "Xorazm viloyati" },
  { id: "karakalpakstan", ru: "Республика Каракалпакстан", uz: "Qoraqalpog‘iston Respublikasi" },
];

/* Ответ /api/catalog. limit — только первые N моделей: приложение показывает их сразу, пока грузится остальное.
   thumbs — на Vercel фото в карточках идут миниатюрами через /_vercel/image (настройка images в vercel.json) */
async function catalogBody(limit) {
  const c = await getCatalog(), extra = { thumbs: !!process.env.VERCEL, zones: ZONES, regions: REGIONS };
  const n = Math.min(200, parseInt(limit, 10) || 0);
  if (n > 0 && n < c.products.length) return { updated: c.updated, total: c.products.length, partial: true, incomplete: c.incomplete, stale: c.stale, products: c.products.slice(0, n), ...extra };
  return { ...c, ...extra };
}

/* ===== Заказ =====
   Оплата — при получении, онлайн-оплаты нет. Заказ уходит менеджеру и сотрудникам в их бот; продажу в BILLZ проводят в магазине. */
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

function deliveryLines(o) {
  if (o.delivery === "deliv") {
    const z = ZONES.find(x => x.id === o.zone) || ZONES[0];
    return ["Получение: доставка — " + z.ru + (z.red ? "\n🔴 Красная зона: стоимость и сроки доставки уточнить у клиента" : ""), "Адрес: " + o.addr, "Оплата: при получении"];
  }
  if (o.delivery === "bts") {
    const r = REGIONS.find(x => x.id === o.region);
    return ["Получение: BTS — " + (r ? r.ru : "регион"), "Адрес / отделение BTS: " + o.addr, "Доставка и оплата: обсудить с клиентом"];
  }
  return ["Получение: самовывоз", "Оплата: при получении"];
}
function orderMessage(o) {
  return ["🛒 Новый заказ №" + o.no].concat(
    o.items.map(i => "• " + i.name + " · размер " + i.size + " × " + i.qty + " — " + fmt(i.sum) +
      "\n   BILLZ: " + i.units.map(u => u.name + " (" + u.barcode + ")").join("; ")),
    ["Итого: " + fmt(o.total), "Клиент: " + o.name, "Телефон: " + o.phone],
    deliveryLines(o),
    o.tgUser ? ["Telegram: " + (o.tgUser.username ? "@" + o.tgUser.username : "id " + o.tgUser.id)] : []
  ).join("\n");
}
async function notifyManager(text) {
  if (!CFG.botToken || !CFG.managerChat) return false;
  const r = await fetch("https://api.telegram.org/bot" + CFG.botToken + "/sendMessage", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CFG.managerChat, text }),
  });
  if (!r.ok) throw new Error("Telegram sendMessage: HTTP " + r.status);
  return true;
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
  const delivery = body.delivery === "deliv" || body.delivery === "bts" ? body.delivery : "pickup";
  const zone = ZONES.some(z => z.id === body.zone) ? body.zone : ZONES[0].id;
  const region = REGIONS.some(r => r.id === body.region) ? body.region : "";
  if (!name || phone.replace(/\D/g, "").length < 9) return [400, { error: "contacts" }];
  if ((delivery !== "pickup" && addr.length < 3) || (delivery === "bts" && !region)) return [400, { error: "address" }];
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
    items, total: items.reduce((a, i) => a + i.sum, 0), name, phone, delivery,
    zone: delivery === "deliv" ? zone : "", region: delivery === "bts" ? region : "", addr: delivery === "pickup" ? "" : addr,
    tgUser: tgUser ? { id: tgUser.id, username: tgUser.username || "" } : null };
  // менеджеру — в его чат, сотрудникам — в их бот (staff.js подключаем здесь: он сам использует этот модуль)
  const text = orderMessage(o);
  let notified = false;
  try { notified = await notifyManager(text); } catch (e) { o.notifyError = e.message; console.error("Telegram:", e.message); }
  try { if (await require("./staff").notifyOrder(text)) notified = true; } catch (e) { console.error("Бот сотрудников:", e.message); }
  logOrder(o);
  return [200, { no: o.no, total: o.total, notified }];
}
async function uniqueOrderNo() {
  for (let i = 0; i < 20; i++) {
    const no = newOrderNo();
    if (await store.set("orderno:" + no, 1, 60 * 60 * 24 * 400, true)) return no;
  }
  throw new Error("не удалось выдать номер заказа");
}
function logOrder(o) {
  console.log("ORDER " + JSON.stringify(o)); // журнал в логах Vercel
  if (CFG.ordersLog) fs.appendFileSync(CFG.ordersLog, JSON.stringify(o) + "\n");
}

module.exports = { CFG, store, getCatalog, catalogBody, placeOrder, parseName, brandOf, checkInitData };
