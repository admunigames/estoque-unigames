import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Financeiro 9/9 — ações em lote nos módulos que ainda não tinham (rotas
// reais sobre SQLite): Contas a Pagar + Fornecedores em Aberto, Notas
// Fiscais, Conciliação Bancária, Controle de Reposição, Orçamento e Obras.
// Para cada lote: caminho feliz, id inexistente → 404 sem gravar nada, outra
// loja → 403, item bloqueado pela regra individual → pulado com motivo, 403
// sem finance:manage.

const db = await setupRouteDb([
  "accounts_payable", "accounts_payable_payments", "finance_items", "finance_categories", "finance_cost_centers",
  "finance_store_entries", "finance_accounts", "supplier_open_debts", "finance_suppliers",
]);
const { todayInTimezone } = await import("../app/lib/finance-status.ts");
const payablesBulk = await import("../app/api/finance/payables/bulk/route.ts");
const cashFlowBulk = await import("../app/api/finance/cash-flow/payments/bulk/route.ts");
const debtsBulk = await import("../app/api/finance/supplier-debts/bulk/route.ts");

const STORE_A = "criomar01";
const STORE_B = "ctacaruna1";
const ADMIN = { id: "admin", role: "admin" };
const STORE_A_LOGIN = { id: "fin-a", companyId: STORE_A, permissions: ["finance:manage"] };
const NO_FINANCE = { id: "loja", permissions: ["outputs:view"] };
const today = todayInTimezone();
const month = today.slice(0, 7);
const json = (response) => response.json();
const post = (handler, user, path, body) => callRoute(handler, user, "POST", path, body);
const row = (table, id) => ({ ...db.sqlite.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) });

const payable = (id, extra) =>
  db.insert("accounts_payable", {
    id, company_id: STORE_A, company_name: "RIOMAR", description: id.toUpperCase(), finance_item_id: "item-1",
    original_amount_cents: 10_000, paid_amount_cents: 0, competence_month: month, due_date: today,
    status: "open", idempotency_key: `k-${id}`, created_by: "seed", ...extra,
  });
db.insert("finance_categories", { id: "cat-1", name: "OPERACIONAL" });
db.insert("finance_items", { id: "item-1", category_id: "cat-1", name: "ALUGUEL" });
db.insert("finance_items", { id: "item-2", category_id: "cat-1", name: "ENERGIA" });
db.insert("finance_cost_centers", { id: "cc-1", name: "LOJA" });

test("sem finance:manage recebe 403 em todos os lotes", async () => {
  for (const [handler, path] of [
    [payablesBulk.POST, "/api/finance/payables/bulk"],
    [debtsBulk.POST, "/api/finance/supplier-debts/bulk"],
  ]) {
    assert.equal((await post(handler, NO_FINANCE, path, {})).status, 403, path);
  }
});

// ---------------------------------------------------------------------------
// 1. Contas a Pagar + Fornecedores em Aberto
// ---------------------------------------------------------------------------

test("Contas a Pagar e Fluxo de Caixa: MARCAR COMO PAGO dá o MESMO resultado (mesma função)", async () => {
  payable("p-cp"); payable("p-cf");
  await post(payablesBulk.POST, ADMIN, "/api/finance/payables/bulk", { action: "pay", ids: ["p-cp"], fields: { paymentDate: today } });
  await post(cashFlowBulk.POST, ADMIN, "/api/finance/cash-flow/payments/bulk", { action: "pay", ids: ["p-cf"], fields: { paymentDate: today } });
  const pick = (id) => {
    const p = row("accounts_payable", id);
    const pay = db.sqlite.prepare("SELECT amount_cents, payment_date, scheduled FROM accounts_payable_payments WHERE payable_id=?").get(id);
    return { status: p.status, paid: p.paid_amount_cents, payment: { ...pay } };
  };
  assert.deepEqual(pick("p-cp"), pick("p-cf"));
  assert.deepEqual(pick("p-cp"), { status: "paid", paid: 10_000, payment: { amount_cents: 10_000, payment_date: today, scheduled: 0 } });
});

