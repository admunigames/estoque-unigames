import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Contas a Pagar / Dívidas com Fornecedores / Notas Fiscais SEM loja (PF,
// escritório) e DESTINO NA DRE escolhido por quem lança (NÃO INCLUIR /
// RATEAR / INCLUIR EM) — prompt 2 dos ajustes do Financeiro (22/10/2026).

const db = await setupRouteDb([
  "shared_state", "accounts_payable", "accounts_payable_payments", "finance_items", "finance_accounts",
  "finance_cost_centers", "finance_store_entries", "finance_rateio_model_shares", "finance_suppliers",
  "supplier_open_debts", "supplier_invoices", "supplier_invoice_installments", "supplier_invoice_events",
  "expenses", "finance_store_revenue", "finance_store_headcount",
]);
const payables = await import("../app/api/finance/payables/route.ts");
const payable = await import("../app/api/finance/payables/[id]/route.ts");
const payments = await import("../app/api/finance/payables/[id]/payments/route.ts");
const cancel = await import("../app/api/finance/payables/[id]/cancel/route.ts");
const debts = await import("../app/api/finance/supplier-debts/route.ts");
const invoices = await import("../app/api/finance/invoices/route.ts");
const installments = await import("../app/api/finance/invoices/[id]/installments/route.ts");
const destinationLib = await import("../app/lib/dre-destination.ts");

const ALFA = "clojaalfa1";
const BETA = "clojabeta1";
const GAMA = "clojagama1";
const ADMIN = { id: "admin", role: "admin" };
const STORE_USER = { id: "u-loja", permissions: ["finance:manage"], companyId: ALFA };

db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([
    { id: ALFA, name: "LOJA ALFA" },
    { id: BETA, name: "LOJA BETA" },
    { id: GAMA, name: "LOJA GAMA" },
  ]),
});
for (const [id, name] of [["item-luz", "ENERGIA"], ["item-aluguel", "ALUGUEL"], ["item-geral", "DESPESAS GERAIS"]]) {
  db.insert("finance_items", { id, category_id: "cat-1", name, created_by: "admin" });
}
db.insert("finance_accounts", { id: "acc-pf", company_id: "", name: "CONTA PF DO SÓCIO", active: 1, created_by: "admin" });
db.insert("finance_accounts", { id: "acc-alfa", company_id: ALFA, company_name: "LOJA ALFA", name: "CAIXA ALFA", active: 1, created_by: "admin" });
db.insert("finance_accounts", { id: "acc-beta", company_id: BETA, company_name: "LOJA BETA", name: "CAIXA BETA", active: 1, created_by: "admin" });
for (const [company, bp] of [[ALFA, 5000], [BETA, 3000], [GAMA, 2000]]) {
  db.insert("finance_rateio_model_shares", { id: `rm-${company}`, model: "padrao", company_id: company, company_name: company, percent_basis_points: bp });
}
db.insert("finance_suppliers", { id: "sup-1", name: "FORNECEDOR UM", active: 1, created_by: "admin" });

let seq = 0;
const key = () => `k-${++seq}`;
const dreCell = (store, item, month = "2026-10") =>
  db.sqlite.prepare("SELECT amount_cents AS cents FROM finance_store_entries WHERE store_id=? AND item_id=? AND month=?").get(store, item, month)?.cents ?? 0;
const create = (actor, body) =>
  callRoute(payables.POST, actor, "POST", "/api/finance/payables", {
    idempotencyKey: key(), description: "BOLETO", financeItemId: "item-luz", originalAmountCents: 10000,
    dueDate: "2026-10-20", ...body,
  });

