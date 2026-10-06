/* Click SHOP API: Click вызывает Prepare (action=0), затем Complete (action=1).
   Протокол: https://docs.click.uz/click-api-request/
   merchant_trans_id = номер заказа, сумма в сумах. */
"use strict";
const crypto = require("crypto");
const core = require("./core");

const md5 = s => crypto.createHash("md5").update(s).digest("hex");
const E = {
  ok: [0, "Success"], sign: [-1, "SIGN CHECK FAILED!"], amount: [-2, "Incorrect parameter amount"],
  action: [-3, "Action not found"], paid: [-4, "Already paid"], order: [-5, "Order does not exist"],
  tx: [-6, "Transaction does not exist"], request: [-8, "Error in request from click"], cancelled: [-9, "Transaction cancelled"],
};

/* p — поля запроса Click (application/x-www-form-urlencoded); возвращает JSON-ответ */
async function handle(p) {
  const { secretKey, serviceId } = core.CFG.click;
  const action = String(p.action);
  const base = { click_trans_id: p.click_trans_id, merchant_trans_id: p.merchant_trans_id };
  const reply = (e, extra) => ({ ...base, ...extra, error: e[0], error_note: e[1] });

  if (!secretKey || p.click_trans_id == null || p.merchant_trans_id == null || p.amount == null || !p.sign_string) return reply(E.request);
  if (action !== "0" && action !== "1") return reply(E.action);
  if (String(p.service_id) !== String(serviceId)) return reply(E.request);
  const signed = md5("" + p.click_trans_id + p.service_id + secretKey + p.merchant_trans_id +
    (action === "1" ? p.merchant_prepare_id : "") + p.amount + p.action + p.sign_time);
  if (signed !== String(p.sign_string).toLowerCase()) return reply(E.sign);

  const o = await core.getOrder(p.merchant_trans_id);
  if (!o || o.pay !== "click") return reply(E.order);
  if (Math.abs(parseFloat(p.amount) - o.total) > 0.009) return reply(E.amount);
  if (o.status === "paid") return reply(E.paid);
  if (o.status === "cancelled") return reply(E.cancelled);

  try {
    if (action === "0") {
      if (Date.now() > o.expires || !(await core.canPay(o))) return reply(E.cancelled); // время вышло или пары уже нет
      o.click = { trans: String(p.click_trans_id), prepareId: Date.now() };
      await core.saveOrder(o);
      return reply(E.ok, { merchant_prepare_id: o.click.prepareId });
    }
    // action = 1 (Complete)
    if (!o.click || String(o.click.prepareId) !== String(p.merchant_prepare_id) || o.click.trans !== String(p.click_trans_id)) return reply(E.tx);
    if (+p.error < 0) { // Click сообщает, что платёж не прошёл
      o.click = null; await core.saveOrder(o); // заказ можно попробовать оплатить ещё раз
      return reply(E.cancelled);
    }
    await core.markPaid(o.no, "click", p.click_trans_id); // продажа в BILLZ + сообщение менеджеру
    return reply(E.ok, { merchant_confirm_id: o.click.prepareId });
  } catch (e) {
    console.error("Click:", e.message);
    return reply(E.request);
  }
}

module.exports = { handle };
