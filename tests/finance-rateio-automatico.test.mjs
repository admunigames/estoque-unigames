import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Rateio AUTOMÁTICO das Despesas (04/11/2026): UMA conta por ocorrência e a
// divisão entre as lojas só na DRE, pelo Feito do mês de cada conta; sem
// Feito = RATEIO PENDENTE, recalculado quando o Feito chega/muda.

const db = await setupRouteDb([
  "shared_state", "accounts_payable", "accounts_payable_payments", "accounts_payable_payment_attachments", "expenses",
  "expense_rateio_shares", "expense_attachments", "commercial_store_goals", "finance_items", "finance_categories",
  "finance_cost_centers", "finance_store_entries", "finance_accounts", "finance_dre_allocations", "finance_suppliers",
  "supplier_open_debts", "hr_employees", "hr_terminations", "hr_schedule_assignments",
]);
const expenses = await import("../app/api/finance/expenses/route.ts");
const expensesBulk = await import("../app/api/finance/expenses/bulk/route.ts");
const preview = await import("../app/api/finance/expenses/rateio-preview/route.ts");
const payables = await import("../app/api/finance/payables/route.ts");
const { recalcAutoRateios } = await import("../app/api/finance/payables/dre-destination.ts");

const ADMIN = { id: "admin", role: "admin" };
const ALFA = "clojaalfa1", BETA = "clojabeta1", DEP = "cdeposito1";
db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }, { id: BETA, name: "LOJA BETA" }, { id: DEP, name: "DEPÓSITO" }]),
});
db.insert("finance_categories", { id: "cat-1", name: "OPERACIONAL" });
db.insert("finance_items", { id: "item-1", category_id: "cat-1", name: "MARKETING" });
const SYS = { id: "sys", name: "SISTEMA" };
const goal = (company, month, sales, services = 0) =>
  db.sqlite.prepare(
    `INSERT INTO commercial_store_goals (id, month, company_id, revenue_cents, assist_revenue_cents) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (month, company_id) DO UPDATE SET revenue_cents=excluded.revenue_cents, assist_revenue_cents=excluded.assist_revenue_cents`,
  ).run(crypto.randomUUID(), month, company, sales, services);
const cell = (store, month) =>
  db.sqlite.prepare("SELECT amount_cents AS c FROM finance_store_entries WHERE store_id=? AND item_id='item-1' AND month=?").get(store, month)?.c ?? 0;
const allocs = (payableId) =>
  db.sqlite.prepare("SELECT store_id AS s, percent_basis_points AS bp, amount_cents AS c FROM finance_dre_allocations WHERE payable_id=? ORDER BY store_id").all(payableId).map((r) => [r.s, r.bp, r.c]);
const body = (extra) => ({
  idempotencyKey: crypto.randomUUID(), kind: "single", companyId: ALFA, companyName: "LOJA ALFA",
  description: "CAMPANHA", financeItemId: "item-1", originalAmountCents: 100_000, dueDate: "2030-11-10",
  rateioType: "rateio", rateioModel: "faturamento", rateioCompanyIds: [], ...extra,
});

let expenseId = "";
let payableId = "";
test("sem Feito no mês: prévia avisa e a despesa entra como RATEIO PENDENTE (uma conta, fora da DRE)", async () => {
  const pre = await (await callRoute(preview.POST, ADMIN, "POST", "/api/finance/expenses/rateio-preview", { rateioModel: "faturamento", competenceMonth: "2030-11", originalAmountCents: 100 })).json();
  assert.match(pre.pending, /RATEIO PENDENTE/);
  const res = await callRoute(expenses.POST, ADMIN, "POST", "/api/finance/expenses", body());
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const created = await res.json();
  expenseId = created.id;
  assert.equal(created.payableIds.length, 1);
  payableId = created.payableIds[0];
  const row = db.sqlite.prepare("SELECT dre_target AS t, dre_rateio_model AS m, dre_rateio_scope AS s FROM accounts_payable WHERE id=?").get(payableId);
  assert.deepEqual([row.t, row.m, JSON.parse(row.s)], ["rateio", "faturamento", { itemId: "item-1", companyIds: [] }]);
  assert.deepEqual(allocs(payableId), []);
  assert.equal(cell(ALFA, "2030-11"), 0);
  const listed = await (await callRoute(payables.GET, ADMIN, "GET", "/api/finance/payables?pageSize=50")).json();
  assert.equal(Number(listed.rows.find((p) => p.id === payableId || p.groupIds?.includes(payableId)).rateioPending), 1);
  const exp = await (await callRoute(expenses.GET, ADMIN, "GET", "/api/finance/expenses?pageSize=50")).json();
  assert.equal(Number(exp.rows.find((e) => e.id === expenseId).rateioPendingCount), 1);
});

