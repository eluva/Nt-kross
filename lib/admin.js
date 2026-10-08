/* NT Kross — админка: сотрудники правят витрину вручную, поверх данных BILLZ.
   Что можно:
   — у модели из BILLZ: название, бренд, цену и цену до скидки, фото, скрыть размеры или всю модель,
     метки «Хит» / «Новинка», закрепить наверху. Остаток по-прежнему из BILLZ — продажи идут там;
   — свои товары, которых нет в BILLZ: всё задаётся вручную, включая размеры и количество;
   — магазин (телефон, Telegram менеджера, адрес, часы, координаты) и доставку (куда возим, BTS вкл/выкл).
   Правки лежат в store (Redis на Vercel), каждая модель — отдельным полем хэша: два сотрудника не затирают друг друга.
   Вход: из бота сотрудников (Telegram Mini App; доступ включает администратор в /staff) или по паролю ADMIN_PASSWORD. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./store");

const K_EDITS = "ntkross:admin:edits", K_ITEMS = "ntkross:admin:items", K_SET = "ntkross:admin:settings";
const PASSWORD = process.env.ADMIN_PASSWORD || "";
const UPLOADS = path.join(__dirname, "..", ".cache", "uploads"); // фото локально (на Vercel — Vercel Blob)
const persistent = store.remote || !process.env.VERCEL;

/* значения по умолчанию — то, что было зашито в приложение */
const DEFAULT_SHOP = {
  manager: "ntkross_admin",
  phone: "+998 (91) 163-00-34",
  hours: { ru: "Ежедневно 9:00–21:00", uz: "Har kuni 9:00–21:00" },
  address: { ru: "", uz: "" },
  landmark: { ru: "", uz: "" },
  coords: null, // [широта, долгота]
};

/* ===== Чтение правок =====
   Каталог спрашивают часто — правки держим в памяти несколько секунд. Redis недоступен — витрина работает без правок. */
const TTL = 5e3;
let cached = null, cachedAt = 0;
async function load(fresh) {
  if (!fresh && cached && Date.now() - cachedAt < TTL) return cached;
  try {
    const [edits, items, set] = await Promise.all([store.hgetall(K_EDITS), store.hgetall(K_ITEMS), store.hgetall(K_SET)]);
    cached = { edits, items, shop: { ...DEFAULT_SHOP, ...(set.shop || {}) }, delivery: set.delivery || {} };
  } catch (e) {
    console.error("Админка:", e.message);
    if (!cached) cached = { edits: {}, items: {}, shop: { ...DEFAULT_SHOP }, delivery: {} };
  }
  cachedAt = Date.now();
  return cached;
}

/* ===== Правки → витрина ===== */
const bySize = (a, b) => (isNaN(a) || isNaN(b) ? String(a).localeCompare(String(b)) : a - b);
function flags(p, e) {
  if (e.hit === true) p.hit = true; else if (e.hit === false) delete p.hit;
  if (e.fresh === true) p.fresh = true; else if (e.fresh === false) delete p.fresh;
  if (e.pin) p.pin = true;
}
/* модель из BILLZ с правкой; null — модель скрыта или не осталось размеров */
function applyEdit(p0, e) {
  if (e.hide) return null;
  const hidden = e.hideSizes || [], sizes = p0.sizes.filter(s => !hidden.includes(s));
  if (!sizes.length) return null;
  const p = { ...p0, sizes, ps: {}, qty: {}, bc: {}, imgs: e.imgs ? e.imgs.slice() : p0.imgs };
  if (e.name) p.name = e.name;
  if (e.tag) p.tag = e.tag;
  delete p.old; delete p.off;
  const old = {}; let off = 0;
  sizes.forEach(s => {
    p.ps[s] = e.price || p0.ps[s]; p.qty[s] = p0.qty[s]; p.bc[s] = p0.bc[s];
    // своя цена без «цены до скидки» отменяет скидку BILLZ
    const o = e.old || (e.price ? 0 : (p0.old && p0.old[s]) || 0);
    if (o > p.ps[s]) { old[s] = o; off = Math.max(off, Math.round((1 - p.ps[s] / o) * 100)); }
  });
  p.price = Math.min(...Object.values(p.ps));
  if (off > 0) { p.old = old; p.off = off; }
  flags(p, e);
  return p;
}
/* свой товар (не из BILLZ); null — скрыт или нечего продавать.
   held(ключ, остаток) — сколько уже заказано на сайте (резерв из core), ключ — "item:<id>:<размер>" */
