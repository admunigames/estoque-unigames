import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Financeiro 8/9 — Recargas de Celulares: período por linha (30/60/90 dias).
// Função pura, a mesma conta no front e as rotas reais sobre SQLite.

const db = await setupRouteDb([
  "finance_phone_recharges", "finance_phone_recharge_events", "expenses", "expense_rateio_shares", "accounts_payable",
  "finance_store_entries", "finance_items", "finance_categories", "finance_cost_centers", "finance_accounts",
]);
db.insert("finance_categories", { id: "cat-tel", name: "TELEFONIA" });
db.insert("finance_items", { id: "item-recarga", category_id: "cat-tel", name: "RECARGA DE CELULAR" });
const lib = await import("../app/lib/phone-recharges.ts");
const route = await import("../app/api/finance/phone-recharges/route.ts");
const recharge = await import("../app/api/finance/phone-recharges/[id]/recharge/route.ts");
const bulk = await import("../app/api/finance/phone-recharges/bulk/route.ts");

test("nextRechargeDate: 30/60/90 dias corridos, virada de mês/ano e fevereiro bissexto", () => {
  assert.equal(lib.nextRechargeDate("2026-01-31", 30), "2026-03-02");
  assert.equal(lib.nextRechargeDate("2026-01-31", 60), "2026-04-01");
  assert.equal(lib.nextRechargeDate("2026-01-31", 90), "2026-05-01");
  assert.equal(lib.nextRechargeDate("2026-12-15", 30), "2027-01-14");
  assert.equal(lib.nextRechargeDate("2028-02-01", 30), "2028-03-02"); // 2028 é bissexto (29 dias)
  assert.equal(lib.nextRechargeDate("2027-02-01", 30), "2027-03-03");
  assert.equal(lib.nextRechargeDate("", 30), "");
});

test("parseRechargePeriod: vazio = 90; 30/60/90; resto inválido", () => {
  assert.equal(lib.parseRechargePeriod(undefined), 90);
  assert.equal(lib.parseRechargePeriod(""), 90);
  assert.equal(lib.parseRechargePeriod("60"), 60);
  assert.equal(lib.parseRechargePeriod(30), 30);
  for (const bad of [45, 0, -30, "abc", 120]) assert.equal(lib.parseRechargePeriod(bad), null, String(bad));
});

test("o front (recargaNextDate) faz a mesma conta da função pura", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  const start = html.indexOf("function recargaNextDate(");
  assert.notEqual(start, -1);
  let depth = 0, end = html.indexOf("{", start);
  for (; end < html.length; end++) {
    if (html[end] === "{") depth++;
    if (html[end] === "}" && --depth === 0) break;
  }
  const front = new Function(`${html.slice(start, end + 1)}; return recargaNextDate;`)();
  for (const [date, days] of [["2026-01-31", 30], ["2026-12-15", 90], ["2028-02-01", 30], ["2026-03-29", 60], ["", 30]]) {
    assert.equal(front(date, String(days)), lib.nextRechargeDate(date, days), `${date}+${days}`);
  }
});

const ADMIN = { id: "admin", role: "admin" };
const NO_FINANCE = { id: "loja", permissions: ["outputs:view"] };
const json = (response) => response.json();
const post = (handler, path, body, params) => callRoute(handler, ADMIN, "POST", path, body, params);
const line = (id) => ({ ...db.sqlite.prepare("SELECT * FROM finance_phone_recharges WHERE id=?").get(id) });
const base = { phoneNumber: "81999990000", carrier: "TIM", companyId: "criomar01", companyName: "RIOMAR", lastAmountCents: 3000, lastRechargeDate: "2026-10-01" };

test("sem finance:manage recebe 403", async () => {
  for (const [handler, method, path] of [[route.GET, "GET", "/api/finance/phone-recharges"], [route.POST, "POST", "/api/finance/phone-recharges"], [bulk.POST, "POST", "/api/finance/phone-recharges/bulk"]]) {
    assert.equal((await callRoute(handler, NO_FINANCE, method, path, method === "GET" ? undefined : {})).status, 403, path);
  }
});

let a = "", b = "";
test("criar com 30 → +30; sem período → 90; inválido 400; editar recalcula pela última recarga", async () => {
  const created = await json(await post(route.POST, "/api/finance/phone-recharges", { ...base, periodDays: 30 }));
  a = created.id;
  assert.equal(created.nextRechargeDate, "2026-10-31");
  assert.equal(line(a).period_days, 30);
  b = (await json(await post(route.POST, "/api/finance/phone-recharges", { ...base, phoneNumber: "81988880000" }))).id;
  assert.equal(line(b).period_days, 90);
  assert.equal(line(b).next_recharge_date, "2026-12-30");
  const bad = await post(route.POST, "/api/finance/phone-recharges", { ...base, periodDays: 45 });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).error, "ESCOLHA 30, 60 OU 90 DIAS.");
  await post(route.POST, "/api/finance/phone-recharges", { ...base, id: a, periodDays: 60 });
  assert.equal(line(a).next_recharge_date, "2026-11-30");
  const list = await json(await callRoute(route.GET, ADMIN, "GET", "/api/finance/phone-recharges"));
  assert.deepEqual(list.rows.map((row) => row.periodDays).sort(), [60, 90]);
});

