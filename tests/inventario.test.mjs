import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Estoque > Inventário: categorias, contagem (às cegas, ao vivo), custo pelo
// relatório de produto, divergências com motivo/retirada, escopo de loja e
// anotados para inventário das Divergências.

const db = await setupRouteDb(["shared_state", "inventories", "inventory_categories", "inventory_items", "inventory_attachments", "divergence_requests", "divergence_items"]);
const route = await import("../app/api/inventario/route.ts");
const { matchCosts, differenceValueCents } = await import("../app/lib/inventario.ts");

const A = "clojaalfa1";
const B = "clojabeta1";
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: A, name: "GUARARAPES" }, { id: B, name: "TACARUNA" }, { id: "cdeposi001", name: "DEPÓSITO" }]) });
db.insert("divergence_requests", { id: "r1", company_id: A, company_name: "GUARARAPES", status: "finalizado", created_by: "x", created_by_name: "X", created_at: "2026-10-01" });
db.insert("divergence_items", { id: "d1", request_id: "r1", product_code: "7898587276499", product_name: "ABAFADOR RUIDO OEX ROSA", position: 1, physical_qty: 0, system_qty: 1, status: "inventario", created_by: "x", created_by_name: "X", created_at: "2026-10-01" });

const GESTOR = { id: "renato", name: "RENATO", permissions: ["inventario:view", "inventario:manage", "inventario:count"] };
const CONTADOR = { id: "lidiane", name: "LIDIANE", permissions: ["inventario:view", "inventario:count"] };
const LOJA_B = { id: "loja-b", companyId: B, permissions: ["inventario:view", "inventario:count", "inventario:manage"] };
const call = (actor, method, body, query = "") => callRoute(route[method], actor, method, `/api/inventario${query}`, body);
const items = [
  { code: "7898587276481", product: "abafador ruido oex azul", systemQty: 4 },
  { code: "7898587276499", product: "ABAFADOR RUIDO OEX ROSA", systemQty: 1 },
  { code: "7896637648547", product: "CONTROLE REMOTO INTELBRAS XTR 1000", systemQty: 0 },
];

test("matchCosts: código, código de barras e nome; valor = custo × diferença", () => {
  const matched = matchCosts(
    [{ id: "1", code: "7898587276481", product: "ABAFADOR RUIDO OEX AZUL" }, { id: "2", code: "0012", product: "X" }, { id: "3", code: "999", product: "Controle Remoto  Intelbras XTR-1000" }],
    [
      { code: "78920180032191120", barcode: "", gtin: "", name: "ABAFADOR RUIDO OEX AZUL", costCents: 6000 },
      { code: "12", barcode: "", gtin: "", name: "OUTRO", costCents: 4550 },
      { code: "", barcode: "", gtin: "", name: "CONTROLE REMOTO INTELBRAS XTR 1000", costCents: 3000 },
    ],
  );
  assert.equal(matched.get("1"), 6000);
  assert.equal(matched.get("2"), 4550);
  assert.equal(matched.get("3"), 3000);
  assert.equal(differenceValueCents(2, 4, 6000), -12000);
  assert.equal(differenceValueCents(null, 4, 6000), null);
});