test("Feito lançado: 75% / 25% só entre as lojas (depósito fora); mudou → recalcula; igual → nada", async () => {
  goal(ALFA, "2030-11", 75_000);
  goal(BETA, "2030-11", 20_000, 5_000);
  assert.equal(await recalcAutoRateios(globalThis.__routeTestDb, { months: ["2030-11"] }, SYS), 1);
  assert.deepEqual(allocs(payableId), [[ALFA, 7500, 75_000], [BETA, 2500, 25_000]]);
  assert.deepEqual([cell(ALFA, "2030-11"), cell(BETA, "2030-11"), cell(DEP, "2030-11")], [75_000, 25_000, 0]);
  goal(BETA, "2030-11", 70_000, 5_000);
  assert.equal(await recalcAutoRateios(globalThis.__routeTestDb, { months: ["2030-11"] }, SYS), 1);
  assert.deepEqual([cell(ALFA, "2030-11"), cell(BETA, "2030-11")], [50_000, 50_000]);
  assert.equal(await recalcAutoRateios(globalThis.__routeTestDb, { months: ["2030-11"] }, SYS), 0);
});

test("recorrente: cada mês pelo Feito dele (novembro dividido, dezembro pendente); UNIGAMES = só vendas", async () => {
  const res = await callRoute(expenses.POST, ADMIN, "POST", "/api/finance/expenses",
    body({ kind: "recurring", recurrenceFrequency: "monthly", recurrenceOccurrenceCount: 2, rateioModel: "faturamento_vendas", originalAmountCents: 30_000 }));
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const [nov, dec] = (await res.json()).payableIds;
  assert.deepEqual(allocs(nov), [[ALFA, 5172, 15_516], [BETA, 4828, 14_484]]); // 75.000 × 70.000
  assert.deepEqual(allocs(dec), []);
  goal(ALFA, "2030-12", 10_000);
  await recalcAutoRateios(globalThis.__routeTestDb, { months: ["2030-12"] }, SYS);
  assert.deepEqual(allocs(dec), [[ALFA, 10000, 30_000]]);
});

test("excluir a despesa tira as fatias e a DRE das lojas", async () => {
  const res = await callRoute(expensesBulk.POST, ADMIN, "POST", "/api/finance/expenses/bulk", { action: "delete", ids: [expenseId] });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual(allocs(payableId), []);
  assert.equal(cell(BETA, "2030-11") < 50_000, true);
});

test("Comercial (Feito) e cron disparam o recálculo", async () => {
  const stores = await readFile(new URL("../app/api/commercial/stores/route.ts", import.meta.url), "utf8");
  assert.match(stores, /recalcAutoRateios\(database, \{ months: \[month\] \}/);
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /recalcAutoRateiosDaily\(env\.DB\)/);
});

test("Contas a Pagar RATEAR por FUNCIONÁRIOS: atuantes do RH (2 × 1), sem ninguém = pendente", async () => {
  const create = (extra) =>
    callRoute(payables.POST, ADMIN, "POST", "/api/finance/payables", {
      idempotencyKey: crypto.randomUUID(), description: "CONTADOR", financeItemId: "item-1", originalAmountCents: 30_000,
      dueDate: "2030-11-20", dreTarget: "rateio", dreRateioModel: "funcionarios", ...extra,
    });
  const empty = await create({});
  assert.equal(empty.status, 201, JSON.stringify(await empty.clone().json()));
  const [pendingId] = (await empty.json()).ids;
  assert.deepEqual(allocs(pendingId), []);
  for (const [id, company] of [["e1", ALFA], ["e2", ALFA], ["e3", BETA], ["e4", DEP]]) {
    db.insert("hr_employees", { id, full_name: id, company_id: company, company_name: company, status: "active", cpf: id });
  }
  await recalcAutoRateios(globalThis.__routeTestDb, { months: ["2030-11"] }, SYS);
  assert.deepEqual(allocs(pendingId), [[ALFA, 6667, 20_001], [BETA, 3333, 9_999]]);
});
