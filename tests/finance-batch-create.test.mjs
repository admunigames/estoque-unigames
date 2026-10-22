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

test("Fornecedores: cadastro em lote (dívida + conta gêmea) e EXCLUIR em lote só da cancelada sem pagamento", async () => {
  const route = await import("../app/api/finance/supplier-debts/batch/route.ts");
  const bulk = await import("../app/api/finance/supplier-debts/bulk/route.ts");
  const row = { companyId: ALFA, supplierId: "sup-1", description: "COMPRA", originalAmountCents: 500, dueDate: "2026-10-20" };
  const failed = await batch(route, ADMIN, "/api/finance/supplier-debts/batch", [row, { ...row, supplierId: "" }]);
  assert.equal(failed.status, 400);
  assert.match((await failed.json()).errors[0].error, /FORNECEDOR/);
  assert.equal(count("supplier_open_debts"), 0);
  const ok = await batch(route, ADMIN, "/api/finance/supplier-debts/batch", [row, { ...row, description: "OUTRA", companyId: "" }]);
  assert.equal(ok.status, 201);
  assert.equal(count("supplier_open_debts"), 2);
  assert.equal(count("accounts_payable", "idempotency_key LIKE 'supplier-debt:supplier-debts-batch:%'"), 2);

  const [open, toDelete] = db.sqlite.prepare("SELECT id, accounts_payable_id AS payableId FROM supplier_open_debts ORDER BY description").all();
  db.sqlite.prepare("UPDATE accounts_payable SET status='canceled' WHERE id=?").run(toDelete.payableId);
  db.sqlite.prepare("UPDATE supplier_open_debts SET canceled=1 WHERE id=?").run(toDelete.id);
  const res = await callRoute(bulk.POST, ADMIN, "POST", "/api/finance/supplier-debts/bulk", { action: "delete", ids: [open.id, toDelete.id] });
  const body = await res.json();
  assert.equal(body.applied, 1);
  assert.match(body.skipped[0].reason, /CANCELE A DÍVIDA/);
  assert.equal(count("supplier_open_debts"), 1);
  assert.equal((await callRoute(bulk.POST, ADMIN, "POST", "/api/finance/supplier-debts/bulk", { action: "delete", ids: ["nao-existe"] })).status, 404);
});

test("Despesas: cadastro em lote e barra de lote (categoria nas contas e EXCLUIR sem pagamento)", async () => {
  const route = await import("../app/api/finance/expenses/batch/route.ts");
  const bulk = await import("../app/api/finance/expenses/bulk/route.ts");
  db.insert("finance_items", { id: "item-agua", category_id: "cat-1", name: "ÁGUA", created_by: "admin" });
  const row = { companyId: BETA, description: "MATERIAL DE LIMPEZA", financeItemId: "item-luz", originalAmountCents: 2500, dueDate: "2026-11-05" };
  const preview = await (await batch(route, ADMIN, "/api/finance/expenses/batch", [row, { ...row, companyId: "" }], true)).json();
  assert.deepEqual(preview.errors.map((e) => e.line), [2]);
  assert.match(preview.errors[0].error, /EMPRESA\/LOJA/);
  const ok = await batch(route, ADMIN, "/api/finance/expenses/batch", [row, { ...row, description: "CAFÉ", originalAmountCents: 900 }]);
  assert.equal(ok.status, 201);
  assert.equal(count("expenses"), 2);
  const cell = () => db.sqlite.prepare("SELECT amount_cents AS c FROM finance_store_entries WHERE store_id=? AND item_id=? AND month='2026-11'").get(BETA, "item-luz")?.c ?? 0;
  assert.equal(cell(), 3400);

  const [cafe, limpeza] = db.sqlite.prepare("SELECT id FROM expenses ORDER BY description").all().map((r) => r.id);
  const category = await callRoute(bulk.POST, ADMIN, "POST", "/api/finance/expenses/bulk", { action: "category", ids: [cafe], fields: { financeItemId: "item-agua" } });
  assert.equal((await category.json()).applied, 1);
  assert.equal(db.sqlite.prepare("SELECT finance_item_id AS i FROM expenses WHERE id=?").get(cafe).i, "item-agua");
  assert.equal(db.sqlite.prepare("SELECT finance_item_id AS i FROM accounts_payable WHERE expense_id=?").get(cafe).i, "item-agua");
  assert.equal(cell(), 2500);

  const payableOfLimpeza = db.sqlite.prepare("SELECT id FROM accounts_payable WHERE expense_id=?").get(limpeza).id;
  db.insert("accounts_payable_payments", { id: "pay-limpeza", payable_id: payableOfLimpeza, amount_cents: 2500, payment_date: "2026-11-05", scheduled: 0, confirmed_at: "2026-11-05T10:00:00Z", created_by: "admin" });
  const del = await (await callRoute(bulk.POST, ADMIN, "POST", "/api/finance/expenses/bulk", { action: "delete", ids: [cafe, limpeza] })).json();
  assert.equal(del.applied, 1);
  assert.match(del.skipped[0].reason, /PAGAMENTO/);
  assert.equal(count("expenses"), 1);
  assert.equal(count("accounts_payable", `expense_id='${cafe}'`), 0);
  assert.equal((await callRoute(bulk.POST, ADMIN, "POST", "/api/finance/expenses/bulk", { action: "delete", ids: [cafe] })).status, 404);
  assert.equal((await callRoute(bulk.POST, STORE_USER, "POST", "/api/finance/expenses/bulk", { action: "delete", ids: [limpeza] })).status, 403);
});
