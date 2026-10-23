import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Fluxo de Caixa por CONTA cadastrada + IMPORTAR RECEBIMENTOS PREVISTOS
// (23/10/2026), rotas reais sobre SQLite: ?accountId recorta saldo, saídas e
// entradas pela conta; o que não tem conta fica em `unassigned`; as parcelas
// das vendas no cartão viram recebíveis na conta escolhida, sem duplicar.

const db = await setupRouteDb([
  "shared_state", "accounts_receivable", "accounts_payable", "accounts_payable_payments", "finance_suppliers",
  "finance_items", "finance_categories", "hr_payroll_entries", "hr_benefits", "hr_commissions",
  "finance_cash_flow_settings", "finance_accounts", "finance_account_balances", "finance_account_weekly_balances",
  "finance_acquirers", "finance_card_sales",
]);

const { todayInTimezone, addDays } = await import("../app/lib/finance-status.ts");
const cashFlow = await import("../app/api/finance/cash-flow/route.ts");
const payments = await import("../app/api/finance/cash-flow/payments/route.ts");
const weekly = await import("../app/api/finance/cash-flow/weekly/route.ts");
const upcoming = await import("../app/api/finance/receivables/upcoming/route.ts");
const importRoute = await import("../app/api/finance/cash-flow/import-receivables/route.ts");
const receivables = await import("../app/api/finance/receivables/route.ts");
const receivableById = await import("../app/api/finance/receivables/[id]/route.ts");

const FINANCE = { id: "fin", permissions: ["finance:manage"] };
const STORE = "criomar01";
const today = todayInTimezone();
const d = (offset) => addDays(today, offset);
const json = async (response) => response.json();
const get = async (handler, path) => json(await callRoute(handler, FINANCE, "GET", path));
const one = (sql, ...params) => db.prepare(sql).bind(...params).first();
const many = async (sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
const exec = (sql, ...params) => db.prepare(sql).bind(...params).run();

db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: STORE, name: "RIOMAR" }]) });
db.insert("finance_accounts", { id: "acc-itau", company_id: "", company_name: "", name: "ITAÚ", active: 1 });
db.insert("finance_accounts", { id: "acc-bb", company_id: "", company_name: "", name: "BB", active: 1 });
db.insert("finance_accounts", { id: "acc-velha", company_id: "", company_name: "", name: "VELHA", active: 0 });
db.insert("finance_account_balances", { id: "b1", account_id: "acc-itau", balance_cents: 100_000, as_of_date: today, updated_by: "x" });
db.insert("finance_account_balances", { id: "b2", account_id: "acc-bb", balance_cents: 40_000, as_of_date: today, updated_by: "x" });
const payable = (id, row) =>
  db.insert("accounts_payable", {
    id, company_id: STORE, company_name: "RIOMAR", description: id.toUpperCase(), original_amount_cents: 10_000,
    paid_amount_cents: 0, competence_month: today.slice(0, 7), due_date: d(3), status: "open",
    idempotency_key: `k-${id}`, created_by: "seed", ...row,
  });
payable("itau", { finance_account_id: "acc-itau", original_amount_cents: 20_000 });
payable("bb", { finance_account_id: "acc-bb", original_amount_cents: 7_000 });
payable("sem-conta", { original_amount_cents: 3_000 });
// Pagamento agendado em outra conta que a prevista: vale a conta do pagamento.
payable("agendada", { finance_account_id: "acc-bb", original_amount_cents: 5_000 });
db.insert("accounts_payable_payments", { id: "pg", payable_id: "agendada", amount_cents: 5_000, payment_date: d(4), scheduled: 1, confirmed_at: "", finance_account_id: "acc-itau", idempotency_key: "p", created_by: "seed" });
db.insert("accounts_receivable", { id: "rec-itau", company_id: STORE, company_name: "RIOMAR", operator_text: "STONE", competence_month: today.slice(0, 7), expected_date: d(5), expected_amount_cents: 9_000, finance_account_id: "acc-itau", idempotency_key: "r1", created_by: "seed" });
db.insert("accounts_receivable", { id: "rec-sem", company_id: STORE, company_name: "RIOMAR", operator_text: "CIELO", competence_month: today.slice(0, 7), expected_date: d(5), expected_amount_cents: 1_000, idempotency_key: "r2", created_by: "seed" });