test("conta SEM loja: cria (PF), paga com conta de PF; login de loja não vê nem cria sem loja", async () => {
  const res = await create(ADMIN, { companyId: "", payerName: "fulano de tal", dreTarget: "none" });
  assert.equal(res.status, 201);
  const [id] = (await res.json()).ids;
  const row = db.sqlite.prepare("SELECT company_id, payer_name, dre_target, dre_amount_cents FROM accounts_payable WHERE id=?").get(id);
  assert.deepEqual({ ...row }, { company_id: "", payer_name: "FULANO DE TAL", dre_target: "none", dre_amount_cents: 0 });
  assert.equal(dreCell("", "item-luz"), 0, "sem loja e NÃO INCLUIR: nenhuma célula de DRE");

  // Conta de loja paga conta SEM loja; conta de PF também.
  const pay = await callRoute(payments.POST, ADMIN, "POST", `/api/finance/payables/${id}/payments`, {
    idempotencyKey: key(), amountCents: 4000, paymentDate: "2026-10-21", financeAccountId: "acc-pf",
  }, { id });
  assert.equal(pay.status, 201);
  const payStore = await callRoute(payments.POST, ADMIN, "POST", `/api/finance/payables/${id}/payments`, {
    idempotencyKey: key(), amountCents: 1000, paymentDate: "2026-10-21", financeAccountId: "acc-beta",
  }, { id });
  assert.equal(payStore.status, 201);

  // Conta bancária não é associada a unidade (23/10/2026): a conta "da BETA"
  // paga conta da ALFA.
  const alfa = await create(ADMIN, { companyId: ALFA, companyName: "LOJA ALFA", financeAccountId: "acc-beta" });
  assert.equal(alfa.status, 201);
  assert.equal((await create(ADMIN, { companyId: ALFA, companyName: "LOJA ALFA", financeAccountId: "acc-pf" })).status, 201);

  // Login de loja: não cria sem loja e não enxerga a conta sem loja.
  assert.equal((await create(STORE_USER, { companyId: "" })).status, 400);
  const list = await (await callRoute(payables.GET, STORE_USER, "GET", "/api/finance/payables?pageSize=100")).json();
  assert.ok(!list.rows.some((r) => r.id === id));
  assert.equal((await callRoute(payable.GET, STORE_USER, "GET", `/api/finance/payables/${id}`, undefined, { id })).status, 403);
  const adminList = await (await callRoute(payables.GET, ADMIN, "GET", "/api/finance/payables?companyId=__none__&pageSize=100")).json();
  assert.deepEqual(adminList.rows.map((r) => r.id), [id]);
  assert.equal(adminList.rows[0].payerName, "FULANO DE TAL");
});

test("INCLUIR EM: a DRE entra na loja/categoria escolhida, não na loja da conta", async () => {
  const res = await create(ADMIN, {
    companyId: "", description: "ALUGUEL DO ESCRITÓRIO", originalAmountCents: 30000,
    dreTarget: "include", dreCompanyId: BETA, dreFinanceItemId: "item-aluguel",
  });
  assert.equal(res.status, 201);
  const [id] = (await res.json()).ids;
  assert.equal(dreCell(BETA, "item-aluguel"), 30000);
  assert.equal(dreCell("", "item-luz"), 0);

  // O destino volta no GET (para reabrir o formulário).
  const detail = await (await callRoute(payable.GET, ADMIN, "GET", `/api/finance/payables/${id}`, undefined, { id })).json();
  assert.equal(detail.dreDestination.target, "include");
  assert.equal(detail.dreDestination.shares[0].companyId, BETA);

  // Editar o valor refaz a fatia; cancelar tira da DRE.
  assert.equal((await callRoute(payable.PATCH, ADMIN, "PATCH", `/api/finance/payables/${id}`, { originalAmountCents: 32000 }, { id })).status, 200);
  assert.equal(dreCell(BETA, "item-aluguel"), 32000);
  assert.equal((await callRoute(cancel.POST, ADMIN, "POST", `/api/finance/payables/${id}/cancel`, {}, { id })).status, 200);
  assert.equal(dreCell(BETA, "item-aluguel"), 0);

  // Login de loja só lança na DRE da própria loja.
  const other = await create(STORE_USER, { companyId: ALFA, companyName: "LOJA ALFA", dreTarget: "include", dreCompanyId: BETA });
  assert.equal(other.status, 403);
});

test("RATEAR: divide a categoria entre as lojas do modelo; soma bate com o valor", async () => {
  const res = await create(ADMIN, {
    companyId: ALFA, companyName: "LOJA ALFA", description: "CONTABILIDADE", originalAmountCents: 10001,
    financeItemId: "item-geral", dreTarget: "rateio", dreRateioModel: "padrao",
  });
  assert.equal(res.status, 201);
  const cells = [ALFA, BETA, GAMA].map((store) => dreCell(store, "item-geral"));
  assert.deepEqual(cells, [5001, 3000, 2000]);
  assert.equal(cells.reduce((a, b) => a + b, 0), 10001);

  // Mudar para NÃO INCLUIR tira das três lojas.
  const [id] = (await res.json()).ids;
  const patch = await callRoute(payable.PATCH, ADMIN, "PATCH", `/api/finance/payables/${id}`, { dreTarget: "none" }, { id });
  assert.equal(patch.status, 200);
  assert.deepEqual([ALFA, BETA, GAMA].map((store) => dreCell(store, "item-geral")), [0, 0, 0]);
});

