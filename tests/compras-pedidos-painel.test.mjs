import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Compras > PEDIDOS (12/11/2026): cartão mostra os anexos (PEDIDO / NF) e o
// painel conta atraso, prazo, falta vincular NF, incompletos e cancelados.

const db = await setupRouteDb(["purchase_orders", "purchase_order_items", "purchase_order_attachments", "supplier_invoices", "finance_suppliers"]);
const route = await import("../app/api/compras-novo/orders/route.ts");
const COMPRAS = { id: "compras", permissions: ["purchases_draft:manage"] };
db.insert("purchase_orders", { id: "po1", origin: "native", status: "aguardando_chegada", created_by: "compras" });
db.insert("purchase_orders", { id: "po2", origin: "native", status: "aguardando_chegada", created_by: "compras" });
db.insert("purchase_order_attachments", { id: "a1", order_id: "po1", attachment_type: "pedido", r2_key: "k1", file_name: "PED.pdf", uploaded_by: "compras" });
db.insert("purchase_order_attachments", { id: "a2", order_id: "po1", attachment_type: "nota_fiscal", r2_key: "k2", file_name: "NF.pdf", uploaded_by: "compras" });
db.insert("supplier_invoices", { id: "inv1", company_id: "clojaalfa1", invoice_number: "555", purchase_order_id: "po1", created_by: "fin" });

test("lista de pedidos traz anexos e se a NF já está vinculada", async () => {
  const response = await callRoute(route.GET, COMPRAS, "GET", "/api/compras-novo/orders", undefined, {});
  assert.equal(response.status, 200);
  const byId = Object.fromEntries((await response.json()).orders.map((o) => [o.id, o]));
  assert.deepEqual(byId.po1.attachments.map((a) => [a.attachmentType, a.fileName]), [["pedido", "PED.pdf"], ["nota_fiscal", "NF.pdf"]]);
  assert.equal(byId.po1.hasLinkedInvoice, true);
  assert.deepEqual(byId.po2.attachments, []);
  assert.equal(byId.po2.hasLinkedInvoice, false);
});

test("painel da aba PEDIDOS: 5 contadores clicáveis e NF só para pedidos novos", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  for (const key of ["atrasados", "prazo", "semNf", "incompletos", "cancelados"]) {
    assert.match(html, new RegExp(`data-compras-dash="${key}"`));
  }
  assert.match(html, /const COMPRAS_NF_LINK_SINCE = '2026-11-12 14:00:00';/);
  assert.match(html, /o\.status === 'concluido' && !o\.hasLinkedInvoice && String\(o\.createdAt \|\| ''\) >= COMPRAS_NF_LINK_SINCE/);
  assert.match(html, /'<footer class="purchase-card-footer">'\+comprasOrderFilesHtml\(order\)/);
});