test("registrar recarga usa o período da linha", async () => {
  const res = await json(await post(recharge.POST, `/api/finance/phone-recharges/${a}/recharge`, { rechargeDate: "2026-11-20", amountCents: 3500, financeItemId: "item-recarga" }, { id: a }));
  assert.equal(res.nextRechargeDate, "2027-01-19");
  assert.equal(line(a).last_amount_cents, 3500);
});

test("linha antiga (antes do 8/9) mantém a data gravada até a próxima recarga/edição", async () => {
  db.insert("finance_phone_recharges", { id: "old", phone_number: "81977770000", company_id: "criomar01", company_name: "RIOMAR", last_recharge_date: "2026-08-31", next_recharge_date: "2026-11-30", last_amount_cents: 2000 });
  assert.equal(line("old").period_days, 90);
  assert.equal(line("old").next_recharge_date, "2026-11-30");
});

test("lote: alterar período, registrar recarga (valor vazio = último), ativar/desativar, excluir e 404", async () => {
  assert.equal((await post(bulk.POST, "/api/finance/phone-recharges/bulk", { action: "period", ids: [a], fields: { periodDays: 45 } })).status, 400);
  await post(bulk.POST, "/api/finance/phone-recharges/bulk", { action: "period", ids: [a, b], fields: { periodDays: 30 } });
  assert.equal(line(a).next_recharge_date, "2026-12-20"); // última 20/11 + 30
  assert.equal(line(b).next_recharge_date, "2026-10-31"); // última 01/10 + 30

  const rec = await json(await post(bulk.POST, "/api/finance/phone-recharges/bulk", { action: "recharge", ids: [a, b, "old"], fields: { date: "2026-12-01", financeItemId: "item-recarga" } }));
  assert.equal(rec.applied, 3);
  assert.equal(line(a).last_amount_cents, 3500);
  assert.equal(line(b).last_amount_cents, 3000);
  assert.equal(line(a).next_recharge_date, "2026-12-31");
  assert.equal(line("old").next_recharge_date, "2027-03-01"); // linha antiga: 90 dias
  const events = db.sqlite.prepare("SELECT recharge_id, amount_cents FROM finance_phone_recharge_events WHERE recharge_date='2026-12-01'").all();
  assert.equal(events.length, 3);
  await post(bulk.POST, "/api/finance/phone-recharges/bulk", { action: "recharge", ids: [b], fields: { date: "2026-12-05", amountCents: 4000, financeItemId: "item-recarga" } });
  assert.equal(line(b).last_amount_cents, 4000);

  await post(bulk.POST, "/api/finance/phone-recharges/bulk", { action: "deactivate", ids: [a, b] });
  assert.equal(line(a).active, 0);
  await post(bulk.POST, "/api/finance/phone-recharges/bulk", { action: "activate", ids: [a] });
  assert.equal(line(a).active, 1);

  assert.equal((await post(bulk.POST, "/api/finance/phone-recharges/bulk", { action: "delete", ids: [a, "nao-existe"] })).status, 404);
  await post(bulk.POST, "/api/finance/phone-recharges/bulk", { action: "delete", ids: [a] });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM finance_phone_recharges WHERE id=?").get(a).n, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM finance_phone_recharge_events WHERE recharge_id=?").get(a).n, 0);
});

test("registrar recarga lança a Despesa do mês EM ABERTO na unidade da linha (vence na data da recarga)", async () => {
  const lineId = (await json(await post(route.POST, "/api/finance/phone-recharges", { ...base, phoneNumber: "81955550000", periodDays: 30 }))).id;
  const noItem = await post(recharge.POST, `/api/finance/phone-recharges/${lineId}/recharge`, { rechargeDate: "2026-10-09", amountCents: 2500 }, { id: lineId });
  assert.equal(noItem.status, 400);
  const res = await json(await post(recharge.POST, `/api/finance/phone-recharges/${lineId}/recharge`, { rechargeDate: "2026-10-09", amountCents: 2500, financeItemId: "item-recarga" }, { id: lineId }));
  const expense = { ...db.sqlite.prepare("SELECT company_id, description, original_amount_cents, due_date FROM expenses WHERE id=?").get(res.expenseId) };
  assert.deepEqual(expense, { company_id: "criomar01", description: "RECARGA 81955550000 (TIM)", original_amount_cents: 2500, due_date: "2026-10-09" });
  const payable = { ...db.sqlite.prepare("SELECT status, due_date, original_amount_cents FROM accounts_payable WHERE expense_id=?").get(res.expenseId) };
  assert.deepEqual(payable, { status: "open", due_date: "2026-10-09", original_amount_cents: 2500 });
  assert.equal(db.sqlite.prepare("SELECT expense_id FROM finance_phone_recharge_events WHERE recharge_id=?").get(lineId).expense_id, res.expenseId);
});
