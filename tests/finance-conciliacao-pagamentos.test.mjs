import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Conciliação Bancária × Contas a Pagar (02/11/2026): pagamento JÁ registrado
// (mesmo valor, até 5 dias) vira sugestão; CONFIRMAR com paymentId só vincula
// (sem DRE nova) e o pagamento não é sugerido para outra linha.

const db = await setupRouteDb([
  "finance_accounts", "finance_bank_statement_entries", "finance_bank_statement_imports", "finance_bank_classification_rules",
  "finance_bank_activities", "finance_bank_period_balances", "accounts_payable", "accounts_payable_payments", "finance_suppliers",
  "finance_sales_recon_rows", "finance_credit_sales", "finance_replacement_entries",
]);
const list = await import("../app/api/finance/bank-reconciliation/route.ts");
const entryRoute = await import("../app/api/finance/bank-reconciliation/[id]/route.ts");
const bulk = await import("../app/api/finance/bank-reconciliation/bulk/route.ts");

const ADMIN = { id: "admin", role: "admin" };
db.insert("finance_accounts", { id: "acc", company_id: "", name: "BANCO X", type: "corrente", active: 1, created_by: "x" });
db.insert("finance_suppliers", { id: "sup", name: "LUZ SA", active: 1, created_by: "x" });
db.insert("accounts_payable", {
  id: "p1", company_id: "loja1", company_name: "LOJA 1", description: "CONTA DE LUZ", supplier_id: "sup", finance_item_id: "item-luz",
  cost_center_id: "cc1", original_amount_cents: 15230, paid_amount_cents: 15230, due_date: "2026-10-04", competence_month: "2026-10",
  status: "paid", created_by: "x", idempotency_key: "k1",
});
const payment = (id, date, key, extra = {}) => db.insert("accounts_payable_payments", {
  id, payable_id: "p1", amount_cents: 15230, payment_date: date, confirmed_at: `${date} 10:00`, created_by: "x", idempotency_key: key, ...extra,
});
payment("pm1", "2026-10-03", "k-pm1");
payment("pm-longe", "2026-10-20", "k-longe");
payment("pm-banco", "2026-10-04", "bank-entry:outro");
payment("pm-outra-conta", "2026-10-04", "k-outra", { finance_account_id: "acc-2" });
payment("pm-agendado", "2026-10-04", "k-ag", { confirmed_at: "", scheduled: 1 });

const get = async () => (await (await callRoute(list.GET, ADMIN, "GET", "/api/finance/bank-reconciliation?financeAccountId=acc&month=2026-10")).json()).entries;
const patch = (id, body) => callRoute(entryRoute.PATCH, ADMIN, "PATCH", `/api/finance/bank-reconciliation/${id}`, body, { id });

test("sugere o pagamento registrado com mesmo valor e data próxima, uma linha só", async () => {
  const res = await callRoute(list.POST, ADMIN, "POST", "/api/finance/bank-reconciliation", {
    financeAccountId: "acc", sourceName: "extrato.ofx", sourceFormat: "ofx",
    rows: [
      { entryDate: "2026-10-05", amountCents: -15230, description: "PAGAMENTO NEOENERGIA" },
      { entryDate: "2026-10-06", amountCents: -15230, description: "PAGAMENTO NEOENERGIA 2" },
      { entryDate: "2026-10-07", amountCents: -999, description: "TARIFA" },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const entries = await get();
  const suggested = entries.filter((row) => row.paymentSuggestion);
  assert.deepEqual(suggested.map((row) => row.paymentSuggestion.id), ["pm1"], "agendado, outra conta, feito pela conciliação e >5 dias ficam fora");
  assert.equal(suggested[0].entryDate, "2026-10-05", "fica com a linha de data mais próxima");
  const s = suggested[0].paymentSuggestion;
  assert.deepEqual([s.supplierName, s.description, s.financeItemId, s.costCenterId, s.companyId], ["LUZ SA", "CONTA DE LUZ", "item-luz", "cc1", "loja1"]);
});

test("confirmar com paymentId só vincula: sem DRE, sem novo pagamento, e não sugere de novo", async () => {
  const entries = await get();
  const linked = entries.find((row) => row.paymentSuggestion);
  const other = entries.find((row) => row.amountCents === -15230 && row.id !== linked.id);
  const tarifa = entries.find((row) => row.amountCents === -999);
  assert.equal((await patch(tarifa.id, { categoryItemId: "item-luz", confirm: true, paymentId: "pm1" })).status, 400, "valor diferente");
  const res = await patch(linked.id, { categoryItemId: "item-luz", companyId: "loja1", costCenterId: "cc1", inDre: true, confirm: true, paymentId: "pm1" });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const row = db.sqlite.prepare("SELECT status, payment_id AS pm, payable_id AS p, in_dre AS dre FROM finance_bank_statement_entries WHERE id=?").get(linked.id);
  assert.deepEqual([row.status, row.pm, row.p, row.dre], ["confirmed", "pm1", "p1", 0]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM accounts_payable_payments").get().n, 5);
  assert.equal(db.sqlite.prepare("SELECT paid_amount_cents AS v FROM accounts_payable WHERE id='p1'").get().v, 15230);
  assert.equal((await get()).find((item) => item.id === other.id).paymentSuggestion, null);
  assert.equal((await patch(other.id, { categoryItemId: "item-luz", confirm: true, paymentId: "pm1" })).status, 409);
});

test("VOLTAR PARA A CLASSIFICAR desfaz o vínculo e o pagamento volta a ser sugerido", async () => {
  const id = db.sqlite.prepare("SELECT id FROM finance_bank_statement_entries WHERE payment_id='pm1'").get().id;
  assert.equal((await (await callRoute(bulk.POST, ADMIN, "POST", "/api/finance/bank-reconciliation/bulk", { action: "delete", ids: [id] })).json()).applied, 0);
  const res = await (await callRoute(bulk.POST, ADMIN, "POST", "/api/finance/bank-reconciliation/bulk", { action: "unclassify", ids: [id] })).json();
  assert.equal(res.applied, 1);
  const row = db.sqlite.prepare("SELECT status, payment_id AS pm, payable_id AS p FROM finance_bank_statement_entries WHERE id=?").get(id);
  assert.deepEqual([row.status, row.pm, row.p], ["pending", "", ""]);
  assert.equal((await get()).filter((item) => item.paymentSuggestion?.id === "pm1").length, 1);
});

test("tela: botão USAR ESTA SUGESTÃO e CONFIRMAR envia o paymentId", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /data-recon-use-payment=/);
  assert.match(html, /payload\.paymentId = rowEl\.dataset\.reconPaymentId/);
});