function itemProduct(it, held) {
  if (!it || it.hide || !(it.price > 0)) return null;
  const left = s => it.sizes[s] - (held ? held("item:" + it.id + ":" + s, it.sizes[s]) : 0);
  const sizes = Object.keys(it.sizes || {}).filter(s => left(s) > 0).sort(bySize);
  if (!sizes.length) return null;
  const p = { id: it.id, name: it.name, tag: it.tag || "Другое", price: it.price, ps: {}, qty: {}, bc: {}, sizes, imgs: it.imgs || [], manual: true };
  sizes.forEach(s => { p.ps[s] = it.price; p.qty[s] = left(s); p.bc[s] = []; });
  if (it.old > it.price) {
    p.old = {}; sizes.forEach(s => { p.old[s] = it.old; });
    p.off = Math.round((1 - it.price / it.old) * 100);
  }
  flags(p, it);
  return p;
}
/* каталог BILLZ + правки + свои товары. Порядок: закреплённые, свои (новые сверху), остальные как были.
   v — короткий отпечаток витрины (товары, магазин, доставка): приложение перезагружает каталог, только когда он меняется.
   holds — объект резерва (меняется, только когда меняется резерв), held — функция из core */
let memo = { cat: null, adm: null, holds: null, out: null };
function apply(cat, adm, holds, held) {
  if (memo.cat === cat && memo.adm === adm && memo.holds === holds) return memo.out;
  const pinned = [], own = [], rest = [];
  for (const p0 of cat.products) {
    const e = adm.edits[p0.id], p = e ? applyEdit(p0, e) : p0;
    if (p) (p.pin ? pinned : rest).push(p);
  }
  Object.values(adm.items).sort((a, b) => b.at - a.at).forEach(it => { const p = itemProduct(it, held); if (p) (p.pin ? pinned : own).push(p); });
  const out = { ...cat, products: pinned.concat(own, rest) };
  out.v = crypto.createHash("sha1").update(JSON.stringify([out.products, adm.shop, adm.delivery])).digest("hex").slice(0, 12);
  memo = { cat, adm, holds, out };
  return out;
}
/* «Продано» в боте по своему товару — уменьшаем количество размера */
async function takeItem(id, size, qty) {
  const it = (await store.hgetall(K_ITEMS))[id];
  if (!it || !(size in (it.sizes || {}))) return;
  it.sizes[size] = Math.max(0, it.sizes[size] - qty);
  await store.hset(K_ITEMS, id, it);
  cachedAt = 0;
}
const isItem = id => /^m-[0-9a-f]{8}$/.test(String(id || ""));

