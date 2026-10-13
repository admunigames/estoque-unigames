import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// NF no recebimento do pedido de compra: o Compras (purchases_draft:manage)
// cadastra a NF só quando ela vem do pedido; a NF solta segue com o Financeiro.

const db = await setupRouteDb([
  "shared_state", "supplier_invoices", "supplier_invoice_events", "purchase_orders", "purchase_order_attachments",
  "finance_cost_centers", "finance_suppliers",
]);
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: "clojaalfa1", name: "LOJA ALFA" }]) });
db.insert("purchase_orders", { id: "po1", origin: "native", supplier_id: "s1", supplier_name_raw: "OEX", status: "aguardando_chegada", created_by: "admin" });
const route = await import("../app/api/finance/invoices/route.ts");
const COMPRAS = { id: "compras", permissions: ["purchases_draft:manage"] };
const body = (extra = {}) => ({ companyId: "clojaalfa1", companyName: "LOJA ALFA", supplierId: "s1", invoiceNumber: "123", series: "1",
  competenceMonth: "2026-10", totalAmountCents: 100000, ...extra });
const post = (user, b) => callRoute(route.POST, user, "POST", "/api/finance/invoices", b);

test("Compras cadastra NF a partir do pedido; sem pedido continua recusado", async () => {
  assert.equal((await post(COMPRAS, body())).status, 403, "NF solta: só Financeiro");
  assert.equal((await post(COMPRAS, body({ purchaseOrderId: "nao-existe" }))).status, 404);
  const ok = await post(COMPRAS, body({ purchaseOrderId: "po1" }));
  assert.equal(ok.status, 201, JSON.stringify(await ok.clone().json()));
  const row = db.sqlite.prepare("SELECT purchase_order_id, total_amount_cents FROM supplier_invoices WHERE invoice_number='123'").get();
  assert.deepEqual([row.purchase_order_id, row.total_amount_cents], ["po1", 100000]);
  assert.equal((await post({ id: "x", permissions: ["stock:view"] }, body({ purchaseOrderId: "po1", invoiceNumber: "124" }))).status, 403);
});
