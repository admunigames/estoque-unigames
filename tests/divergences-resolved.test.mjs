import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// GET /api/divergences/resolved (PDF DE CONCLUÍDAS): itens resolvidos no
// período pela ÚLTIMA resolução (evento "respond" que mudou o status para
// concluído/inventário), com escopo por loja.
const db = await setupRouteDb([
  "divergence_requests",
  "divergence_items",
  "divergence_item_events",
  "divergence_item_attachments",
]);
const route = await import("../app/api/divergences/resolved/route.ts");

const STORE_A = "criomar001";
const STORE_B = "crecife001";
const STORE_USER = { id: "loja-a", companyId: STORE_A, permissions: ["divergencias:view"] };
const GENERAL = { id: "estoque", companyId: "", permissions: ["divergencias:view"] };

let seq = 0;
function request(companyId, companyName) {
  const id = `req-${++seq}`;
  db.insert("divergence_requests", { id, company_id: companyId, company_name: companyName, status: "finalizado", created_at: "2026-01-01T12:00:00.000Z" });
  return id;
}
function item(requestId, id, status, extra = {}) {
  db.insert("divergence_items", {
    id, request_id: requestId, product_name: `PRODUTO ${id}`, product_code: `C-${id}`, physical_qty: 1, system_qty: 3,
    status, stock_response: `RESPOSTA ${id}`, store_reply: "", created_at: "2026-01-01T12:00:00.000Z", ...extra,
  });
}
function event(itemId, requestId, kind, fromStatus, toStatus, createdAt, actor = "ADM") {
  db.insert("divergence_item_events", {
    id: `ev-${++seq}`, item_id: itemId, request_id: requestId, kind, from_status: fromStatus, to_status: toStatus,
    actor_name: actor, created_at: createdAt,
  });
}

const reqA = request(STORE_A, "RIOMAR");
// Resolvido dentro do período; responder de novo com o MESMO status não muda a data.
item(reqA, "dentro", "concluido", { store_reply: "ACHEI NO DEPÓSITO" });
event("dentro", reqA, "respond", "nao_visto", "concluido", "2026-10-05T12:00:00.000Z", "MARIA");
event("dentro", reqA, "respond", "concluido", "concluido", "2026-10-20T12:00:00.000Z", "JOSE");
db.insert("divergence_item_attachments", { id: "an-1", item_id: "dentro", request_id: reqA, side: "adm", r2_key: "k1", file_name: "PRINT-PDV.PNG", created_at: "2026-10-05T12:00:01.000Z" });
db.insert("divergence_item_attachments", { id: "an-2", item_id: "dentro", request_id: reqA, side: "loja", r2_key: "k2", file_name: "FOTO.JPG", created_at: "2026-10-05T12:00:02.000Z" });
// Resolvido antes do período.
item(reqA, "fora", "concluido");
event("fora", reqA, "respond", "nao_visto", "concluido", "2026-09-20T12:00:00.000Z");
// Reaberto e resolvido de novo: vale a ÚLTIMA resolução (dentro); INVENTARIADO e
// anexo depois gravam o mesmo status e não contam.
item(reqA, "reaberto", "inventario");
event("reaberto", reqA, "respond", "nao_visto", "concluido", "2026-09-25T12:00:00.000Z");
event("reaberto", reqA, "respond", "concluido", "em_verificacao", "2026-10-02T12:00:00.000Z");
event("reaberto", reqA, "respond", "em_verificacao", "inventario", "2026-10-10T12:00:00.000Z", "ANA");
event("reaberto", reqA, "inventoried", "inventario", "inventario", "2026-11-20T12:00:00.000Z");
event("reaberto", reqA, "attachment", "inventario", "inventario", "2026-11-21T12:00:00.000Z");
// Resolvido no período mas reaberto depois: pendente, não entra.
item(reqA, "pendente", "em_verificacao");
event("pendente", reqA, "respond", "nao_visto", "concluido", "2026-10-06T12:00:00.000Z");
event("pendente", reqA, "respond", "concluido", "em_verificacao", "2026-10-07T12:00:00.000Z");
// Bordas do fuso de Recife (UTC-3): 01/10 02:30Z = 30/09 23:30 (fora);
// 01/11 02:59Z = 31/10 23:59 (dentro).
item(reqA, "borda-antes", "concluido");
event("borda-antes", reqA, "respond", "nao_visto", "concluido", "2026-10-01T02:30:00.000Z");
item(reqA, "borda-fim", "concluido");
event("borda-fim", reqA, "respond", "nao_visto", "concluido", "2026-11-01T02:59:00.000Z");

const reqB = request(STORE_B, "RECIFE");
item(reqB, "outra-loja", "concluido");
event("outra-loja", reqB, "respond", "nao_visto", "concluido", "2026-10-08T12:00:00.000Z");

async function get(user, query) {
  const response = await callRoute(route.GET, user, "GET", `/api/divergences/resolved?${query}`);
  return { status: response.status, body: await response.json() };
}

test("período inclusivo em Recife, última resolução e pendente fora", async () => {
  const { status, body } = await get(GENERAL, "from=2026-10-01&to=2026-10-31");
  assert.equal(status, 200);
  // Por loja (alfabética: RECIFE antes de RIOMAR) e, dentro dela, pela resolução.
  assert.deepEqual(body.items.map((row) => row.itemId), ["outra-loja", "dentro", "reaberto", "borda-fim"]);
  const dentro = body.items[1];
  assert.equal(dentro.resolvedAt, "2026-10-05T12:00:00.000Z");
  assert.equal(dentro.resolvedByName, "MARIA");
  assert.equal(dentro.physicalQty, 1);
  assert.equal(dentro.systemQty, 3);
  assert.equal(dentro.storeReply, "ACHEI NO DEPÓSITO");
  assert.deepEqual(dentro.attachments, [{ side: "adm", fileName: "PRINT-PDV.PNG" }, { side: "loja", fileName: "FOTO.JPG" }]);
  const reaberto = body.items[2];
  assert.equal(reaberto.resolvedAt, "2026-10-10T12:00:00.000Z");
  assert.equal(reaberto.resolvedByName, "ANA");
  assert.equal(reaberto.status, "inventario");
  // Sem dados de abertura no retorno.
  assert.ok(body.items.every((row) => !("createdAt" in row) && !("createdByName" in row) && !("requestId" in row)));
  // Período de setembro: só o que foi resolvido em setembro (o reaberto não).
  const september = await get(GENERAL, "from=2026-09-01&to=2026-09-30");
  assert.deepEqual(september.body.items.map((row) => row.itemId), ["fora", "borda-antes"]);
});

test("loja só vê a própria; acesso geral filtra por loja ou vê todas", async () => {
  const store = await get(STORE_USER, `from=2026-10-01&to=2026-10-31&companyId=${STORE_B}`);
  assert.equal(store.status, 200);
  assert.ok(store.body.items.length && store.body.items.every((row) => row.companyId === STORE_A));
  const onlyB = await get(GENERAL, `from=2026-10-01&to=2026-10-31&companyId=${STORE_B}`);
  assert.deepEqual(onlyB.body.items.map((row) => row.itemId), ["outra-loja"]);
  assert.equal((await get({ id: "x", companyId: STORE_A, permissions: ["outputs:view"] }, "from=2026-10-01&to=2026-10-31")).status, 403);
  assert.equal((await get(GENERAL, "from=2026-10-31&to=2026-10-01")).status, 400);
  assert.equal((await get(GENERAL, "from=2026-10-01")).status, 400);
});
