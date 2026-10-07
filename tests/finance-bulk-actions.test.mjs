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
  "supplier_invoices", "supplier_invoice_installments", "supplier_invoice_events",
  "finance_bank_statement_entries", "finance_bank_classification_rules", "finance_replacement_entries", "finance_budgets",
]);
const { todayInTimezone } = await import("../app/lib/finance-status.ts");
const payablesBulk = await import("../app/api/finance/payables/bulk/route.ts");
const cashFlowBulk = await import("../app/api/finance/cash-flow/payments/bulk/route.ts");
const debtsBulk = await import("../app/api/finance/supplier-debts/bulk/route.ts");
const invoicesBulk = await import("../app/api/finance/invoices/bulk/route.ts");
const reconBulk = await import("../app/api/finance/bank-reconciliation/bulk/route.ts");
const reposicaoBulk = await import("../app/api/finance/replacement-control/bulk/route.ts");
const reposicaoBatch = await import("../app/api/finance/replacement-control/batch/route.ts");
const budgetsBulk = await import("../app/api/finance/budgets/bulk/route.ts");

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
    [invoicesBulk.POST, "/api/finance/invoices/bulk"],
    [reconBulk.POST, "/api/finance/bank-reconciliation/bulk"],
    [reposicaoBulk.POST, "/api/finance/replacement-control/bulk"],
    [reposicaoBatch.POST, "/api/finance/replacement-control/batch"],
    [budgetsBulk.POST, "/api/finance/budgets/bulk"],
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

// ---------------------------------------------------------------------------
// 2. Notas Fiscais
// ---------------------------------------------------------------------------

test("Notas Fiscais: conferir, categoria (pula NF com duplicata), cancelar (pula duplicata paga), 404/403", async () => {
  const nf = (id, extra) => db.insert("supplier_invoices", {
    id, company_id: STORE_A, company_name: "RIOMAR", invoice_number: id.toUpperCase(), competence_month: month,
    total_amount_cents: 10_000, finance_item_id: "item-1", financial_status: "aguardando_conferencia",
    sent_to_finance_at: "2026-10-01", origin: "manual", created_by: "seed", ...extra,
  });
  const dup = (id, invoiceId, payableId, extra) => db.insert("supplier_invoice_installments", {
    id, invoice_id: invoiceId, company_id: STORE_A, due_date: today, original_amount_cents: 10_000,
    accounts_payable_id: payableId, created_by: "seed", ...extra,
  });
  nf("nf-1"); nf("nf-2", { financial_status: "a_pagar" }); nf("nf-dup"); nf("nf-paga"); nf("nf-b", { company_id: STORE_B });
  payable("ap-nf-dup"); payable("ap-nf-paga", { status: "paid", paid_amount_cents: 10_000 });
  dup("i-dup", "nf-dup", "ap-nf-dup"); dup("i-paga", "nf-paga", "ap-nf-paga", { paid_amount_cents: 10_000 });

  const reviewed = await json(await post(invoicesBulk.POST, ADMIN, "/api/finance/invoices/bulk", { action: "review", ids: ["nf-1", "nf-2"] }));
  assert.equal(reviewed.applied, 1);
  assert.deepEqual(reviewed.skipped.map((s) => s.reason), ["ESTA NOTA FISCAL NÃO ESTÁ AGUARDANDO CONFERÊNCIA."]);
  assert.notEqual(row("supplier_invoices", "nf-1").financial_status, "aguardando_conferencia");

  const cat = await json(await post(invoicesBulk.POST, ADMIN, "/api/finance/invoices/bulk", { action: "category", ids: ["nf-1", "nf-dup"], fields: { financeItemId: "item-2", costCenterId: "cc-1" } }));
  assert.equal(cat.applied, 1);
  assert.deepEqual(cat.skipped.map((s) => s.id), ["nf-dup"]);
  assert.equal(row("supplier_invoices", "nf-1").finance_item_id, "item-2");
  assert.equal(row("supplier_invoices", "nf-1").finance_category_id, "cat-1");
  assert.equal(row("supplier_invoices", "nf-dup").finance_item_id, "item-1");

  const canc = await json(await post(invoicesBulk.POST, ADMIN, "/api/finance/invoices/bulk", { action: "cancel", ids: ["nf-dup", "nf-paga"], fields: { reason: "DUPLICADA" } }));
  assert.equal(canc.applied, 1);
  assert.deepEqual(canc.skipped.map((s) => s.reason), ["NOTA COM DUPLICATA PAGA — CANCELE PELA TELA DA NOTA"]);
  assert.equal(row("supplier_invoices", "nf-dup").canceled, 1);
  assert.equal(row("accounts_payable", "ap-nf-dup").status, "canceled");
  assert.equal(row("supplier_invoice_installments", "i-dup").canceled, 1);
  assert.equal(row("supplier_invoices", "nf-paga").canceled, 0);

  assert.equal((await post(invoicesBulk.POST, ADMIN, "/api/finance/invoices/bulk", { action: "cancel", ids: ["nf-2", "nf-x"] })).status, 404);
  assert.equal(row("supplier_invoices", "nf-2").canceled, 0);
  assert.equal((await post(invoicesBulk.POST, STORE_A_LOGIN, "/api/finance/invoices/bulk", { action: "cancel", ids: ["nf-2", "nf-b"] })).status, 403);
  assert.equal(row("supplier_invoices", "nf-2").canceled, 0);
});

