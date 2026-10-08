import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Compras — pedido aberto simplificado: produto em texto livre, fornecedor
// como coluna da cotação (vale para todos os itens), fechamento com loja que
// fatura (CNPJ) + previsão de chegada, e lista Abertos → Aguardando → Concluídos.

const db = await setupRouteDb([
  "shared_state", "product_catalog", "finance_suppliers", "purchase_orders", "purchase_order_items",
  "purchase_order_item_quotes", "purchase_order_attachments", "supplier_invoices",
]);
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: "clojaalfa1", name: "LOJA ALFA" }]) });
db.insert("product_catalog", { id: "p1", name: "CONTROLE PS5", code_unigames: "1001", code_pa: "PA1001" });
for (const [id, name] of [["s-a", "FORNECEDOR A"], ["s-b", "FORNECEDOR B"]]) {
  db.insert("finance_suppliers", { id, name, document: "", notes: "", active: 1, created_by: "admin", created_by_name: "ADMIN" });
}

const orders = await import("../app/api/compras-novo/orders/route.ts");
const items = await import("../app/api/compras-novo/orders/[id]/items/route.ts");
const item = await import("../app/api/compras-novo/orders/[id]/items/[itemId]/route.ts");
const quotes = await import("../app/api/compras-novo/orders/[id]/items/[itemId]/quotes/route.ts");
const suppliers = await import("../app/api/compras-novo/orders/[id]/suppliers/route.ts");
const winner = await import("../app/api/compras-novo/orders/[id]/winner/route.ts");

const ADMIN = { id: "admin", role: "admin" };
const BUYER = { id: "u-buyer", permissions: ["purchases_draft:manage"] };
const OTHER = { id: "u-other", permissions: ["stock:view"] };

async function newOrder(name) {
  const res = await callRoute(orders.POST, ADMIN, "POST", "/api/compras-novo/orders", { name, notes: name });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}
const addItem = (orderId, body) =>
  callRoute(items.POST, BUYER, "POST", `/api/compras-novo/orders/${orderId}/items`, body, { id: orderId });
const supplierCol = (actor, orderId, body) =>
  callRoute(suppliers.POST, actor, "POST", `/api/compras-novo/orders/${orderId}/suppliers`, body, { id: orderId });
const quote = (orderId, itemId, body) =>
  callRoute(quotes.POST, BUYER, "POST", `/api/compras-novo/orders/${orderId}/items/${itemId}/quotes`, body, { id: orderId, itemId });
const itemRows = (orderId) => db.sqlite.prepare("SELECT * FROM purchase_order_items WHERE order_id=? ORDER BY created_at, product_name").all(orderId);

test("produto: do catálogo (nome oficial) ou texto livre só com o nome; vazio = 400", async () => {
  const orderId = await newOrder("PEDIDO 1");
  assert.equal((await addItem(orderId, { productCode: "1001", productName: "", quantity: 10 })).status, 201);
  assert.equal((await addItem(orderId, { productCode: "", productName: "SUPORTE TV 55", quantity: 5 })).status, 201);
  assert.equal((await addItem(orderId, { productCode: "", productName: "", quantity: 1 })).status, 400);
  const rows = itemRows(orderId);
  assert.deepEqual(rows.map((r) => [r.product_code, r.product_name, r.quantity]).sort(), [["", "SUPORTE TV 55", 5], ["1001", "CONTROLE PS5", 10]]);
  // Editar um item em texto livre continua aceitando ficar sem código.
  const free = rows.find((r) => !r.product_code);
  const res = await callRoute(item.PATCH, BUYER, "PATCH", `/api/compras-novo/orders/${orderId}/items/${free.id}`,
    { productCode: "", productName: "SUPORTE TV 65", quantity: 6 }, { id: orderId, itemId: free.id });
  assert.equal(res.status, 200);
});