test("conta antiga (sem destino) segue a regra antiga; INCLUIR EM = loja/categoria atuais", async () => {
  const res = await create(ADMIN, { companyId: GAMA, companyName: "LOJA GAMA", originalAmountCents: 777 });
  const [id] = (await res.json()).ids;
  assert.equal(db.sqlite.prepare("SELECT dre_target FROM accounts_payable WHERE id=?").get(id).dre_target, "");
  assert.equal(dreCell(GAMA, "item-luz"), 777);
  const detail = await (await callRoute(payable.GET, ADMIN, "GET", `/api/finance/payables/${id}`, undefined, { id })).json();
  assert.deepEqual(
    { target: detail.dreDestination.target, store: detail.dreDestination.shares[0].companyId, item: detail.dreDestination.itemId },
    { target: "include", store: GAMA, item: "item-luz" },
  );
  assert.equal(
    destinationLib.legacyDestination({ companyId: GAMA, companyName: "", financeItemId: "x", dreAmountCents: 0 }).target,
    "none",
  );
});

test("Dívida com Fornecedor e Nota Fiscal sem loja, com destino na DRE", async () => {
  const debt = await callRoute(debts.POST, ADMIN, "POST", "/api/finance/supplier-debts", {
    idempotencyKey: key(), companyId: "", supplierId: "sup-1", description: "COMPRA PF", dueDate: "2026-10-25",
    originalAmountCents: 5000, payerName: "sócio", dreTarget: "include", dreCompanyId: ALFA, financeItemId: "item-geral",
  });
  assert.equal(debt.status, 201);
  const { id: debtId, accountsPayableId } = await debt.json();
  assert.equal(db.sqlite.prepare("SELECT payer_name FROM supplier_open_debts WHERE id=?").get(debtId).payer_name, "SÓCIO");
  assert.equal(db.sqlite.prepare("SELECT company_id FROM accounts_payable WHERE id=?").get(accountsPayableId).company_id, "");
  assert.equal(dreCell(ALFA, "item-geral", "2026-10"), 5000); // o rateio do teste anterior virou NÃO INCLUIR

  const nf = await callRoute(invoices.POST, ADMIN, "POST", "/api/finance/invoices", {
    companyId: "", invoiceNumber: "123", supplierId: "sup-1", totalAmountCents: 9000, competenceMonth: "2026-11",
    financeItemId: "item-aluguel", payerName: "pf", entryDate: "2026-11-01",
  });
  assert.equal(nf.status, 201);
  const { id: invoiceId } = await nf.json();
  const inst = await callRoute(installments.POST, ADMIN, "POST", `/api/finance/invoices/${invoiceId}/installments`, {
    mode: "generate", installmentTotal: 3, firstDueDate: "2026-11-10", dreTarget: "rateio", dreRateioModel: "padrao",
  }, { id: invoiceId });
  assert.equal(inst.status, 201, await inst.clone().text());
  assert.deepEqual([ALFA, BETA, GAMA].map((store) => dreCell(store, "item-aluguel", "2026-11")), [4500, 2700, 1800]);
  // Sem destino, NF sem loja não entra em DRE nenhuma.
  const nf2 = await callRoute(invoices.POST, ADMIN, "POST", "/api/finance/invoices", {
    companyId: "", invoiceNumber: "124", supplierId: "sup-1", totalAmountCents: 1000, competenceMonth: "2026-12", financeItemId: "item-luz",
  });
  const { id: invoice2 } = await nf2.json();
  const inst2 = await callRoute(installments.POST, ADMIN, "POST", `/api/finance/invoices/${invoice2}/installments`, {
    mode: "manual", dueDate: "2026-12-10", originalAmountCents: 1000,
  }, { id: invoice2 });
  assert.equal(inst2.status, 201);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM finance_store_entries WHERE month='2026-12'").get().n, 0);
});

test("telas: loja opcional (SEM LOJA), TITULAR / PAGADOR e DESTINO NA DRE nos três formulários", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  for (const prefix of ["payable", "supplierDebt", "invoice"]) {
    assert.match(html, new RegExp(`<div data-dre-destination="${prefix}"></div>`), prefix);
  }
  for (const id of ["payablePayerName", "supplierDebtPayerName", "invoicePayerName"]) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const id of ["payableCompany", "supplierDebtCompany", "invoiceCompany"]) {
    assert.match(html, new RegExp(`<label for="${id}">EMPRESA/LOJA</label><select id="${id}">`), id);
  }
  assert.match(html, /const NO_COMPANY_LABEL = 'SEM LOJA \(ESCRITÓRIO \/ PF \/ OUTROS\)'/);
  assert.match(html, /value="include" checked> INCLUIR EM<\/label>[\s\S]{0,200}value="rateio"> RATEAR<\/label>[\s\S]{0,200}value="none"> NÃO INCLUIR<\/label>/);
  assert.doesNotMatch(html, /id="payableDreIncluded"|id="invoiceDreIncluded"/);
  assert.match(html, /<option value="__none__">SEM LOJA<\/option>/);
});
