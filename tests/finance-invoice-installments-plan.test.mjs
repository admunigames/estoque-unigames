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

test("duplicatas digitadas à mão: soma diferente do total NÃO bloqueia (avisa a diferença); cada valor e vencimento gravado", async () => {
  invoice("nf-diverge");
  const diverge = await post("nf-diverge", { mode: "generate", installmentTotal: 3, firstDueDate: "2026-10-10", customDueDates: ["2026-10-10", "2026-10-25", "2026-12-05"], customAmounts: [3000, 3000, 3000] });
  assert.equal(diverge.status, 201);
  const warned = await diverge.json();
  assert.equal(warned.divergenceCents, 1000);
  assert.match(warned.divergenceWarning, /FALTAM R\$ 10,00 PARA FECHAR O TOTAL DA NF/);
  assert.equal(db.sqlite.prepare("SELECT financial_status AS s FROM supplier_invoices WHERE id='nf-diverge'").get().s, "aguardando_duplicatas");

  invoice("nf-plan");
  const plan = { mode: "generate", installmentTotal: 3, firstDueDate: "2026-10-10", customDueDates: ["2026-10-10", "2026-10-25", "2026-12-05"] };
  const ok = await post("nf-plan", { ...plan, customAmounts: [5000, 2500, 2500] });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).divergenceWarning, null);
  const rows = db.sqlite.prepare("SELECT due_date AS d, original_amount_cents AS a FROM supplier_invoice_installments WHERE invoice_id='nf-plan' ORDER BY installment_number").all();
  assert.deepEqual(rows.map((r) => [r.d, r.a]), [["2026-10-10", 5000], ["2026-10-25", 2500], ["2026-12-05", 2500]]);
  assert.equal(cell("item-serv"), 9000 + 10000, "NF de serviço entra na DRE como antes (as duas NFs)");
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

test("painel das NFs: quantidade e valor por situação (sem o filtro de situação); tela mostra os números", async () => {
  const listRoute = await import("../app/api/finance/invoices/route.ts");
  const data = await (await callRoute(listRoute.GET, ADMIN, "GET", "/api/finance/invoices?status=pago")).json();
  const byStatus = Object.fromEntries(data.summary.map((row) => [row.status, row]));
  const total = data.summary.reduce((sum, row) => sum + row.count, 0);
  assert.equal(total, db.sqlite.prepare("SELECT COUNT(*) AS n FROM supplier_invoices").get().n, "o resumo ignora o filtro de situação");
  assert.equal(byStatus.aguardando_duplicatas.count >= 1, true);
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /invoiceStatusSummary = Array\.isArray\(data\.summary\)/);
  assert.match(html, /id="btnInvoiceAddPlanRow"/);
  assert.match(html, /id="btnInvoiceSplitPlan"/);
  assert.doesNotMatch(html, /name="invoiceInstallmentMode"/);
});

test("NF sem categoria: as duplicatas usam a CATEGORIA NA DRE escolhida na tela (e a NF passa a ter a categoria)", async () => {
  invoice("nf-sem-item", { finance_item_id: "", finance_category_id: "" });
  const blocked = await post("nf-sem-item", { mode: "manual", dueDate: "2026-10-20", originalAmountCents: 10000 });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /CATEGORIA NA DRE/);
  const ok = await post("nf-sem-item", { mode: "manual", dueDate: "2026-10-20", originalAmountCents: 10000, dreFinanceItemId: "item-serv" });
  assert.equal(ok.status, 201, JSON.stringify(await ok.clone().json()));
  assert.equal(db.sqlite.prepare("SELECT finance_item_id AS i FROM supplier_invoices WHERE id='nf-sem-item'").get().i, "item-serv");
  assert.equal(db.sqlite.prepare("SELECT finance_item_id AS i FROM accounts_payable WHERE invoice_number='nf-sem-item'").get().i, "item-serv");
});

test("NF sem categoria com NÃO INCLUIR na DRE: cadastra as duplicatas sem pedir categoria", async () => {
  invoice("nf-sem-item-none", { finance_item_id: "", finance_category_id: "" });
  const ok = await post("nf-sem-item-none", { mode: "manual", dueDate: "2026-10-20", originalAmountCents: 10000, dreTarget: "none" });
  assert.equal(ok.status, 201, JSON.stringify(await ok.clone().json()));
  const payable = db.sqlite.prepare("SELECT finance_item_id AS i, dre_target AS t FROM accounts_payable WHERE invoice_number='nf-sem-item-none'").get();
  assert.deepEqual([payable.i, payable.t], ["", "none"]);
});
