import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// CADASTRAR EM LOTE e EXCLUIR EM LOTE do Financeiro (prompt 3, 22/10/2026):
// cada linha passa pela validação do cadastro individual; prévia (dryRun)
// confere sem gravar; o lote grava tudo ou nada.

const db = await setupRouteDb([
  "shared_state", "accounts_payable", "accounts_payable_payments", "accounts_payable_payment_attachments",
  "finance_items", "finance_accounts", "finance_cost_centers", "finance_store_entries", "finance_suppliers",
  "supplier_open_debts", "supplier_invoices", "supplier_invoice_installments", "supplier_invoice_events",
  "expenses", "expense_rateio_shares", "expense_attachments", "finance_rateio_model_shares",
  "finance_store_revenue", "finance_store_headcount",
]);

const ALFA = "clojaalfa1";
const BETA = "clojabeta1";
const ADMIN = { id: "admin", role: "admin" };
const STORE_USER = { id: "u-loja", permissions: ["finance:manage"], companyId: ALFA };

db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }, { id: BETA, name: "LOJA BETA" }]),
});
db.insert("finance_items", { id: "item-luz", category_id: "cat-1", name: "ENERGIA", created_by: "admin" });
db.insert("finance_items", { id: "seed-supplier-open-debt-item", category_id: "cat-1", name: "FORNECEDORES", created_by: "admin" });
db.insert("finance_suppliers", { id: "sup-1", name: "FORNECEDOR UM", active: 1, created_by: "admin" });

const count = (table, where = "1=1") => db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
const batch = (route, actor, path, rows, dryRun = false) => callRoute(route.POST, actor, "POST", path, { rows, dryRun, batchKey: `b-${Math.random()}` });

test("Contas a Pagar: prévia aponta a linha com erro; lote com erro não grava nada; lote válido grava tudo", async () => {
  const route = await import("../app/api/finance/payables/batch/route.ts");
  const good = { companyId: ALFA, description: "LUZ", financeItemId: "item-luz", originalAmountCents: 1000, dueDate: "2026-10-10" };
  const bad = { companyId: ALFA, description: "SEM VALOR", financeItemId: "item-luz", originalAmountCents: 0, dueDate: "2026-10-10" };
  const preview = await batch(route, ADMIN, "/api/finance/payables/batch", [good, bad], true);
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.equal(previewBody.ok, false);
  assert.deepEqual(previewBody.errors.map((e) => e.line), [2]);
  assert.match(previewBody.errors[0].error, /VALOR VÁLIDO/);
  assert.equal(count("accounts_payable"), 0);

  const failed = await batch(route, ADMIN, "/api/finance/payables/batch", [good, bad]);
  assert.equal(failed.status, 400);
  assert.equal(count("accounts_payable"), 0, "tudo ou nada");

  const ok = await batch(route, ADMIN, "/api/finance/payables/batch", [good, { ...good, description: "AGUA", companyId: "", payerName: "pf", dreTarget: "none" }]);
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).created, 2);
  assert.equal(count("accounts_payable"), 2);
  assert.equal(count("accounts_payable", "company_id='' AND payer_name='PF' AND dre_target='none'"), 1);
  assert.equal(db.sqlite.prepare("SELECT amount_cents AS c FROM finance_store_entries WHERE store_id=?").get(ALFA).c, 1000);

  // Login de loja: linha de outra loja é recusada.
  const other = await (await batch(route, STORE_USER, "/api/finance/payables/batch", [{ ...good, companyId: BETA }], true)).json();
  assert.match(other.errors[0].error, /PRÓPRIA LOJA/);
});