test("fluxo completo: categoria, contagem por vários usuários, custos, divergências e finalização", async () => {
  assert.equal((await call(CONTADOR, "POST", { storeId: A, inventoryDate: "2026-10-18" })).status, 403);
  assert.equal((await call(GESTOR, "POST", { storeId: "cdeposi001", inventoryDate: "2026-10-18" })).status, 400);
  const created = await call(GESTOR, "POST", { storeId: A, inventoryDate: "2026-10-18" });
  assert.equal(created.status, 201);
  const { id } = await created.json();

  assert.equal((await call(CONTADOR, "PATCH", { id, action: "upload_category", category: "acessorios em geral", items })).status, 403);
  assert.equal((await call(GESTOR, "PATCH", { id, action: "upload_category", category: "acessorios em geral", fileName: "a.xls", items })).status, 200);
  let detail = await (await call(CONTADOR, "GET", undefined, `?id=${id}`)).json();
  assert.deepEqual(detail.categories.map((c) => c.category), ["ACESSORIOS EM GERAL"]);
  assert.equal(detail.items.length, 3);
  assert.equal(detail.divergencesNoted.length, 1);
  const byName = (name) => detail.items.find((item) => item.product === name);

  // Contagem: LIDIANE conta dois; o terceiro fica sem contagem e vira zero ao finalizar.
  assert.equal((await call(CONTADOR, "PATCH", { id, action: "count", itemId: byName("ABAFADOR RUIDO OEX AZUL").id, countedQty: 2 })).status, 200);
  assert.equal((await call(CONTADOR, "PATCH", { id, action: "count", itemId: byName("ABAFADOR RUIDO OEX ROSA").id, countedQty: 1 })).status, 200);
  assert.equal((await call(CONTADOR, "PATCH", { id, action: "count", itemId: byName("ABAFADOR RUIDO OEX ROSA").id, countedQty: -1 })).status, 400);
  // Subir de novo uma categoria já contada é recusado.
  assert.equal((await call(GESTOR, "PATCH", { id, action: "upload_category", category: "ACESSORIOS EM GERAL", items })).status, 409);
  assert.equal((await call(CONTADOR, "PATCH", { id, action: "finish_category", category: "ACESSORIOS EM GERAL" })).status, 200);
  detail = await (await call(GESTOR, "GET", undefined, `?id=${id}`)).json();
  assert.equal(detail.categories[0].countedByName, "LIDIANE");
  assert.equal(detail.items.find((i) => i.product.startsWith("CONTROLE")).countedQty, 0);
  // Encontrado depois da finalização da categoria: ainda dá para corrigir.
  assert.equal((await call(CONTADOR, "PATCH", { id, action: "count", itemId: byName("ABAFADOR RUIDO OEX AZUL").id, countedQty: 3 })).status, 200);

  // Custos pelo Relatório de Produto.
  const costs = await call(GESTOR, "PATCH", { id, action: "costs", fileName: "custos.xls", costs: [
    { code: "78920180032191120", barcode: "78900003624", gtin: "", name: "ABAFADOR RUIDO OEX AZUL", costCents: 6000 },
    { code: "7898587276499", barcode: "", gtin: "", name: "ABAFADOR RUIDO OEX ROSA", costCents: 6000 },
  ] });
  assert.deepEqual(await costs.json(), { matched: 2, items: 3 });
  detail = await (await call(GESTOR, "GET", undefined, `?id=${id}`)).json();
  const azul = detail.items.find((i) => i.product === "ABAFADOR RUIDO OEX AZUL");
  assert.equal(azul.countedQty, 3);
  assert.equal(azul.costCents, 6000);

  // Motivo e retirada da lista final.
  assert.equal((await call(CONTADOR, "PATCH", { id, action: "reason", itemId: azul.id, reason: "x" })).status, 403);
  assert.equal((await call(GESTOR, "PATCH", { id, action: "reason", itemId: azul.id, reason: "avaria na vitrine" })).status, 200);
  assert.equal((await call(GESTOR, "PATCH", { id, action: "remove", itemId: azul.id, removed: true })).status, 200);
  detail = await (await call(GESTOR, "GET", undefined, `?id=${id}`)).json();
  const removed = detail.items.find((i) => i.id === azul.id);
  assert.equal(removed.reason, "AVARIA NA VITRINE");
  assert.equal(removed.removed, 1);
  assert.equal(removed.removedByName, "RENATO");

  // Lista: divergente só os não retirados.
  const list = await (await call(GESTOR, "GET")).json();
  assert.equal(list.inventories[0].divergent, 0);
  assert.equal(list.inventories[0].countedCategories, 1);

  // Finalizado não aceita alteração até reabrir.
  assert.equal((await call(GESTOR, "PATCH", { id, action: "finalize", finalized: true })).status, 200);
  assert.equal((await call(CONTADOR, "PATCH", { id, action: "count", itemId: azul.id, countedQty: 4 })).status, 409);
  assert.equal((await call(GESTOR, "PATCH", { id, action: "finalize", finalized: false })).status, 200);

  // Escopo de loja: login da TACARUNA não vê o inventário da GUARARAPES.
  assert.equal((await call(LOJA_B, "GET", undefined, `?id=${id}`)).status, 404);
  assert.equal((await (await call(LOJA_B, "GET")).json()).inventories.length, 0);
  assert.equal((await call(LOJA_B, "POST", { storeId: A, inventoryDate: "2026-10-18" })).status, 400);

  assert.equal((await call(GESTOR, "DELETE", { id })).status, 403);
  assert.equal((await call({ id: "adm", role: "admin", permissions: [] }, "DELETE", { id })).status, 200);
  assert.equal((await (await call(GESTOR, "GET")).json()).inventories.length, 0);
});