const sum = (days, key) => days.reduce((total, day) => total + day[key], 0);

test("projeção por conta: saldo, entradas e saídas só da conta; sem conta vai para o aviso", async () => {
  const all = await get(cashFlow.GET, "/api/finance/cash-flow");
  assert.equal(all.caixaAtualCents, 140_000);
  assert.equal(sum(all.days, "entradasCents"), 10_000);
  assert.equal(sum(all.days, "saidasCents"), 35_000);
  assert.deepEqual(all.unassigned, { inflowCents: 0, outflowCents: 0, outflowCount: 0 });

  const itau = await get(cashFlow.GET, "/api/finance/cash-flow?accountId=acc-itau");
  assert.equal(itau.accountId, "acc-itau");
  assert.equal(itau.caixaAtualCents, 100_000);
  assert.equal(sum(itau.days, "entradasCents"), 9_000);
  assert.equal(sum(itau.days, "saidasCents"), 25_000, "conta prevista ITAÚ + pagamento agendado no ITAÚ");
  assert.deepEqual(itau.unassigned, { inflowCents: 1_000, outflowCents: 3_000, outflowCount: 1 });

  const bb = await get(cashFlow.GET, "/api/finance/cash-flow?accountId=acc-bb");
  assert.equal(bb.caixaAtualCents, 40_000);
  assert.equal(sum(bb.days, "saidasCents"), 7_000);
});

test("lista de pagamentos, caixa semanal e recebimentos futuros recortam pela conta", async () => {
  const list = await get(payments.GET, `/api/finance/cash-flow/payments?to=${d(30)}&accountId=acc-bb`);
  assert.deepEqual(list.items.map((item) => item.payableId), ["bb"]);
  assert.equal(list.items[0].financeAccountId, "acc-bb");
  assert.equal(list.unassigned.outflowCents, 3_000);
  const listAll = await get(payments.GET, `/api/finance/cash-flow/payments?to=${d(30)}`);
  assert.equal(listAll.items.length, 4);

  const week = await get(weekly.GET, "/api/finance/cash-flow/weekly?accountId=acc-itau");
  assert.deepEqual(week.accounts.map((account) => account.accountId), ["acc-itau"]);

  const future = await get(upcoming.GET, "/api/finance/receivables/upcoming?accountId=acc-itau");
  assert.deepEqual(future.upcoming.map((row) => row.id), ["rec-itau"]);
  assert.equal(future.upcoming[0].financeAccountId, "acc-itau");
});

test("recebível guarda a conta onde cai; conta inativa é recusada", async () => {
  const created = await callRoute(receivables.POST, FINANCE, "POST", "/api/finance/receivables", {
    companyId: STORE, competenceMonth: today.slice(0, 7), operatorText: "REDE", amountCents: 2_500, financeAccountId: "acc-bb",
  });
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  const { id } = await created.json();
  assert.equal((await one("SELECT finance_account_id AS a FROM accounts_receivable WHERE id = ?", id)).a, "acc-bb");
  const inactive = await callRoute(receivables.POST, FINANCE, "POST", "/api/finance/receivables", {
    companyId: STORE, competenceMonth: today.slice(0, 7), operatorText: "REDE", amountCents: 2_500, financeAccountId: "acc-velha",
  });
  assert.equal(inactive.status, 400);
  const edited = await callRoute(receivableById.PUT, FINANCE, "PUT", `/api/finance/receivables/${id}`, {
    competenceMonth: today.slice(0, 7), operatorText: "REDE", amountCents: 2_500, financeAccountId: "acc-itau",
  }, { id });
  assert.equal(edited.status, 200, JSON.stringify(await edited.clone().json()));
  assert.equal((await one("SELECT finance_account_id AS a FROM accounts_receivable WHERE id = ?", id)).a, "acc-itau");
  await exec("DELETE FROM accounts_receivable WHERE id = ?", id);
});

