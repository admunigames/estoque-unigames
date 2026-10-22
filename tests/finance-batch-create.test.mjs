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
  "finance_bank_statement_entries", "finance_sales_recon_rows", "finance_credit_sales", "finance_replacement_entries",
  "accounts_receivable", "finance_acquirers", "finance_card_machines",
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

test("Notas Fiscais: cadastro em lote recusa NF repetida (no lote e já cadastrada) sem gravar nada", async () => {
  const route = await import("../app/api/finance/invoices/batch/route.ts");
  const row = { companyId: ALFA, supplierId: "sup-1", invoiceNumber: "1001", competenceMonth: "2026-10", totalAmountCents: 9900, financeItemId: "item-luz" };
  const repeated = await (await batch(route, ADMIN, "/api/finance/invoices/batch", [row, row], true)).json();
  assert.deepEqual(repeated.errors.map((e) => [e.line, e.error]), [[2, "NOTA REPETIDA NESTE LOTE."]]);
  const ok = await batch(route, ADMIN, "/api/finance/invoices/batch", [row, { ...row, invoiceNumber: "1002", companyId: "" }]);
  assert.equal(ok.status, 201);
  assert.equal(count("supplier_invoices"), 2);
  assert.equal(count("supplier_invoices", "finance_category_id='cat-1' AND origin='manual'"), 2);
  assert.equal(count("supplier_invoice_events", "event_type='created'"), 2);
  const again = await batch(route, ADMIN, "/api/finance/invoices/batch", [{ ...row, invoiceNumber: "1003" }, row]);
  assert.equal(again.status, 400);
  assert.match((await again.json()).errors[0].error, /JÁ EXISTE UMA NOTA FISCAL/);
  assert.equal(count("supplier_invoices"), 2, "tudo ou nada");
});

test("Conciliação Bancária: EXCLUIR em lote só o lançamento importado ainda não conciliado", async () => {
  const bulk = await import("../app/api/finance/bank-reconciliation/bulk/route.ts");
  const entry = (id, extra = {}) => db.insert("finance_bank_statement_entries", {
    id, import_id: "imp", finance_account_id: "acc", company_id: ALFA, entry_date: "2026-10-01", description: id.toUpperCase(),
    raw_merchant: "X", amount_cents: -100, status: "pending", ...extra,
  });
  entry("b-pend"); entry("b-class", { status: "classified" }); entry("b-conf", { status: "confirmed" });
  entry("b-desp", { status: "expensed" }); entry("b-vendas", { sales_recon_status: "ok" }); entry("b-repo");
  db.insert("finance_replacement_entries", { id: "rep-1", bank_entry_id: "b-repo" });
  const res = await callRoute(bulk.POST, ADMIN, "POST", "/api/finance/bank-reconciliation/bulk", {
    action: "delete", ids: ["b-pend", "b-class", "b-conf", "b-desp", "b-vendas", "b-repo"],
  });
  const body = await res.json();
  assert.equal(body.applied, 2);
  assert.deepEqual(body.skipped.map((s) => s.id).sort(), ["b-conf", "b-desp", "b-repo", "b-vendas"]);
  assert.equal(count("finance_bank_statement_entries"), 4);
  assert.equal((await callRoute(bulk.POST, ADMIN, "POST", "/api/finance/bank-reconciliation/bulk", { action: "delete", ids: ["b-pend"] })).status, 404);
});

test("Recebíveis: cadastro em lote e EXCLUIR em lote só o que não foi recebido", async () => {
  const route = await import("../app/api/finance/receivables/batch/route.ts");
  const bulk = await import("../app/api/finance/receivables/bulk/route.ts");
  const row = { companyId: ALFA, competenceMonth: "2026-10", operatorText: "STONE", amountCents: 12345 };
  const preview = await (await batch(route, ADMIN, "/api/finance/receivables/batch", [row, { ...row, amountCents: 0 }], true)).json();
  assert.deepEqual(preview.errors.map((e) => e.line), [2]);
  const ok = await batch(route, ADMIN, "/api/finance/receivables/batch", [row, { ...row, competenceMonth: "2026-11" }]);
  assert.equal(ok.status, 201);
  const ids = db.sqlite.prepare("SELECT id FROM accounts_receivable ORDER BY competence_month").all().map((r) => r.id);
  assert.equal(ids.length, 2);
  db.sqlite.prepare("UPDATE accounts_receivable SET received_amount_cents=12345, received_date='2026-10-31' WHERE id=?").run(ids[0]);
  const del = await (await callRoute(bulk.POST, ADMIN, "POST", "/api/finance/receivables/bulk", { action: "delete", ids })).json();
  assert.equal(del.applied, 1);
  assert.equal(del.skipped[0].reason, "JÁ RECEBIDO");
  assert.equal(count("accounts_receivable"), 1);
});

test("Maquinetas: cadastro em lote recusa serial repetido (no lote e já cadastrado) e adquirente de outra unidade", async () => {
  const route = await import("../app/api/finance/card-machines/batch/route.ts");
  db.insert("finance_acquirers", { id: "acq-1", name: "STONE", company_id: "", status: "active", created_by: "admin" });
  db.insert("finance_acquirers", { id: "acq-beta", name: "CIELO BETA", company_id: BETA, status: "active", created_by: "admin" });
  const row = { companyId: ALFA, acquirerId: "acq-1", model: "S920", serial: "ab-123" };
  const preview = await (await batch(route, ADMIN, "/api/finance/card-machines/batch", [row, row, { ...row, serial: "X9", acquirerId: "acq-beta" }], true)).json();
  assert.deepEqual(preview.errors.map((e) => [e.line, e.error]), [[2, "SERIAL REPETIDO NESTE LOTE."], [3, "ESSA ADQUIRENTE É DE OUTRA UNIDADE."]]);
  const ok = await batch(route, ADMIN, "/api/finance/card-machines/batch", [row, { ...row, serial: "CD-456" }]);
  assert.equal(ok.status, 201);
  assert.equal(count("finance_card_machines"), 2);
  const again = await (await batch(route, ADMIN, "/api/finance/card-machines/batch", [row], true)).json();
  assert.match(again.errors[0].error, /JÁ EXISTE UMA MAQUINETA COM ESSE SERIAL/);
});
