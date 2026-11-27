import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Controle de Reposição (27/11/2026): a despesa criada pela reposição já nasce
// PAGA (pago pelo responsável na data do lançamento), não aparece no Contas a
// Pagar e continua em Despesas; OUTROS (SAÍDA) e ENTRADAS não viram despesa.
// Dados fictícios.

const db = await setupRouteDb([
  "shared_state", "accounts_payable", "accounts_payable_payments", "finance_items", "finance_categories", "finance_accounts",
  "finance_cost_centers", "finance_store_entries", "finance_rateio_model_shares", "finance_suppliers",
  "supplier_open_debts", "supplier_invoices", "supplier_invoice_installments", "supplier_invoice_events",
  "expenses", "expense_rateio_shares", "finance_store_revenue", "finance_store_headcount",
  "finance_replacement_entries", "finance_replacement_balances",
]);
const replacement = await import("../app/api/finance/replacement-control/route.ts");
const expenses = await import("../app/api/finance/expenses/route.ts");
const payables = await import("../app/api/finance/payables/route.ts");
const ALFA = "clojaalfa1";
const FIN = { id: "fin", name: "LUANA", role: "admin" };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }]) });
db.insert("finance_categories", { id: "cat-op", name: "OPERACIONAL", parent_id: null, position: 0, created_by: "admin" });
db.insert("finance_items", { id: "item-comb", category_id: "cat-op", name: "COMBUSTÍVEL", created_by: "admin" });

const api = "/api/finance/replacement-control";
const newEntry = async (extra) => (await (await callRoute(replacement.POST, FIN, "POST", api, {
  entryDate: "2026-11-05", reason: "GASOLINA", responsibleName: "CECILLIA", kind: "saida", amountCents: 12_000, ...extra,
})).json()).id;

test("ADICIONAR despesa na reposição: despesa paga na data do lançamento, fora do Contas a Pagar, dentro de Despesas", async () => {
  const id = await newEntry();
  const created = await (await callRoute(expenses.POST, FIN, "POST", "/api/finance/expenses", {
    idempotencyKey: `reposicao:${id}`, allowDuplicate: true, kind: "single", companyId: ALFA, companyName: "LOJA ALFA",
    description: "Reposição: GASOLINA", financeItemId: "item-comb", originalAmountCents: 12_000,
    issueDate: "2026-11-05", dueDate: "2026-11-30", paymentMethod: "CONTROLE DE REPOSIÇÃO",
  })).json();
  const patch = await callRoute(replacement.PATCH, FIN, "PATCH", api, { id, expenseId: created.id, financeItemId: "item-comb" });
  assert.equal(patch.status, 200);
  const payable = db.sqlite.prepare("SELECT id, status, paid_amount_cents AS paid FROM accounts_payable WHERE expense_id=?").get(created.id);
  assert.deepEqual([payable.status, payable.paid], ["paid", 12_000]);
  const payment = db.sqlite.prepare("SELECT payment_date AS d, payment_method AS m FROM accounts_payable_payments WHERE payable_id=?").get(payable.id);
  assert.deepEqual([payment.d, payment.m], ["2026-11-05", "CONTROLE DE REPOSIÇÃO"]);
  const list = await (await callRoute(payables.GET, FIN, "GET", "/api/finance/payables?pageSize=100")).json();
  assert.equal(list.rows.some((row) => row.id === payable.id), false, "fora do Contas a Pagar");
  const exp = await (await callRoute(expenses.GET, FIN, "GET", "/api/finance/expenses?pageSize=100")).json();
  assert.equal(exp.rows.some((row) => row.id === created.id), true, "continua em Despesas");
  // Vincular de novo não paga duas vezes.
  assert.equal((await callRoute(replacement.PATCH, FIN, "PATCH", api, { id, expenseId: created.id })).status, 200);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM accounts_payable_payments WHERE payable_id=?").get(payable.id).n, 1);
});

test("OUTROS (SAÍDA) e ENTRADA não viram despesa", async () => {
  for (const kind of ["outros_saida", "entrada", "outros_entrada"]) {
    const id = await newEntry({ kind });
    const res = await callRoute(replacement.PATCH, FIN, "PATCH", api, { id, expenseId: "qualquer" });
    assert.equal(res.status, 400, kind);
  }
});
