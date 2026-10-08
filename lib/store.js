/* Хранилище: сотрудники, правки админки, номера заказов, снимок каталога.
   На Vercel — Upstash Redis (подключается в Vercel → Storage, переменные KV_REST_API_URL / KV_REST_API_TOKEN).
   Локально без этих переменных — память процесса, копия в .cache/store.json (переживает перезапуск server.js). */
"use strict";
const fs = require("fs");
const path = require("path");

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const remote = !!(URL_ && TOKEN);

async function cmd(...args) {
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: JSON.stringify(args.map(String)) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("Redis: " + (j.error || "HTTP " + r.status));
  return j.result;
}

/* память: { key → {v, exp} }, хэши: { key → {field → json} }, отсортированные множества: { key → Map(member → score) } */
const mem = new Map(), hashes = new Map(), zsets = new Map();
const alive = e => e && (!e.exp || e.exp > Date.now());
const FILE = !remote && !process.env.VERCEL ? path.join(__dirname, "..", ".cache", "store.json") : "";
if (FILE && fs.existsSync(FILE)) {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    Object.entries(s.mem || {}).forEach(([k, e]) => mem.set(k, e));
    Object.entries(s.hashes || {}).forEach(([k, h]) => hashes.set(k, h));
  } catch (e) { console.error("store.json:", e.message); }
}
function persist() {
  if (!FILE) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ mem: Object.fromEntries([...mem].filter(([, e]) => alive(e))), hashes: Object.fromEntries(hashes) }));
  } catch (e) { console.error("store.json:", e.message); }
}

async function get(key) {
  if (remote) { const v = await cmd("GET", key); return v == null ? null : JSON.parse(v); }
  const e = mem.get(key); return alive(e) ? JSON.parse(e.v) : null;
}
/* ttl — секунды; nx — только если ключа ещё нет (возвращает false, если занят) */
async function set(key, value, ttl, nx) {
  const v = JSON.stringify(value);
  if (remote) {
    const args = ["SET", key, v];
    if (ttl) args.push("EX", ttl);
    if (nx) args.push("NX");
    return (await cmd(...args)) === "OK";
  }
  if (nx && alive(mem.get(key))) return false;
  mem.set(key, { v, exp: ttl ? Date.now() + ttl * 1000 : 0 });
  persist();
  return true;
}
async function del(key) {
  if (remote) return cmd("DEL", key);
  mem.delete(key);
  persist();
}
/* хэш: каждое поле пишется отдельно — одновременные правки разных полей друг друга не затирают */
async function hgetall(key) {
  const out = {};
  if (remote) {
    const a = (await cmd("HGETALL", key)) || [];
    for (let i = 0; i < a.length; i += 2) out[a[i]] = JSON.parse(a[i + 1]);
    return out;
  }
  Object.entries(hashes.get(key) || {}).forEach(([f, v]) => { out[f] = JSON.parse(v); });
  return out;
}
async function hset(key, field, value) {
  if (remote) return cmd("HSET", key, field, JSON.stringify(value));
  if (!hashes.has(key)) hashes.set(key, {});
  hashes.get(key)[field] = JSON.stringify(value);
  persist();
}
async function hdel(key, field) {
  if (remote) return cmd("HDEL", key, field);
  if (hashes.has(key)) delete hashes.get(key)[field];
  persist();
}
async function zadd(key, score, member) {
  if (remote) return cmd("ZADD", key, score, member);
  if (!zsets.has(key)) zsets.set(key, new Map());
  zsets.get(key).set(member, score);
}
async function zrange(key, from, to) {
  if (remote) return (await cmd("ZRANGE", key, from, to, "BYSCORE")) || [];
  return [...(zsets.get(key) || new Map())].filter(([, s]) => s >= from && s <= to).sort((a, b) => a[1] - b[1]).map(([m]) => m);
}

module.exports = { remote, get, set, del, hgetall, hset, hdel, zadd, zrange };
