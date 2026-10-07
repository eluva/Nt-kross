/* NT Kross — бот для сотрудников (отдельный от бота мини-приложения).
   Сотрудник пишет боту /start → администраторам приходит заявка с кнопками «Пустить» / «Отклонить».
   Пущенным сотрудникам бот присылает каждый новый заказ. С правом «наличие» сотрудник может написать
   название модели и получить размеры и остатки; администратор включает и выключает это право каждому отдельно
   и может забанить сотрудника (/staff — список с кнопками).
   Список сотрудников хранится в store: на Vercel нужен подключённый Upstash Redis, иначе он не сохраняется. */
"use strict";
const crypto = require("crypto");
const core = require("./core"); // первым — он же читает .env
const { store } = core;

const TOKEN = process.env.STAFF_BOT_TOKEN || "";
const ADMINS = (process.env.STAFF_ADMIN_IDS || "").split(/[\s,;]+/).filter(Boolean);
const SECRET = process.env.STAFF_WEBHOOK_SECRET || "";
const KEY = "ntkross:staff:v1";
const persistent = store.remote || !process.env.VERCEL;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tg(method, body) {
  const r = await fetch("https://api.telegram.org/bot" + TOKEN + "/" + method, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { const e = new Error("Telegram " + method + ": " + (j.description || "HTTP " + r.status)); e.code = j.error_code || r.status; throw e; }
  return j.result;
}
const send = (chat, text, extra) => tg("sendMessage", { chat_id: chat, text, ...extra });
const keyboard = rows => ({ reply_markup: { inline_keyboard: rows } });

/* ===== Сотрудники: { id → { id, name, username, status: pending | active | banned, stock, at } } ===== */
const isAdmin = id => ADMINS.includes(String(id));
const loadAll = async () => (await store.get(KEY)) || {};
const saveAll = all => store.set(KEY, all);
const who = s => s.name + (s.username ? " @" + s.username : "");
const short = s => (s.name.length > 18 ? s.name.slice(0, 17) + "…" : s.name);

function listView(all) {
  const staff = Object.values(all).sort((a, b) => a.at - b.at);
  if (!staff.length) return { text: "Сотрудников пока нет. Пусть напишут боту /start — вам придёт заявка." };
  const mark = { active: "✅", pending: "⏳", banned: "🚫" };
  const lines = staff.map(s => mark[s.status] + " " + who(s) + (s.status === "active" ? " — наличие: " + (s.stock ? "видит" : "скрыто") : s.status === "pending" ? " — ждёт одобрения" : " — забанен"));
  const rows = staff.map(s => s.status === "active" ? [{ text: (s.stock ? "👁 " : "🙈 ") + short(s), callback_data: "st:" + s.id }, { text: "🚫 Бан", callback_data: "ban:" + s.id }]
    : s.status === "pending" ? [{ text: "✅ Пустить " + short(s), callback_data: "ok:" + s.id + ":0" }, { text: "Отклонить", callback_data: "no:" + s.id }]
    : [{ text: "🚫 " + short(s), callback_data: "noop" }, { text: "✅ Вернуть", callback_data: "ban:" + s.id }]);
  return { text: "👥 Сотрудники\n\n" + lines.join("\n") + "\n\n👁 / 🙈 — показывать наличие или нет, 🚫 — закрыть доступ.", ...keyboard(rows) };
}

const HELP_ADMIN = "Вы администратор.\n/staff — сотрудники: заявки, бан, показ наличия.\nНапишите название модели (например: jordan 4) — покажу размеры в наличии.\nНовые заказы приходят сюда.";
const HELP_STOCK = "Новые заказы приходят сюда.\nНапишите название модели (например: jordan 4) — покажу размеры в наличии.";
const HELP_ORDERS = "Новые заказы приходят сюда.";

/* ===== Сообщения ===== */
async function onMessage(m) {
  if (!m.from || !m.chat || m.chat.type !== "private") return;
  const id = String(m.from.id), text = String(m.text || "").trim();
  if (/^\/id\b/.test(text)) return send(id, "Ваш Telegram ID: " + id);
  if (!persistent) return send(id, "⚠️ Бот не настроен: подключите Upstash Redis в Vercel (Storage) — без него список сотрудников не сохраняется.");
  if (isAdmin(id)) {
    if (/^\/staff\b/.test(text)) { const v = listView(await loadAll()); return send(id, v.text, { reply_markup: v.reply_markup }); }
    if (!text || text.startsWith("/")) return send(id, HELP_ADMIN);
    return stockReply(id, text);
  }
  const all = await loadAll(), name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || "Без имени";
  let me = all[id];
  if (!me) {
    me = all[id] = { id, name, username: m.from.username || "", status: "pending", stock: false, at: Date.now() };
    await saveAll(all);
    await notifyAdmins("🙋 Заявка в бот сотрудников: " + who(me) + " (id " + id + ")", keyboard([
      [{ text: "✅ Пустить", callback_data: "ok:" + id + ":0" }, { text: "✅ Пустить + наличие", callback_data: "ok:" + id + ":1" }],
      [{ text: "🚫 Отклонить", callback_data: "no:" + id }],
    ]));
    return send(id, "Заявка отправлена администратору. Как только вас пустят, сюда начнут приходить заказы.");
  }
  if (me.name !== name || me.username !== (m.from.username || "")) { me.name = name; me.username = m.from.username || ""; await saveAll(all); }
  if (me.status === "pending") return send(id, "Заявка ещё у администратора — подождите, пожалуйста.");
  if (me.status === "banned") return send(id, "Доступ закрыт.");
  if (!text || text.startsWith("/")) return send(id, me.stock ? HELP_STOCK : HELP_ORDERS);
  if (!me.stock) return send(id, "Проверка наличия вам недоступна. Новые заказы будут приходить сюда.");
  return stockReply(id, text);
}

/* наличие по названию: все слова запроса должны найтись в названии модели или бренде */
async function stockReply(chat, text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.join("").length < 2) return send(chat, "Напишите название модели, например: jordan 4");
  const { products } = await core.getCatalog();
  const found = products.filter(p => { const s = (p.name + " " + p.tag).toLowerCase(); return words.every(w => s.includes(w)); });
  if (!found.length) return send(chat, "В наличии не нашлось: «" + text + "»");
  const num = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const LIMIT = 10, lines = found.slice(0, LIMIT).map(p => "• " + p.name + " — " + num(p.price) + " сум\n   " +
    p.sizes.map(z => z + (p.qty[z] > 1 ? " (" + p.qty[z] + ")" : "")).join(", "));
  return send(chat, lines.join("\n") + (found.length > LIMIT ? "\n\nЕщё " + (found.length - LIMIT) + " — уточните запрос." : "") + "\n\nВ скобках — сколько пар, если больше одной.");
}