/* ===== Проверка присланных данных ===== */
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const money = v => { const n = parseInt(String(v == null ? "" : v).replace(/\D/g, ""), 10); return n > 0 && n < 1e10 ? n : 0; };
const SIZE_RE = /^[\w.,/-]{1,8}$/;
const urlOk = u => /^https:\/\/[^\s"'<>\\]+$/.test(u) || /^\/uploads\/[\w.-]+$/.test(u);
const imgsOf = a => a.map(u => str(u, 600)).filter(urlOk).slice(0, 12);
const lang2 = v => ({ ru: str(v && v.ru, 200), uz: str(v && v.uz, 200) });
function cleanEdit(b) {
  const e = {};
  const name = str(b.name, 80), tag = str(b.tag, 30), price = money(b.price), old = money(b.old);
  if (name) e.name = name;
  if (tag) e.tag = tag;
  if (price) e.price = price;
  if (old) e.old = old;
  if (Array.isArray(b.imgs)) e.imgs = imgsOf(b.imgs); // пустой список — модель без фото; null — фото из BILLZ
  if (Array.isArray(b.hideSizes)) { const h = b.hideSizes.map(s => str(s, 8)).filter(s => SIZE_RE.test(s)).slice(0, 40); if (h.length) e.hideSizes = h; }
  if (b.hit === true || b.hit === false) e.hit = b.hit;
  if (b.fresh === true || b.fresh === false) e.fresh = b.fresh;
  if (b.pin) e.pin = true;
  if (b.hide) e.hide = true;
  return e;
}
function cleanItem(b, id) {
  const it = { id, name: str(b.name, 80), tag: str(b.tag, 30) || "Другое", price: money(b.price), imgs: imgsOf(Array.isArray(b.imgs) ? b.imgs : []), sizes: {} };
  const old = money(b.old);
  if (old) it.old = old;
  Object.entries(b.sizes && typeof b.sizes === "object" ? b.sizes : {}).slice(0, 40).forEach(([s, q]) => {
    s = str(s, 8).replace(",", ".");
    const n = Math.max(0, Math.min(999, parseInt(q, 10) || 0));
    if (SIZE_RE.test(s)) it.sizes[s] = n;
  });
  if (b.hit === true || b.hit === false) it.hit = b.hit;
  if (b.fresh) it.fresh = true;
  if (b.pin) it.pin = true;
  if (b.hide) it.hide = true;
  return it;
}
function cleanShop(b) {
  const s = { manager: str(b.manager, 40).replace(/^@|^https?:\/\/t\.me\//, "").replace(/[^\w]/g, ""), phone: str(b.phone, 30),
    hours: lang2(b.hours), address: lang2(b.address), landmark: lang2(b.landmark), coords: null };
  const m = str(b.coords, 60).match(/(-?\d{1,3}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) s.coords = [+m[1], +m[2]];
  if (!s.manager) s.manager = DEFAULT_SHOP.manager;
  if (!s.phone) s.phone = DEFAULT_SHOP.phone;
  return s;
}

/* ===== Вход =====
   Telegram: подпись initData (бот сотрудников или бот приложения), не старше суток; права — в списке сотрудников.
   Пароль: токен с подписью, ключ выводится из пароля — смена ADMIN_PASSWORD выкидывает всех вошедших по паролю. */
function tgUser(initData) {
  if (!initData) return null;
  const q = new URLSearchParams(initData), hash = q.get("hash") || "";
  q.delete("hash");
  const dcs = [...q.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + "=" + v).join("\n");
  const ok = [process.env.STAFF_BOT_TOKEN, process.env.TELEGRAM_BOT_TOKEN].filter(Boolean).some(token => {
    const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
    const calc = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
    return calc.length === hash.length && crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
  });
  if (!ok || Date.now() / 1000 - (+q.get("auth_date") || 0) > 86400) return null;
  try { return JSON.parse(q.get("user") || "null"); } catch { return null; }
}
const tokenKey = () => crypto.createHash("sha256").update("ntkross-admin:" + PASSWORD).digest();
const b64 = s => Buffer.from(s).toString("base64url");
function makeToken(name) {
  const body = b64(JSON.stringify({ n: name, exp: Date.now() + 30 * 864e5 }));
  return body + "." + crypto.createHmac("sha256", tokenKey()).update(body).digest("base64url");
}
function readToken(t) {
  if (!PASSWORD) return null;
  const [body, sig] = String(t || "").split(".");
  if (!body || !sig) return null;
  const calc = crypto.createHmac("sha256", tokenKey()).update(body).digest("base64url");
  if (calc.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(sig))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
/* кто правит: { name } или null */
async function whoIs(headers) {
  const auth = String(headers.authorization || "");
  if (auth.startsWith("Bearer ")) { const p = readToken(auth.slice(7)); if (p) return { name: p.n || "по паролю" }; }
  const u = tgUser(headers["x-tg-init-data"]);
  if (u && u.id && await require("./staff").canEdit(u.id)) // staff подключаем здесь: он сам зависит от core
    return { name: [u.first_name, u.last_name].filter(Boolean).join(" ") + (u.username ? " @" + u.username : "") };
  return null;
}
/* не больше 10 неверных паролей за 10 минут с одного IP (в пределах одного экземпляра) */
const tries = new Map();
const recent = ip => (tries.get(ip) || []).filter(t => Date.now() - t < 600e3);
const tooMany = ip => recent(ip).length >= 10;
const failed = ip => tries.set(ip, [...recent(ip), Date.now()]);
function samePassword(p) {
  const a = crypto.createHash("sha256").update(String(p || "")).digest(), b = crypto.createHash("sha256").update(PASSWORD).digest();
  return !!PASSWORD && crypto.timingSafeEqual(a, b);
}

/* ===== Фото =====
   На Vercel — Vercel Blob (Storage → Blob, переменная BLOB_READ_WRITE_TOKEN); локально — папка .cache/uploads */
const canUpload = () => !!process.env.BLOB_READ_WRITE_TOKEN || !process.env.VERCEL;
async function upload(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return [400, { error: "image" }];
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 3e6) return [413, { error: "too large" }];
  const file = Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex") + "." + (m[1] === "jpeg" ? "jpg" : m[1]);
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { put } = require("@vercel/blob");
    const r = await put("ntkross/" + file, buf, { access: "public", contentType: "image/" + m[1], cacheControlMaxAge: 31536000 });
    return [200, { url: r.url }];
  }
  if (process.env.VERCEL) return [503, { error: "Подключите Vercel Blob (Storage → Blob), чтобы загружать фото" }];
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS, file), buf);
  return [200, { url: "/uploads/" + file }];
}

