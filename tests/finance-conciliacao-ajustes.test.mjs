import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Conciliação Bancária (23/10/2026): DRE/RATEIO desmarcados na importação,
// ATIVIDADES FINANCEIRAS cadastráveis, sugestão de CONTA A PAGAR com o mesmo
// valor (e baixa), SALDO INICIAL do período e LIMPAR EXTRATO DO MÊS.

const db = await setupRouteDb([
  "finance_accounts", "finance_bank_statement_entries", "finance_bank_statement_imports", "finance_bank_classification_rules",
  "finance_bank_activities", "finance_bank_period_balances", "accounts_payable", "accounts_payable_payments", "finance_suppliers",
  "finance_sales_recon_rows", "finance_credit_sales", "finance_replacement_entries",
]);
const list = await import("../app/api/finance/bank-reconciliation/route.ts");
const entryRoute = await import("../app/api/finance/bank-reconciliation/[id]/route.ts");
const bulk = await import("../app/api/finance/bank-reconciliation/bulk/route.ts");
const activities = await import("../app/api/finance/bank-activities/route.ts");
const balance = await import("../app/api/finance/bank-reconciliation/period-balance/route.ts");

const ADMIN = { id: "admin", role: "admin" };
db.insert("finance_accounts", { id: "acc", company_id: "", name: "BANCO X", type: "corrente", active: 1, opening_balance_cents: 100000, opening_balance_date: "2026-09-01", created_by: "x" });
db.insert("finance_suppliers", { id: "sup", name: "LUZ SA", active: 1, created_by: "x" });
db.insert("accounts_payable", {
  id: "pay-luz", company_id: "", description: "CONTA DE LUZ", supplier_id: "sup", original_amount_cents: 15230, paid_amount_cents: 0,
  due_date: "2026-10-04", competence_month: "2026-10", status: "open", created_by: "x", idempotency_key: "k1",
});

const get = async (path) => (await callRoute(list.GET, ADMIN, "GET", path)).json();
const patch = (id, body) => callRoute(entryRoute.PATCH, ADMIN, "PATCH", `/api/finance/bank-reconciliation/${id}`, body, { id });