// ---------------------------------------------------------------------------
// 3. Conciliação Bancária
// ---------------------------------------------------------------------------

test("Conciliação Bancária: classificar só os campos enviados, confirmar (aprende a regra uma vez), voltar, pulados, 404/403", async () => {
  const entry = (id, extra) => db.insert("finance_bank_statement_entries", {
    id, import_id: "imp", finance_account_id: "acc", company_id: STORE_A, entry_date: today, description: id.toUpperCase(),
    raw_merchant: "PADARIA", amount_cents: -1500, status: "pending", in_dre: 1, ...extra,
  });
  entry("e1", { cost_center_id: "cc-1" }); entry("e2"); entry("e-sem", { raw_merchant: "OUTRO" });
  entry("e-desp", { status: "expensed" }); entry("e-cred", { status: "credit_sale", amount_cents: 5000 }); entry("e-b", { company_id: STORE_B });

  const classified = await json(await post(reconBulk.POST, ADMIN, "/api/finance/bank-reconciliation/bulk", {
    action: "classify", ids: ["e1", "e2", "e-desp", "e-cred"], fields: { categoryItemId: "item-1", inRateio: true },
  }));
  assert.equal(classified.applied, 2);
  assert.deepEqual(classified.skipped.map((s) => s.reason).sort(), ["JÁ VIROU DESPESA", "VINCULADO A CREDIÁRIO — DESFAÇA PELO CREDIÁRIO"]);
  assert.equal(row("finance_bank_statement_entries", "e1").status, "classified");
  assert.equal(row("finance_bank_statement_entries", "e1").cost_center_id, "cc-1"); // campo não enviado fica
  assert.equal(row("finance_bank_statement_entries", "e2").in_rateio, 1);

  const confirmed = await json(await post(reconBulk.POST, ADMIN, "/api/finance/bank-reconciliation/bulk", { action: "confirm", ids: ["e1", "e2", "e-sem"] }));
  assert.equal(confirmed.applied, 2);
  assert.deepEqual(confirmed.skipped.map((s) => s.reason), ["ESCOLHA A CATEGORIA ANTES DE CONFIRMAR"]);
  const rules = db.sqlite.prepare("SELECT hits, category_item_id FROM finance_bank_classification_rules WHERE merchant_key='PADARIA'").all();
  assert.equal(rules.length, 1); // duas confirmações da mesma loja/nome = 1 regra com 2 acertos
  assert.equal(rules[0].hits, 2);

  const back = await json(await post(reconBulk.POST, ADMIN, "/api/finance/bank-reconciliation/bulk", { action: "unclassify", ids: ["e1", "e-sem"] }));
  assert.equal(back.applied, 1);
  assert.equal(row("finance_bank_statement_entries", "e1").status, "pending");
  assert.equal(row("finance_bank_statement_entries", "e1").category_item_id, "item-1");

  assert.equal((await post(reconBulk.POST, ADMIN, "/api/finance/bank-reconciliation/bulk", { action: "confirm", ids: ["e2", "nope"] })).status, 404);
  assert.equal((await post(reconBulk.POST, STORE_A_LOGIN, "/api/finance/bank-reconciliation/bulk", { action: "unclassify", ids: ["e2", "e-b"] })).status, 403);
  assert.equal(row("finance_bank_statement_entries", "e2").status, "confirmed");
  assert.equal((await post(reconBulk.POST, STORE_A_LOGIN, "/api/finance/bank-reconciliation/bulk", { action: "classify", ids: ["e2"], fields: { companyId: STORE_B } })).status, 403);
});

// ---------------------------------------------------------------------------
// 4. Controle de Reposição
// ---------------------------------------------------------------------------

