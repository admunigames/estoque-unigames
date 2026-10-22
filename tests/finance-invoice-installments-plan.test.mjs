import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Notas Fiscais (prompt 5, 22/10/2026): parcelas com vencimento/valor
// editáveis (soma tem de bater com o total da NF), NF de compra de mercadoria
// nasce fora da DRE e duplicata não paga editável (conta a pagar junto).

const db = await setupRouteDb([
  "shared_state", "accounts_payable", "accounts_payable_payments", "finance_items", "finance_categories", "finance_accounts",
  "finance_store_entries", "supplier_invoices", "supplier_invoice_installments", "supplier_invoice_events",
  "supplier_invoice_attachments", "finance_suppliers", "purchase_orders",
]);
const installmentsRoute = await import("../app/api/finance/invoices/[id]/installments/route.ts");
const installmentRoute = await import("../app/api/finance/invoices/[id]/installments/[installmentId]/route.ts");
const detailRoute = await import("../app/api/finance/invoices/[id]/route.ts");

const ALFA = "clojaalfa1";
const ADMIN = { id: "admin", role: "admin" };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }]) });
db.insert("finance_categories", { id: "cat-merc", name: "MERCADORIA PARA REVENDA", created_by: "admin" });
db.insert("finance_categories", { id: "cat-serv", name: "SERVIÇOS", created_by: "admin" });
db.insert("finance_items", { id: "item-merc", category_id: "cat-merc", name: "COMPRA DE JOGOS", created_by: "admin" });
db.insert("finance_items", { id: "item-serv", category_id: "cat-serv", name: "MANUTENÇÃO", created_by: "admin" });

function invoice(id, extra = {}) {
  db.insert("supplier_invoices", {
    id, company_id: ALFA, company_name: "LOJA ALFA", invoice_number: id, competence_month: "2026-10",
    total_amount_cents: 10000, finance_category_id: "cat-serv", finance_item_id: "item-serv", origin: "manual",
    financial_status: "aguardando_duplicatas", sent_to_finance_at: "2026-10-01T10:00:00Z", created_by: "admin", ...extra,
  });
}
const cell = (item) => db.sqlite.prepare("SELECT amount_cents AS c FROM finance_store_entries WHERE store_id=? AND item_id=?").get(ALFA, item)?.c ?? 0;
const post = (id, body) => callRoute(installmentsRoute.POST, ADMIN, "POST", `/api/finance/invoices/${id}/installments`, body, { id });

test("parcelas com valor digitado: soma diferente do total recusa (com a diferença); igual grava cada valor e vencimento", async () => {
  invoice("nf-plan");
  const plan = { mode: "generate", installmentTotal: 3, firstDueDate: "2026-10-10", customDueDates: ["2026-10-10", "2026-10-25", "2026-12-05"] };
  const wrong = await post("nf-plan", { ...plan, customAmounts: [3000, 3000, 3000] });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /DIFERENÇA DE R\$ 10,00/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM supplier_invoice_installments").get().n, 0);
  const ok = await post("nf-plan", { ...plan, customAmounts: [5000, 2500, 2500] });
  assert.equal(ok.status, 201);
  const rows = db.sqlite.prepare("SELECT due_date AS d, original_amount_cents AS a FROM supplier_invoice_installments WHERE invoice_id='nf-plan' ORDER BY installment_number").all();
  assert.deepEqual(rows.map((r) => [r.d, r.a]), [["2026-10-10", 5000], ["2026-10-25", 2500], ["2026-12-05", 2500]]);
  assert.equal(cell("item-serv"), 10000, "NF de serviço entra na DRE como antes");
});

test("NF de compra de mercadoria (pedido de Compras ou categoria de mercadoria) nasce fora da DRE", async () => {
  invoice("nf-compra", { origin: "purchase", finance_category_id: "cat-merc", finance_item_id: "item-merc" });
  const detail = await (await callRoute(detailRoute.GET, ADMIN, "GET", "/api/finance/invoices/nf-compra", undefined, { id: "nf-compra" })).json();
  assert.equal(detail.merchandisePurchase, true);
  assert.equal((await post("nf-compra", { mode: "manual", dueDate: "2026-10-20", originalAmountCents: 10000 })).status, 201);
  assert.equal(cell("item-merc"), 0);
  assert.equal(db.sqlite.prepare("SELECT dre_target AS t, dre_amount_cents AS d FROM accounts_payable WHERE invoice_number='nf-compra'").get().t, "none");
  // Manual, mas com categoria de mercadoria para revenda: também fora.
  invoice("nf-merc-manual", { finance_category_id: "cat-merc", finance_item_id: "item-merc" });
  assert.equal((await post("nf-merc-manual", { mode: "manual", dueDate: "2026-10-20", originalAmountCents: 10000 })).status, 201);
  assert.equal(cell("item-merc"), 0);
  // Quem lança pode decidir incluir mesmo assim.
  invoice("nf-merc-incluida", { finance_category_id: "cat-merc", finance_item_id: "item-merc" });
  assert.equal((await post("nf-merc-incluida", { mode: "manual", dueDate: "2026-10-20", originalAmountCents: 10000, dreTarget: "include" })).status, 201);
  assert.equal(cell("item-merc"), 10000);
});

test("editar duplicata não paga atualiza a conta a pagar ligada; paga não edita", async () => {
  const first = db.sqlite.prepare("SELECT id, accounts_payable_id AS ap FROM supplier_invoice_installments WHERE invoice_id='nf-plan' AND installment_number=2").get();
  const res = await callRoute(installmentRoute.PATCH, ADMIN, "PATCH", `/api/finance/invoices/nf-plan/installments/${first.id}`,
    { dueDate: "2026-11-30", originalAmountCents: 2600 }, { id: "nf-plan", installmentId: first.id });
  assert.equal(res.status, 200);
  const payable = db.sqlite.prepare("SELECT due_date AS d, original_amount_cents AS a FROM accounts_payable WHERE id=?").get(first.ap);
  assert.deepEqual([payable.d, payable.a], ["2026-11-30", 2600]);
  db.sqlite.prepare("UPDATE supplier_invoice_installments SET paid_amount_cents=2600 WHERE id=?").run(first.id);
  const paid = await callRoute(installmentRoute.PATCH, ADMIN, "PATCH", `/api/finance/invoices/nf-plan/installments/${first.id}`,
    { dueDate: "2026-12-30" }, { id: "nf-plan", installmentId: first.id });
  assert.equal(paid.status, 409);
});