test("IMPORTAR RECEBIMENTOS PREVISTOS: parcelas das vendas no cartão viram recebíveis na conta, sem duplicar", async () => {
  db.insert("finance_acquirers", { id: "acq-stone", name: "STONE", debit_days: 1, credit_days: 30, anticipated: 0 });
  const sale = (id, row) => db.insert("finance_card_sales", {
    id, import_id: "imp", company_id: STORE, acquirer_id: "acq-stone", acquirer_name: "STONE", modality: "debit",
    installments: 1, gross_cents: 10_000, expected_fee_cents: 200, net_cents: 9_800, sale_date: today, ...row,
  });
  sale("deb-1", {});
  sale("deb-2", { gross_cents: 5_000, expected_fee_cents: 100, net_cents: 4_900 });
  sale("cred-3x", { modality: "credit", installments: 3, gross_cents: 30_000, expected_fee_cents: 0, net_cents: 30_000 });
  sale("antiga", { sale_date: d(-40) });

  const preview = await get(importRoute.GET, `/api/finance/cash-flow/import-receivables?to=${d(70)}`);
  assert.deepEqual(
    preview.lines.map((line) => [line.date, line.amountCents, line.sales, line.action]),
    [[d(1), 14_700, 2, "new"], [d(30), 10_000, 1, "new"], [d(60), 10_000, 1, "new"]],
  );
  assert.equal(preview.lines[0].acquirerName, "STONE");
  assert.equal(preview.lines[0].companyName, "RIOMAR");
  assert.equal((await one("SELECT COUNT(*) AS n FROM accounts_receivable")).n, 2, "prévia não grava");

  const noAccount = await callRoute(importRoute.POST, FINANCE, "POST", "/api/finance/cash-flow/import-receivables", { to: d(70) });
  assert.equal(noAccount.status, 400);
  const first = await json(await callRoute(importRoute.POST, FINANCE, "POST", "/api/finance/cash-flow/import-receivables", { to: d(70), financeAccountId: "acc-bb" }));
  assert.deepEqual([first.created, first.updated, first.totalCents], [3, 0, 34_700]);

  const bb = await get(cashFlow.GET, "/api/finance/cash-flow?accountId=acc-bb");
  assert.equal(sum(bb.days, "entradasCents"), 34_700, "recebimentos previstos entram na projeção da conta");

  // Nova venda no mesmo dia → reimportar atualiza o valor, não duplica.
  sale("deb-3", { gross_cents: 1_000, expected_fee_cents: 0, net_cents: 1_000 });
  const second = await json(await callRoute(importRoute.POST, FINANCE, "POST", "/api/finance/cash-flow/import-receivables", { to: d(70), financeAccountId: "acc-bb" }));
  assert.deepEqual([second.created, second.updated], [0, 3]);
  const rows = await many("SELECT expected_date AS date, expected_amount_cents AS cents, finance_account_id AS account FROM accounts_receivable WHERE idempotency_key LIKE 'card-forecast:%' ORDER BY expected_date");
  assert.deepEqual(rows.map((row) => [row.date, row.cents, row.account]), [[d(1), 15_700, "acc-bb"], [d(30), 10_000, "acc-bb"], [d(60), 10_000, "acc-bb"]]);

  // Já recebido não é mexido.
  await exec("UPDATE accounts_receivable SET received_amount_cents = 15000, received_date = ? WHERE expected_date = ? AND idempotency_key LIKE 'card-forecast:%'", today, d(1));
  const third = await get(importRoute.GET, `/api/finance/cash-flow/import-receivables?to=${d(70)}`);
  assert.equal(third.lines[0].action, "locked");
});

test("tela: filtro CONTA no lugar de UNIDADE e botão de importar", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /<div class="field" hidden><label for="cashFlowLoja">UNIDADE<\/label>/);
  assert.match(html, /<select id="cashFlowConta"><option value="">TODAS AS CONTAS \(CONSOLIDADO\)<\/option>/);
  assert.match(html, /id="btnCashFlowImportReceivables"/);
  assert.match(html, /\/cash-flow\/import-receivables/);
  assert.match(html, /id="receivableAccount"/);
});