test("coluna de fornecedor: entra em todos os itens; remover apaga as cotações dele no pedido", async () => {
  const orderId = await newOrder("PEDIDO 2");
  assert.equal((await supplierCol(BUYER, orderId, { supplierId: "s-a", action: "add" })).status, 400, "sem produto ainda");
  await addItem(orderId, { productCode: "1001", quantity: 2 });
  await addItem(orderId, { productCode: "", productName: "CABO X", quantity: 3 });
  assert.equal((await supplierCol(OTHER, orderId, { supplierId: "s-a", action: "add" })).status, 403);
  assert.equal((await supplierCol(BUYER, orderId, { supplierId: "nao-existe", action: "add" })).status, 404);
  assert.equal((await supplierCol(BUYER, orderId, { supplierId: "s-a", action: "add" })).status, 200);
  assert.equal((await supplierCol(BUYER, orderId, { supplierId: "s-b", action: "add" })).status, 200);
  for (const row of itemRows(orderId)) assert.deepEqual(JSON.parse(row.candidate_supplier_ids), ["s-a", "s-b"]);
  const [first] = itemRows(orderId);
  assert.equal((await quote(orderId, first.id, { supplierId: "s-b", unitPriceCents: 1000 })).status, 201);
  assert.equal((await supplierCol(BUYER, orderId, { supplierId: "s-b", action: "remove" })).status, 200);
  for (const row of itemRows(orderId)) assert.deepEqual(JSON.parse(row.candidate_supplier_ids), ["s-a"]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM purchase_order_item_quotes WHERE supplier_id='s-b'").get().n, 0);
});

test("fechamento: exige a loja que fatura; grava loja, previsão e preço do vencedor; lista Abertos → Aguardando", async () => {
  const orderId = await newOrder("PEDIDO 3");
  await addItem(orderId, { productCode: "1001", quantity: 4 });
  const [row] = itemRows(orderId);
  await quote(orderId, row.id, { supplierId: "s-a", unitPriceCents: 25000 });
  const close = (body) => callRoute(winner.POST, BUYER, "POST", `/api/compras-novo/orders/${orderId}/winner`, body, { id: orderId });
  assert.equal((await close({ supplierId: "s-a" })).status, 400, "sem loja");
  assert.equal((await close({ supplierId: "s-a", companyId: "nao-existe" })).status, 400);
  assert.equal((await close({ supplierId: "s-a", companyId: "clojaalfa1", expectedDate: "15/10/2026" })).status, 400, "data no formato errado");
  assert.equal((await close({ supplierId: "s-a", companyId: "clojaalfa1", expectedDate: "2026-10-15" })).status, 200);
  const order = db.sqlite.prepare("SELECT status, supplier_id, company_id, company_name, expected_date FROM purchase_orders WHERE id=?").get(orderId);
  assert.deepEqual({ ...order }, { status: "aguardando_chegada", supplier_id: "s-a", company_id: "clojaalfa1", company_name: "LOJA ALFA", expected_date: "2026-10-15" });
  assert.equal(itemRows(orderId)[0].unit_price_cents, 25000);
  // Sem previsão: não apaga a previsão que já existia.
  const other = await newOrder("PEDIDO 4");
  db.sqlite.prepare("UPDATE purchase_orders SET expected_date='2026-11-01' WHERE id=?").run(other);
  await addItem(other, { productCode: "1001", quantity: 1 });
  const res = await callRoute(winner.POST, BUYER, "POST", `/api/compras-novo/orders/${other}/winner`, { supplierId: "s-b", companyId: "clojaalfa1" }, { id: other });
  assert.equal(res.status, 200);
  assert.equal(db.sqlite.prepare("SELECT expected_date FROM purchase_orders WHERE id=?").get(other).expected_date, "2026-11-01");
  // Tudo recebido → concluído com a data de ENTREGA no dia de Recife (não UTC).
  const { todayInTimezone } = await import("../app/lib/finance-status.ts");
  const [closedItem] = itemRows(orderId);
  const received = await callRoute(item.PATCH, BUYER, "PATCH", `/api/compras-novo/orders/${orderId}/items/${closedItem.id}`,
    { receivedQuantity: closedItem.quantity }, { id: orderId, itemId: closedItem.id });
  assert.equal((await received.json()).orderStatus, "concluido");
  assert.equal(db.sqlite.prepare("SELECT received_date FROM purchase_orders WHERE id=?").get(orderId).received_date, todayInTimezone());
  db.sqlite.prepare("UPDATE purchase_orders SET status='aguardando_chegada', received_date='' WHERE id=?").run(orderId);
  db.sqlite.prepare("UPDATE purchase_order_items SET received_quantity=0 WHERE order_id=?").run(orderId);
  // Um concluído para conferir a ordem da lista.
  db.sqlite.prepare("UPDATE purchase_orders SET status='concluido' WHERE id=?").run(other);
  const list = await (await callRoute(orders.GET, ADMIN, "GET", "/api/compras-novo/orders")).json();
  const rank = { aberto: 0, aguardando_chegada: 1, concluido: 2 };
  // Unidades pedidas × recebidas na lista (selo "RECEBIMENTO INCOMPLETO") e a
  // loja que fatura no lugar das antigas "lojas destino".
  const closed = list.orders.find((o) => o.id === orderId);
  assert.equal(closed.orderedQty, 4);
  assert.equal(closed.receivedQty, 0);
  assert.deepEqual(closed.targetStoreNames, ["LOJA ALFA"]);
  const ranks = list.orders.map((o) => rank[o.status]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "abertos, depois aguardando, depois concluídos");
  assert.ok(ranks.includes(0) && ranks.includes(1) && ranks.includes(2));
});