/* ===== API: GET — всё для админки; POST { action, … } — вход и правки. Возвращает [HTTP-код, ответ] ===== */
async function handle(method, body, headers, ip) {
  const core = require("./core"); // core подключает этот модуль сам — берём его здесь, без цикла при загрузке
  if (method === "POST" && body.action === "login") {
    if (!PASSWORD) return [403, { error: "Вход по паролю выключен (ADMIN_PASSWORD не задан)" }];
    if (tooMany(ip)) return [429, { error: "Слишком много попыток, подождите 10 минут" }];
    if (!samePassword(body.password)) { failed(ip); return [403, { error: "Неверный пароль" }]; }
    const name = str(body.name, 40) || "по паролю";
    return [200, { token: makeToken(name), me: { name } }];
  }
  const me = await whoIs(headers);
  if (!me) return [401, { error: "auth", password: !!PASSWORD }];

  if (method === "GET") {
    const [cat, adm] = await Promise.all([core.getCatalog(), load(true)]);
    const d = core.deliveryFor(adm), cnt = {};
    const products = cat.products.map(p => { cnt[p.tag] = (cnt[p.tag] || 0) + 1; const { bc, ...rest } = p; return rest; });
    return [200, { me, products, partial: !!(cat.incomplete || cat.stale), edits: adm.edits, items: adm.items, shop: adm.shop,
      zones: d.zones, regions: core.REGIONS.length, bts: d.regions.length > 0,
      brands: Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]), upload: canUpload(), persistent, thumbs: !!process.env.VERCEL }];
  }
  if (method !== "POST") return [405, { error: "method" }];
  if (!persistent) return [503, { error: "Подключите Upstash Redis в Vercel (Storage) — без него правки не сохраняются" }];
  const stamp = { by: me.name, at: Date.now() };
  let out;
  switch (body.action) {
    case "edit": { // правка модели из BILLZ; пустая правка — вернуть как в BILLZ
      const id = str(body.id, 20);
      if (!/^[0-9a-f]{10}$/.test(id)) return [400, { error: "id" }];
      const e = cleanEdit(body.edit || {});
      if (Object.keys(e).length) { Object.assign(e, stamp); await store.hset(K_EDITS, id, e); out = { edit: e }; }
      else { await store.hdel(K_EDITS, id); out = { edit: null }; }
      break;
    }
    case "item": { // свой товар: новый (без id) или правка
      const old = isItem(body.id) ? body.id : null;
      const it = cleanItem(body.item || {}, old || "m-" + crypto.randomBytes(4).toString("hex"));
      if (!it.name) return [400, { error: "Укажите название" }];
      if (!it.price) return [400, { error: "Укажите цену" }];
      if (!Object.keys(it.sizes).length) return [400, { error: "Добавьте хотя бы один размер" }];
      const prev = old && (await store.hgetall(K_ITEMS))[old];
      it.at = prev ? prev.at : stamp.at; // время появления — для порядка на витрине
      Object.assign(it, { by: stamp.by, edited: stamp.at });
      await store.hset(K_ITEMS, it.id, it);
      out = { item: it };
      break;
    }
    case "delItem":
      if (!isItem(body.id)) return [400, { error: "id" }];
      await store.hdel(K_ITEMS, body.id);
      out = {};
      break;
    case "shop":
      out = { shop: { ...cleanShop(body.shop || {}), ...stamp } };
      await store.hset(K_SET, "shop", out.shop);
      break;
    case "delivery": { // red: { зона → true, если туда не возим }, bts: false — выключить доставку в регионы
      const red = {};
      core.ZONES.forEach(z => { if (body.red && typeof body.red[z.id] === "boolean") red[z.id] = body.red[z.id]; });
      out = { delivery: { red, bts: body.bts !== false, ...stamp } };
      await store.hset(K_SET, "delivery", out.delivery);
      break;
    }
    case "upload":
      return upload(body.data);
    default:
      return [400, { error: "action" }];
  }
  cachedAt = 0; // этот экземпляр сразу отдаёт свежее
  return [200, { ok: true, ...out }];
}

module.exports = { load, apply, itemProduct, takeItem, isItem, handle, DEFAULT_SHOP, UPLOADS };
