import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Dívida/nota de fornecedor (11/11/2026): sem categoria usa o item padrão
// (recriado se foi excluído do catálogo — era o erro "ITEM FINANCEIRO NÃO
// ENCONTRADO"); DESCRIÇÃO e DATA PREVISTA opcionais; sem data = SEM DATA,
// nunca vencida e fora da projeção até informar.

const db = await setupRouteDb([
  "shared_state", "accounts_payable", "accounts_payable_payments", "finance_items", "finance_categories", "finance_accounts",
  "finance_cost_centers", "finance_store_entries", "finance_rateio_model_shares", "finance_suppliers",
  "supplier_open_debts", "supplier_invoices", "finance_store_revenue", "finance_store_headcount",
  "accounts_receivable", "hr_payroll_entries", "hr_benefits", "hr_commissions", "finance_cash_flow_settings",
  "finance_account_balances", "finance_account_weekly_balances",
]);
const debts = await import("../app/api/finance/supplier-debts/route.ts");
const debtById = await import("../app/api/finance/supplier-debts/[id]/route.ts");
const cashFlow = await import("../app/api/finance/cash-flow/route.ts");
const { computeDisplayStatus } = await import("../app/lib/finance-status.ts");

const ALFA = "clojaalfa1";
const ADMIN = { id: "admin", role: "admin" };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }]) });
db.insert("finance_suppliers", { id: "sup-1", name: "OEX", active: 1, created_by: "admin" });
const one = (sql, ...params) => db.prepare(sql).bind(...params).first();

test("sem categoria, descrição e data: cadastra no item padrão recriado, SEM DATA e fora da projeção", async () => {
  assert.equal(await one("SELECT id FROM finance_items WHERE id='seed-supplier-open-debt-item'"), null, "item padrão excluído");
  const response = await callRoute(debts.POST, ADMIN, "POST", "/api/finance/supplier-debts", {
    idempotencyKey: "k1", companyId: ALFA, companyName: "LOJA ALFA", supplierId: "sup-1", invoiceNumber: "123",
    originalAmountCents: 50_000,
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const { id } = await response.json();
  const payable = await one("SELECT description, due_date AS dueDate, competence_month AS month, finance_item_id AS item FROM accounts_payable");
  assert.equal(payable.description, "NF 123");
  assert.equal(payable.dueDate, "");
  assert.match(payable.month, /^\d{4}-\d{2}$/);
  assert.equal(payable.item, "seed-supplier-open-debt-item");
  assert.ok(await one("SELECT id FROM finance_items WHERE id='seed-supplier-open-debt-item'"), "item padrão recriado");
  assert.equal(computeDisplayStatus({ storedStatus: "open", dueDate: "", today: "2026-11-11" }), "upcoming", "sem data não vence");

  const flow = await (await callRoute(cashFlow.GET, ADMIN, "GET", "/api/finance/cash-flow")).json();
  assert.equal(flow.days.reduce((sum, day) => sum + day.saidasCents, 0), 0, "sem data fica fora da projeção");

  // Informar a data depois coloca na projeção.
  const edited = await callRoute(debtById.PATCH, ADMIN, "PATCH", `/api/finance/supplier-debts/${id}`, { dueDate: flow.today }, { id });
  assert.equal(edited.status, 200, JSON.stringify(await edited.clone().json()));
  const after = await (await callRoute(cashFlow.GET, ADMIN, "GET", "/api/finance/cash-flow")).json();
  assert.equal(after.days.reduce((sum, day) => sum + day.saidasCents, 0), 50_000);

  // Sem nota: a descrição vira o nome do fornecedor.
  const second = await callRoute(debts.POST, ADMIN, "POST", "/api/finance/supplier-debts", {
    idempotencyKey: "k2", companyId: ALFA, companyName: "LOJA ALFA", supplierId: "sup-1", originalAmountCents: 1_000,
  });
  assert.equal(second.status, 201);
  assert.ok(await one("SELECT id FROM accounts_payable WHERE description='OEX'"));
});
