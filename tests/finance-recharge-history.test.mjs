import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Recargas de Celulares (prompt 6, 22/10/2026): HISTÓRICO por número com
// categoria e situação; EDITAR (data/valor/categoria — paga só categoria) e
// EXCLUIR a recarga, refazendo a despesa, a DRE e a próxima recarga da linha.

const db = await setupRouteDb([
  "shared_state", "accounts_payable", "accounts_payable_payments", "finance_items", "finance_accounts", "finance_cost_centers",
  "finance_store_entries", "expenses", "expense_rateio_shares", "expense_attachments",
  "finance_phone_recharges", "finance_phone_recharge_events",
]);
const linesRoute = await import("../app/api/finance/phone-recharges/route.ts");
const rechargeRoute = await import("../app/api/finance/phone-recharges/[id]/recharge/route.ts");
const eventsRoute = await import("../app/api/finance/phone-recharges/events/route.ts");

const ALFA = "clojaalfa1";
const ADMIN = { id: "admin", role: "admin" };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }]) });
db.insert("finance_items", { id: "item-tel", category_id: "cat-1", name: "TELEFONIA", created_by: "admin" });
db.insert("finance_items", { id: "item-chip", category_id: "cat-1", name: "CHIP", created_by: "admin" });
db.insert("finance_phone_recharges", {
  id: "line-1", phone_number: "81999990001", carrier: "TIM", company_id: ALFA, company_name: "LOJA ALFA",
  last_amount_cents: 0, last_recharge_date: "2026-07-01", next_recharge_date: "2026-09-29", period_days: 90, active: 1, created_by: "admin",
});
const register = (date, amount) => callRoute(rechargeRoute.POST, ADMIN, "POST", "/api/finance/phone-recharges/line-1/recharge",
  { rechargeDate: date, amountCents: amount, financeItemId: "item-tel" }, { id: "line-1" });
const history = async () => (await (await callRoute(linesRoute.GET, ADMIN, "GET", "/api/finance/phone-recharges?rechargeId=line-1")).json()).events;
const line = () => db.sqlite.prepare("SELECT last_recharge_date AS d, last_amount_cents AS a, next_recharge_date AS n FROM finance_phone_recharges WHERE id='line-1'").get();
const cell = (item, month) => db.sqlite.prepare("SELECT amount_cents AS c FROM finance_store_entries WHERE store_id=? AND item_id=? AND month=?").get(ALFA, item, month)?.c ?? 0;

test("histórico do número: mais recente primeiro, com categoria e situação da despesa", async () => {
  assert.equal((await register("2026-08-01", 3000)).status, 201);
  assert.equal((await register("2026-10-01", 3500)).status, 201);
  const events = await history();
  assert.deepEqual(events.map((e) => [e.rechargeDate, e.amountCents, e.financeItemId, e.paidPayables]), [
    ["2026-10-01", 3500, "item-tel", 0],
    ["2026-08-01", 3000, "item-tel", 0],
  ]);
});

test("editar a última recarga refaz despesa, DRE e a próxima recarga da linha", async () => {
  const [latest] = await history();
  const res = await callRoute(eventsRoute.PATCH, ADMIN, "PATCH", `/api/finance/phone-recharges/events?id=${latest.id}`,
    { rechargeDate: "2026-10-05", amountCents: 4000, financeItemId: "item-chip" });
  assert.equal(res.status, 200);
  assert.deepEqual({ ...line() }, { d: "2026-10-05", a: 4000, n: "2027-01-03" });
  assert.equal(cell("item-tel", "2026-10"), 0);
  assert.equal(cell("item-chip", "2026-10"), 4000);
  const expense = db.sqlite.prepare("SELECT original_amount_cents AS a, due_date AS d, finance_item_id AS i FROM expenses WHERE id=?").get(latest.expenseId);
  assert.deepEqual({ ...expense }, { a: 4000, d: "2026-10-05", i: "item-chip" });
});

test("recarga com despesa paga: só a categoria muda; não exclui. Excluir a última volta a linha para a anterior", async () => {
  const [latest, previous] = await history();
  db.sqlite.prepare("UPDATE accounts_payable SET status='paid', paid_amount_cents=original_amount_cents WHERE expense_id=?").run(previous.expenseId);
  const blocked = await callRoute(eventsRoute.PATCH, ADMIN, "PATCH", `/api/finance/phone-recharges/events?id=${previous.id}`, { amountCents: 9999 });
  assert.equal(blocked.status, 409);
  const category = await callRoute(eventsRoute.PATCH, ADMIN, "PATCH", `/api/finance/phone-recharges/events?id=${previous.id}`, { financeItemId: "item-chip" });
  assert.equal(category.status, 200);
  assert.equal(cell("item-chip", "2026-08"), 3000);
  assert.equal((await callRoute(eventsRoute.DELETE, ADMIN, "DELETE", `/api/finance/phone-recharges/events?id=${previous.id}`)).status, 409);

  assert.equal((await callRoute(eventsRoute.DELETE, ADMIN, "DELETE", `/api/finance/phone-recharges/events?id=${latest.id}`)).status, 200);
  assert.equal((await history()).length, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM expenses WHERE id=?").get(latest.expenseId).n, 0);
  assert.equal(cell("item-chip", "2026-10"), 0);
  assert.deepEqual({ ...line() }, { d: "2026-08-01", a: 3000, n: "2026-10-30" });
  assert.equal((await callRoute(eventsRoute.DELETE, ADMIN, "DELETE", "/api/finance/phone-recharges/events?id=nao-existe")).status, 404);
});
