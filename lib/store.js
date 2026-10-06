/* Хранилище заказов, ожидающих оплаты.
   На Vercel — Upstash Redis (подключается в Vercel → Storage, переменные KV_REST_API_URL / KV_REST_API_TOKEN).
   Локально без этих переменных — память процесса (для разработки). */
"use strict";

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const remote = !!(URL_ && TOKEN);

async function cmd(...args) {
  const r = await fetch(URL_, { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: JSON.stringify(args.map(String)) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("Redis: " + (j.error || "HTTP " + r.status));
  return j.result;
}

/* память: { key → {v, exp} }, отсортированные множества: { key → Map(member → score) } */
const mem = new Map(), zsets = new Map();
const alive = e => e && (!e.exp || e.exp > Date.now());

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
  return true;
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

module.exports = { remote, get, set, zadd, zrange };