test("importação: sem regra aprendida, DRE e RATEIO chegam desmarcados", async () => {
  const res = await callRoute(list.POST, ADMIN, "POST", "/api/finance/bank-reconciliation", {
    financeAccountId: "acc", sourceName: "extrato.ofx", sourceFormat: "ofx",
    rows: [
      { entryDate: "2026-09-20", amountCents: 5000, description: "DEPOSITO SETEMBRO" },
      { entryDate: "2026-10-05", amountCents: -15230, description: "PAGAMENTO NEOENERGIA" },
      { entryDate: "2026-10-06", amountCents: 80000, description: "VENDAS CARTAO" },
      { entryDate: "2026-10-07", amountCents: -2000, description: "TARIFA" },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const flags = db.sqlite.prepare("SELECT DISTINCT in_dre AS d, in_rateio AS r FROM finance_bank_statement_entries").all();
  assert.deepEqual(flags.map((row) => [row.d, row.r]), [[0, 0]]);
});

test("atividades financeiras: cadastra entrada/saída, marca no lançamento; excluir usada só desativa", async () => {
  const created = await (await callRoute(activities.POST, ADMIN, "POST", "/api/finance/bank-activities", { kind: "entrada", name: "entrada de venda" })).json();
  assert.equal((await callRoute(activities.POST, ADMIN, "POST", "/api/finance/bank-activities", { kind: "saida", name: "tarifa bancária" })).status, 201);
  assert.equal((await callRoute(activities.POST, ADMIN, "POST", "/api/finance/bank-activities", { kind: "xpto", name: "x" })).status, 400);
  const sale = db.sqlite.prepare("SELECT id FROM finance_bank_statement_entries WHERE amount_cents=80000").get().id;
  assert.equal((await patch(sale, { activityId: created.id, categoryItemId: "", inDre: false, inRateio: false })).status, 200);
  const data = await get("/api/finance/bank-reconciliation?financeAccountId=acc&month=2026-10");
  assert.equal(data.entries.find((row) => row.id === sale).activityId, created.id);
  await callRoute(activities.DELETE, ADMIN, "DELETE", `/api/finance/bank-activities?id=${created.id}`);
  const after = (await (await callRoute(activities.GET, ADMIN, "GET", "/api/finance/bank-activities")).json()).activities;
  assert.deepEqual(after.map((row) => [row.name, row.active]), [["ENTRADA DE VENDA", 0], ["TARIFA BANCÁRIA", 1]]);
});

test("saída com o mesmo valor de uma conta a pagar: sugere e baixa (pagamento registrado, lançamento conciliado)", async () => {
  const data = await get("/api/finance/bank-reconciliation?financeAccountId=acc&month=2026-10");
  const exit = data.entries.find((row) => row.amountCents === -15230);
  assert.equal(exit.payableSuggestion.id, "pay-luz");
  assert.equal(exit.payableSuggestion.supplierName, "LUZ SA");
  assert.equal(data.entries.find((row) => row.amountCents === -2000).payableSuggestion, null);
  const res = await patch(exit.id, { payPayableId: "pay-luz" });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const payable = db.sqlite.prepare("SELECT paid_amount_cents AS paid, status FROM accounts_payable WHERE id='pay-luz'").get();
  assert.deepEqual([payable.paid, payable.status], [15230, "paid"]);
  const payment = db.sqlite.prepare("SELECT finance_account_id AS acc, payment_date AS d FROM accounts_payable_payments WHERE payable_id='pay-luz'").get();
  assert.deepEqual([payment.acc, payment.d], ["acc", "2026-10-05"]);
  const entry = db.sqlite.prepare("SELECT status, payable_id AS p FROM finance_bank_statement_entries WHERE id=?").get(exit.id);
  assert.deepEqual([entry.status, entry.p], ["confirmed", "pay-luz"]);
  assert.equal((await patch(exit.id, { payPayableId: "pay-luz" })).status, 409, "não baixa duas vezes");
});

test("saldo inicial do período: calculado (abertura + extrato antes do mês) ou informado; saldo final", async () => {
  let data = await get("/api/finance/bank-reconciliation?financeAccountId=acc&month=2026-10");
  assert.deepEqual(
    [data.period.openingSource, data.period.openingCents, data.period.inflowCents, data.period.outflowCents, data.period.closingCents],
    ["calculado", 105000, 80000, 17230, 105000 + 80000 - 17230],
  );
  assert.equal((await callRoute(balance.PUT, ADMIN, "PUT", "/api/finance/bank-reconciliation/period-balance", { financeAccountId: "acc", month: "2026-10", openingCents: 200000 })).status, 200);
  data = await get("/api/finance/bank-reconciliation?financeAccountId=acc&month=2026-10");
  assert.deepEqual([data.period.openingSource, data.period.openingCents, data.period.closingCents], ["informado", 200000, 200000 + 80000 - 17230]);
  await callRoute(balance.PUT, ADMIN, "PUT", "/api/finance/bank-reconciliation/period-balance", { financeAccountId: "acc", month: "2026-10", openingCents: null });
  assert.equal((await get("/api/finance/bank-reconciliation?financeAccountId=acc&month=2026-10")).period.openingSource, "calculado");
});

test("limpar extrato do mês: exclui o que não está conciliado e mantém a saída que baixou conta a pagar", async () => {
  const ids = db.sqlite.prepare("SELECT id FROM finance_bank_statement_entries WHERE entry_date >= '2026-10-01'").all().map((row) => row.id);
  const res = await (await callRoute(bulk.POST, ADMIN, "POST", "/api/finance/bank-reconciliation/bulk", { action: "delete", ids })).json();
  assert.equal(res.applied, 2);
  assert.match(res.skipped[0].reason, /BAIXOU UMA CONTA A PAGAR/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM finance_bank_statement_entries WHERE entry_date >= '2026-10-01'").get().n, 1);
});

test("tela: filtro de entradas/saídas, atividades, saldo do período, limpar, sugestão e relatório PDF/XLSX", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  for (const id of ["reconKindFilter", "btnReconActivities", "btnReconReportPdf", "btnReconReportXlsx", "btnReconClearMonth", "reconPeriodSummary", "reconOpeningInput", "reconActivitiesDialog"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /data-recon-pay-payable=/);
  assert.match(html, /data-recon-field="activityId"/);
});
