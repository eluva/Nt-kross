/* Payme Merchant API (JSON-RPC): Payme сам вызывает этот адрес при оплате.
   Протокол: https://developer.help.paycom.uz/metody-merchant-api/
   Суммы в тийинах (сум × 100). Заказ — ac.order_id = номер заказа. */
"use strict";
const crypto = require("crypto");
const core = require("./core");
const { store } = core;

const TIMEOUT = 12 * 60 * 60 * 1000; // Payme отменяет неоплаченную транзакцию через 12 часов

const err = (code, ru, data) => ({ error: { code, message: { ru, uz: ru, en: ru }, data } });
const ERR = {
  auth: () => err(-32504, "Недостаточно привилегий"),
  method: () => err(-32601, "Метод не найден"),
  parse: () => err(-32700, "Ошибка разбора JSON"),
  amount: () => err(-31001, "Неверная сумма"),
  notFound: () => err(-31003, "Транзакция не найдена"),
  cantPerform: () => err(-31008, "Невозможно выполнить операцию"),
  order: () => err(-31050, "Заказ не найден", "order_id"),
  orderState: () => err(-31051, "Заказ уже оплачен или отменён", "order_id"),
  busy: () => err(-31052, "Заказ уже ожидает оплаты другой транзакцией", "order_id"),
  stock: () => err(-31053, "Товар закончился", "order_id"),
  expired: () => err(-31054, "Время на оплату заказа истекло", "order_id"),
};

function authorized(header) {
  const key = core.CFG.payme.key;
  if (!key || !header || !header.startsWith("Basic ")) return false;
  const expected = Buffer.from("Basic " + Buffer.from("Paycom:" + key).toString("base64"));
  const got = Buffer.from(header);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

const txKey = id => "payme:tx:" + id;
const getTx = id => store.get(txKey(String(id)));
const saveTx = tx => store.set(txKey(tx.id), tx, 60 * 60 * 24 * 400);
const txView = tx => ({ create_time: tx.create_time, perform_time: tx.perform_time, cancel_time: tx.cancel_time,
  transaction: tx.transaction, state: tx.state, reason: tx.reason });

/* общая проверка заказа для CheckPerformTransaction и CreateTransaction */
async function checkOrder(params) {
  const no = params.account && params.account.order_id;
  const o = no && await core.getOrder(no);
  if (!o || o.pay !== "payme") return [null, ERR.order()];
  if (o.total * 100 !== params.amount) return [null, ERR.amount()];
  if (o.status !== "pending") return [null, ERR.orderState()];
  return [o, null];
}

async function cancelTx(tx, reason) {
  const wasPerformed = tx.state === 2;
  tx.state = wasPerformed ? -2 : -1;
  tx.reason = reason;
  tx.cancel_time = Date.now();
  await saveTx(tx);
  const o = await core.getOrder(tx.order);
  if (o && o.paymeTx === tx.id) { o.paymeTx = null; await core.saveOrder(o); }
  // отмена после оплаты (возврат) — заказ отменяем и предупреждаем менеджера; до оплаты — заказ можно оплатить заново
  if (wasPerformed) await core.markCancelled(tx.order, "payme:" + reason);
  return tx;
}

const methods = {
  async CheckPerformTransaction(p) {
    const [o, e] = await checkOrder(p);
    if (e) return e;
    if (Date.now() > o.expires) return ERR.expired();
    if (!(await core.canPay(o))) return ERR.stock();
    return { result: { allow: true } };
  },

  async CreateTransaction(p) {
    let tx = await getTx(p.id);
    if (tx) {
      if (tx.state !== 1) return ERR.cantPerform();
      if (Date.now() - tx.create_time > TIMEOUT) { await cancelTx(tx, 4); return ERR.cantPerform(); }
      return { result: { create_time: tx.create_time, transaction: tx.transaction, state: tx.state } };
    }
    const [o, e] = await checkOrder(p);
    if (e) return e;
    if (o.paymeTx) {
      const other = await getTx(o.paymeTx);
      if (other && other.state === 1) return ERR.busy();
    }
    if (Date.now() > o.expires) return ERR.expired();
    if (!(await core.canPay(o))) return ERR.stock();
    tx = { id: String(p.id), time: p.time, amount: p.amount, order: o.no, create_time: Date.now(),
      perform_time: 0, cancel_time: 0, transaction: o.no + "-" + crypto.randomBytes(3).toString("hex"), state: 1, reason: null };
    await saveTx(tx);
    await store.zadd("payme:txs", p.time, tx.id);
    o.paymeTx = tx.id;
    await core.saveOrder(o);
    return { result: { create_time: tx.create_time, transaction: tx.transaction, state: 1 } };
  },

  async PerformTransaction(p) {
    const tx = await getTx(p.id);
    if (!tx) return ERR.notFound();
    if (tx.state === 2) return { result: { transaction: tx.transaction, perform_time: tx.perform_time, state: 2 } };
    if (tx.state !== 1) return ERR.cantPerform();
    if (Date.now() - tx.create_time > TIMEOUT) { await cancelTx(tx, 4); return ERR.cantPerform(); }
    tx.state = 2; tx.perform_time = Date.now();
    await saveTx(tx);
    await core.markPaid(tx.order, "payme", tx.id); // продажа в BILLZ + сообщение менеджеру
    return { result: { transaction: tx.transaction, perform_time: tx.perform_time, state: 2 } };
  },

  async CancelTransaction(p) {
    let tx = await getTx(p.id);
    if (!tx) return ERR.notFound();
    if (tx.state === 1 || tx.state === 2) tx = await cancelTx(tx, p.reason);
    return { result: { transaction: tx.transaction, cancel_time: tx.cancel_time, state: tx.state } };
  },

  async CheckTransaction(p) {
    const tx = await getTx(p.id);
    if (!tx) return ERR.notFound();
    return { result: txView(tx) };
  },

  async GetStatement(p) {
    const ids = await store.zrange("payme:txs", p.from, p.to);
    const list = [];
    for (const id of ids) {
      const tx = await getTx(id);
      if (tx) list.push({ id: tx.id, time: tx.time, amount: tx.amount, account: { order_id: tx.order }, ...txView(tx), receivers: null });
    }
    return { result: { transactions: list } };
  },
};

/* Возвращает JSON-ответ для Payme (всегда HTTP 200) */
async function handle(body, authHeader) {
  const id = body && body.id != null ? body.id : null;
  if (!authorized(authHeader)) return { id, ...ERR.auth() };
  if (!body || typeof body !== "object") return { id, ...ERR.parse() };
  const fn = methods[body.method];
  if (!fn) return { id, ...ERR.method() };
  try {
    return { id, ...(await fn(body.params || {})) };
  } catch (e) {
    console.error("Payme " + body.method + ":", e.message);
    return { id, ...err(-32400, "Внутренняя ошибка") };
  }
}

module.exports = { handle };