/* ===== Кнопки (только администраторы) ===== */
async function onButton(q) {
  const from = String(q.from.id), [act, id, arg] = String(q.data || "").split(":");
  const answer = text => tg("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
  if (!isAdmin(from)) return answer("Только для администратора");
  if (act === "noop") return answer();
  const all = await loadAll(), s = all[id];
  if (!s) return answer("Сотрудник не найден");
  let note = "";
  if (act === "ok") { s.status = "active"; s.stock = arg === "1"; note = "Доступ открыт. Сюда будут приходить новые заказы." + (s.stock ? "\nНапишите название модели — покажу размеры в наличии." : ""); }
  else if (act === "no") { s.status = "banned"; note = "Заявка отклонена."; }
  else if (act === "st") { s.stock = !s.stock; note = s.stock ? "Вам открыта проверка наличия: напишите название модели." : "Проверка наличия для вас выключена."; }
  else if (act === "ban") { s.status = s.status === "banned" ? "active" : "banned"; note = s.status === "banned" ? "Доступ закрыт." : "Доступ снова открыт."; }
  else return answer();
  await saveAll(all);
  await send(id, note).catch(e => console.error("Бот сотрудников:", e.message)); // сотрудник мог заблокировать бота
  await answer("Готово");
  // заявку превращаем в итог, список — перерисовываем
  const msg = { chat_id: q.message.chat.id, message_id: q.message.message_id };
  if (act === "ok" || act === "no") {
    if (q.message.text && q.message.text.startsWith("🙋")) return tg("editMessageText", { ...msg, text: q.message.text + "\n\n" + (act === "ok" ? "✅ Пущен" + (s.stock ? " с наличием" : "") : "🚫 Отклонён") }).catch(() => {});
  }
  const view = listView(all);
  return tg("editMessageText", { ...msg, text: view.text, reply_markup: view.reply_markup }).catch(() => {});
}

async function handle(update) {
  if (!TOKEN || !update) return;
  if (update.callback_query) return onButton(update.callback_query);
  if (update.message) return onMessage(update.message);
}
async function notifyAdmins(text, extra) {
  for (const id of ADMINS) await send(id, text, extra).catch(e => console.error("Бот сотрудников → админ " + id + ":", e.message));
}

/* Новый заказ — администраторам и всем пущенным сотрудникам. Возвращает, скольким дошло */
async function notifyOrder(text) {
  if (!TOKEN) return 0;
  const all = persistent ? await loadAll().catch(e => { console.error("Бот сотрудников:", e.message); return {}; }) : {};
  const ids = new Set([...ADMINS, ...Object.values(all).filter(s => s.status === "active").map(s => s.id)]);
  let sent = 0;
  for (const id of ids) {
    try { await send(id, text); sent++; } catch (e) { console.error("Бот сотрудников → " + id + ":", e.message); }
  }
  return sent;
}

/* ===== Подключение =====
   Вебхук: Telegram присылает обновления на /api/staffbot с заголовком секрета — чужие запросы отбрасываем. */
function validSecret(header) {
  if (!SECRET) return false;
  const a = Buffer.from(String(header || "")), b = Buffer.from(SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* GET /api/staffbot?setup=<секрет> — привязать вебхук к адресу сайта и прописать команды */
async function setup(key, base) {
  if (!TOKEN || !SECRET) return [503, { error: "STAFF_BOT_TOKEN и STAFF_WEBHOOK_SECRET не заданы" }];
  if (!validSecret(key)) return [403, { error: "secret" }];
  const url = base.replace(/\/$/, "") + "/api/staffbot";
  await tg("setWebhook", { url, secret_token: SECRET, allowed_updates: ["message", "callback_query"] });
  const common = [{ command: "start", description: "Начать" }, { command: "id", description: "Мой Telegram ID" }];
  await tg("setMyCommands", { commands: common });
  for (const id of ADMINS) await tg("setMyCommands", { commands: [...common, { command: "staff", description: "Сотрудники" }], scope: { type: "chat", chat_id: id } }).catch(() => {});
  return [200, { ok: true, webhook: url, admins: ADMINS.length, storage: store.remote ? "redis" : persistent ? "memory (только локально)" : "нет — подключите Redis" }];
}
/* Локально Telegram не достучится до вебхука: STAFF_BOT_POLL=1 — server.js сам забирает обновления.
   Если у бота уже стоит вебхук (боевой), опрос не работает — для разработки заведите отдельного тестового бота. */
async function poll() {
  if (!TOKEN) throw new Error("STAFF_BOT_TOKEN не задан");
  console.log("Бот сотрудников: опрос Telegram");
  for (let offset = 0; ;) {
    try {
      for (const u of await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] })) {
        offset = u.update_id + 1;
        await handle(u).catch(e => console.error("Бот сотрудников:", e.message));
      }
    } catch (e) {
      console.error("Бот сотрудников:", e.code === 409 ? "у бота включён вебхук — для локального опроса нужен отдельный тестовый бот" : e.message);
      await sleep(e.code === 409 ? 60e3 : 5e3);
    }
  }
}

module.exports = { handle, notifyOrder, validSecret, setup, poll };