test("Contas a Pagar: vencimento, categoria/centro de custo (DRE recalculada), cancelar e pulados com motivo", async () => {
  payable("p-1"); payable("p-2"); payable("p-paga", { status: "paid", paid_amount_cents: 10_000 }); payable("p-canc", { status: "canceled" });
  const res = await json(await post(payablesBulk.POST, ADMIN, "/api/finance/payables/bulk", {
    action: "reschedule", ids: ["p-1", "p-paga", "p-canc"], fields: { dueDate: "2030-01-10" },
  }));
  assert.equal(res.applied, 1);
  assert.deepEqual(res.skipped.map((s) => s.reason), ["CONTA JÁ PAGA", "CONTA CANCELADA"]);
  assert.equal(row("accounts_payable", "p-1").due_date, "2030-01-10");

  await post(payablesBulk.POST, ADMIN, "/api/finance/payables/bulk", { action: "category", ids: ["p-1", "p-2"], fields: { financeItemId: "item-2", costCenterId: "cc-1" } });
  assert.equal(row("accounts_payable", "p-1").finance_item_id, "item-2");
  assert.equal(row("accounts_payable", "p-2").cost_center, "LOJA");
  const dre = db.sqlite.prepare("SELECT amount_cents FROM finance_store_entries WHERE store_id=? AND item_id='item-2' AND month=?").get(STORE_A, month);
  assert.equal(dre.amount_cents, 20_000);
  // Só o centro de custo: o item fica.
  await post(payablesBulk.POST, ADMIN, "/api/finance/payables/bulk", { action: "category", ids: ["p-1"], fields: { costCenterId: "" } });
  assert.equal(row("accounts_payable", "p-1").finance_item_id, "item-2");
  assert.equal(row("accounts_payable", "p-1").cost_center_id, null);

  const canceled = await json(await post(payablesBulk.POST, ADMIN, "/api/finance/payables/bulk", { action: "cancel", ids: ["p-1", "p-paga"] }));
  assert.equal(canceled.applied, 1);
  assert.deepEqual(canceled.skipped.map((s) => s.reason), ["CONTA JÁ PAGA"]);
  assert.equal(row("accounts_payable", "p-1").status, "canceled");
  assert.equal(db.sqlite.prepare("SELECT amount_cents FROM finance_store_entries WHERE store_id=? AND item_id='item-2' AND month=?").get(STORE_A, month).amount_cents, 10_000);
});

test("Contas a Pagar: id inexistente → 404 sem gravar nada; outra loja → 403", async () => {
  payable("p-x"); payable("p-b", { company_id: STORE_B });
  const missing = await post(payablesBulk.POST, ADMIN, "/api/finance/payables/bulk", { action: "reschedule", ids: ["p-x", "nao-existe"], fields: { dueDate: "2031-01-01" } });
  assert.equal(missing.status, 404);
  assert.equal(row("accounts_payable", "p-x").due_date, today);
  assert.equal((await post(payablesBulk.POST, STORE_A_LOGIN, "/api/finance/payables/bulk", { action: "cancel", ids: ["p-x", "p-b"] })).status, 403);
  assert.equal(row("accounts_payable", "p-x").status, "open");
});

test("Fornecedores em Aberto: pagar e cancelar pela conta gêmea; dívida cancelada pulada; 404/403", async () => {
  const debt = (id, payableId, extra) => db.insert("supplier_open_debts", {
    id, company_id: STORE_A, company_name: "RIOMAR", description: id.toUpperCase(), original_amount_cents: 10_000,
    due_date: today, accounts_payable_id: payableId, created_by: "seed", ...extra,
  });
  payable("ap-d1"); payable("ap-d2"); payable("ap-d3"); payable("ap-db", { company_id: STORE_B });
  debt("d1", "ap-d1"); debt("d2", "ap-d2"); debt("d3", "ap-d3", { canceled: 1 }); debt("db", "ap-db", { company_id: STORE_B });
  const paid = await json(await post(debtsBulk.POST, ADMIN, "/api/finance/supplier-debts/bulk", { action: "pay", ids: ["d1", "d3"], fields: { paymentDate: today } }));
  assert.equal(paid.applied, 1);
  assert.deepEqual(paid.skipped.map((s) => [s.id, s.reason]), [["d3", "DÍVIDA CANCELADA"]]);
  assert.equal(row("accounts_payable", "ap-d1").status, "paid");
  await post(debtsBulk.POST, ADMIN, "/api/finance/supplier-debts/bulk", { action: "cancel", ids: ["d2"] });
  assert.equal(row("supplier_open_debts", "d2").canceled, 1);
  assert.equal(row("accounts_payable", "ap-d2").status, "canceled");
  assert.equal((await post(debtsBulk.POST, ADMIN, "/api/finance/supplier-debts/bulk", { action: "cancel", ids: ["d1", "zzz"] })).status, 404);
  assert.equal((await post(debtsBulk.POST, STORE_A_LOGIN, "/api/finance/supplier-debts/bulk", { action: "cancel", ids: ["db"] })).status, 403);
});