test("Reposição: cadastrar em lote (cria e pula), alterar setor/motivo, excluir (pula o que virou despesa), 404", async () => {
  const base = { entryDate: today, companyId: STORE_A, companyName: "RIOMAR", sector: "assistencia", kind: "reposicao", amountCents: 5000 };
  const created = await json(await post(reposicaoBatch.POST, ADMIN, "/api/finance/replacement-control/batch", {
    rows: [{ ...base, product: "CONTROLE PS5" }, { ...base, product: "X" }, { ...base, product: "CABO HDMI", amountCents: 0 }, { ...base, product: "FONTE", sector: "logistica" }],
  }));
  assert.equal(created.created, 2);
  assert.deepEqual(created.skipped.map((s) => [s.line, s.reason]), [[2, "INFORME O PRODUTO."], [3, "INFORME UM VALOR VÁLIDO EM CENTAVOS."]]);
  const ids = db.sqlite.prepare("SELECT id FROM finance_replacement_entries ORDER BY product").all().map((r) => r.id); // CONTROLE, FONTE
  db.sqlite.prepare("UPDATE finance_replacement_entries SET expense_id='exp-9' WHERE id=?").run(ids[1]);

  await post(reposicaoBulk.POST, ADMIN, "/api/finance/replacement-control/bulk", { action: "update", ids, fields: { sector: "outros" } });
  assert.deepEqual(db.sqlite.prepare("SELECT DISTINCT sector FROM finance_replacement_entries").all().map((r) => r.sector), ["outros"]);
  await post(reposicaoBulk.POST, ADMIN, "/api/finance/replacement-control/bulk", { action: "update", ids: [ids[0]], fields: { reason: "QUEBROU NA VITRINE" } });
  assert.equal(row("finance_replacement_entries", ids[0]).reason, "QUEBROU NA VITRINE");
  assert.equal(row("finance_replacement_entries", ids[0]).sector, "outros");

  assert.equal((await post(reposicaoBulk.POST, ADMIN, "/api/finance/replacement-control/bulk", { action: "delete", ids: [ids[0], "nope"] })).status, 404);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM finance_replacement_entries").get().n, 2);
  const del = await json(await post(reposicaoBulk.POST, ADMIN, "/api/finance/replacement-control/bulk", { action: "delete", ids }));
  assert.equal(del.applied, 1);
  assert.deepEqual(del.skipped.map((s) => s.reason), ["JÁ VIROU DESPESA — REMOVA A DESPESA PRIMEIRO"]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM finance_replacement_entries").get().n, 1);
});

// ---------------------------------------------------------------------------
// 5. Orçamento
// ---------------------------------------------------------------------------

test("Orçamento: copiar para outro mês (pula o que já existe), ajustar % e fixo (pula ≤ 0), excluir, 404", async () => {
  const budget = (id, extra) => db.insert("finance_budgets", {
    id, company_id: STORE_A, company_name: "RIOMAR", category_id: "cat-1", cost_center_id: "", month: "2026-09",
    amount_cents: 100_000, created_by: "seed", ...extra,
  });
  budget("b1"); budget("b2", { cost_center_id: "cc-1", amount_cents: 5_000 }); budget("b-out", { month: "2026-10" });

  const copied = await json(await post(budgetsBulk.POST, ADMIN, "/api/finance/budgets/bulk", { action: "copy", ids: ["b1", "b2"], fields: { month: "2026-10" } }));
  assert.equal(copied.applied, 1);
  assert.deepEqual(copied.skipped.map((s) => [s.id, s.reason]), [["b1", "JÁ EXISTE ORÇAMENTO NO MÊS DE DESTINO"]]);
  const october = db.sqlite.prepare("SELECT cost_center_id, amount_cents FROM finance_budgets WHERE month='2026-10' ORDER BY cost_center_id").all().map((r) => ({ ...r }));
  assert.deepEqual(october, [{ cost_center_id: "", amount_cents: 100_000 }, { cost_center_id: "cc-1", amount_cents: 5_000 }]);

  await post(budgetsBulk.POST, ADMIN, "/api/finance/budgets/bulk", { action: "adjust", ids: ["b1", "b2"], fields: { mode: "percent", percentBps: 1000 } });
  assert.equal(row("finance_budgets", "b1").amount_cents, 110_000);
  assert.equal(row("finance_budgets", "b2").amount_cents, 5_500);
  const fixed = await json(await post(budgetsBulk.POST, ADMIN, "/api/finance/budgets/bulk", { action: "adjust", ids: ["b1", "b2"], fields: { mode: "fixed", deltaCents: -10_000 } }));
  assert.equal(fixed.applied, 1);
  assert.deepEqual(fixed.skipped.map((s) => s.reason), ["O VALOR FICARIA ZERO OU NEGATIVO"]);
  assert.equal(row("finance_budgets", "b1").amount_cents, 100_000);
  assert.equal(row("finance_budgets", "b2").amount_cents, 5_500);

  assert.equal((await post(budgetsBulk.POST, ADMIN, "/api/finance/budgets/bulk", { action: "delete", ids: ["b1", "zz"] })).status, 404);
  assert.equal(row("finance_budgets", "b1").id, "b1");
  await post(budgetsBulk.POST, ADMIN, "/api/finance/budgets/bulk", { action: "delete", ids: ["b1", "b2"] });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM finance_budgets WHERE month='2026-09'").get().n, 0);
});
