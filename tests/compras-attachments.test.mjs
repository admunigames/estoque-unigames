import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Compras: excluir de vez o anexo do pedido (arquivo do pedido ou nota
// fiscal) — apaga o arquivo no R2 e o registro; a NF do Financeiro que usava
// o mesmo arquivo perde a referência junto.

const db = await setupRouteDb(["purchase_order_attachments", "supplier_invoice_attachments", "supplier_invoices"]);
const route = await import("../app/api/compras-novo/orders/[id]/attachments/route.ts");
const COMPRAS = { id: "compras", permissions: ["purchases_draft:manage"] };
const attach = (id, orderId, type) =>
  db.insert("purchase_order_attachments", { id, order_id: orderId, attachment_type: type, r2_key: `purchase-orders/${orderId}/${id}-x.pdf`, file_name: `${id}.pdf`, uploaded_by: "compras" });
attach("a1", "po1", "pedido");
attach("a2", "po1", "nota_fiscal");
attach("a3", "po2", "pedido");
db.insert("supplier_invoices", { id: "inv1", company_id: "clojaalfa1", invoice_number: "555", created_by: "fin" });
db.insert("supplier_invoice_attachments", { id: "sia1", invoice_id: "inv1", attachment_type: "nf", r2_key: "purchase-orders/po1/a2-x.pdf", file_name: "a2.pdf", uploaded_by: "compras" });

const del = (user, orderId, attachmentId) =>
  callRoute(route.DELETE, user, "DELETE", `/api/compras-novo/orders/${orderId}/attachments?attachmentId=${attachmentId}`, undefined, { id: orderId });
const list = async (orderId) =>
  (await (await callRoute(route.GET, COMPRAS, "GET", `/api/compras-novo/orders/${orderId}/attachments`, undefined, { id: orderId })).json()).attachments;

test("lista marca a nota fiscal usada pela NF do Financeiro", async () => {
  const byId = Object.fromEntries((await list("po1")).map((a) => [a.id, a.invoiceNumber]));
  assert.deepEqual(byId, { a1: null, a2: "555" });
});

test("excluir anexo: permissão, anexo de outro pedido = 404, apaga R2 e registro", async () => {
  assert.equal((await del({ id: "x", permissions: ["stock:view"] }, "po1", "a1")).status, 403);
  assert.equal((await del(COMPRAS, "po1", "a3")).status, 404, "anexo do po2 pelo po1");
  assert.equal(globalThis.__routeTestBucket.deletedKeys.length, 0);

  const ok = await del(COMPRAS, "po1", "a1");
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).name, "a1.pdf", "nome vai para a Auditoria");
  assert.deepEqual(globalThis.__routeTestBucket.deletedKeys, ["purchase-orders/po1/a1-x.pdf"]);
  assert.deepEqual((await list("po1")).map((a) => a.id), ["a2"]);

  assert.equal((await del(COMPRAS, "po1", "a2")).status, 200);
  assert.deepEqual(await list("po1"), []);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM supplier_invoice_attachments").get().n, 0, "NF do Financeiro perde o arquivo apagado");
  assert.equal((await del(COMPRAS, "po1", "a2")).status, 404, "já excluído");
  assert.deepEqual((await list("po2")).map((a) => a.id), ["a3"], "outro pedido intacto");
});
