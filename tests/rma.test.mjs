import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Assistência > RMA: cadastro, linha do tempo, finalização, alertas, loja só
// visualiza os da própria loja (AVULSO só a assistência), créditos e descartes
// fora do alcance da loja.

const db = await setupRouteDb(["shared_state", "rma_cases", "rma_updates", "rma_attachments", "rma_credits", "rma_disposals", "rma_suppliers", "assist_service_orders"]);
const route = await import("../app/api/assistencia/rma/route.ts");
const cadastros = await import("../app/api/assistencia/rma/cadastros/route.ts");
const file = await import("../app/api/assistencia/rma/file/route.ts");
const { rmaAlerts, parseMoneyCents } = await import("../app/lib/rma.ts");

const A = "clojaalfa1";
const B = "clojabeta1";
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: A, name: "GUARARAPES" }, { id: B, name: "TACARUNA" }]) });
db.insert("assist_service_orders", { id: "os1", os_number: "23423", category: "CELULAR", equipment: "REALME C85", status: "AUTORIZADA", store_id: A, store_name: "GUARARAPES", deadline: "2026-11-20", closed: 0, canceled: 0, created_at: "2026-10-01" });

const RMA = { id: "thierry", name: "THIERRY", permissions: ["rma:view", "rma:create", "rma:edit", "rma:finance"] };
const LOJA_A = { id: "loja-a", companyId: A, permissions: ["rma:view", "rma:create", "rma:edit", "rma:finance", "rma:delete"] };
const LOJA_B = { id: "loja-b", companyId: B, permissions: ["rma:view"] };
const call = (mod, actor, method, body, query = "", path = "") => callRoute(mod[method], actor, method, `/api/assistencia/rma${path}${query}`, body);

test("alertas e valores", () => {
  const base = { finalized: 0, status: "RECEBIDO", priority: "ALTA", osDeadline: "2026-10-20", lastUpdateAt: "2026-10-10T12:00:00Z", createdAt: "", nextUpdateDate: "2026-10-21" };
  const alerts = rmaAlerts(base, "2026-10-22");
  assert.deepEqual([alerts.stale, alerts.osLevel, alerts.highPriority, alerts.nextUpdateLate], [true, "vencida", true, true]);
  assert.equal(rmaAlerts({ ...base, osDeadline: "2026-10-26" }, "2026-10-22").osLevel, "vence_em_breve");
  assert.equal(rmaAlerts({ ...base, finalized: 1, status: "FINALIZADO" }, "2026-10-22").stale, false);
  assert.equal(parseMoneyCents("1.479,72"), 147972);
  assert.equal(parseMoneyCents(16), 1600);
  assert.equal(parseMoneyCents("abc"), null);
});

test("fluxo: cadastro, atualização, finalização, escopo de loja e avulso", async () => {
  const novo = { arrivalDate: "2026-10-22", storeId: A, supplier: "realme", responsible: "thierry", priority: "ALTA", osNumber: "23423",
    productName: "celular realme c85", productCategory: "SMARTPHONES", serialNumber: "860566080811457", quantity: 1, defectType: "NÃO LIGA" };
  assert.equal((await call(route, LOJA_A, "POST", novo)).status, 403);
  assert.equal((await call(route, RMA, "POST", { ...novo, productName: "" })).status, 400);
  const created = await call(route, RMA, "POST", novo);
  assert.equal(created.status, 201);
  const { id, code } = await created.json();
  assert.match(code, /^RMA-[0-9A-F]{6}$/);
  const avulso = await (await call(route, RMA, "POST", { ...novo, storeId: "", osNumber: "" })).json();

  // Atualização com próxima ação; FINALIZADO pede o tipo de solução.
  assert.equal((await call(route, RMA, "PUT", { id, responsible: "THIERRY", description: "enviado ao fornecedor", newStatus: "ENVIADO AO FORNECEDOR", nextAction: "cobrar retorno", nextUpdateDate: "2026-10-30" })).status, 201);
  assert.equal((await call(route, RMA, "PUT", { id, responsible: "THIERRY", description: "ok", newStatus: "FINALIZADO" })).status, 400);

  // Loja A vê o próprio RMA e a linha do tempo, sem custos; não vê o avulso.
  let list = await (await call(route, LOJA_A, "GET")).json();
  assert.equal(list.readOnly, true);
  assert.deepEqual(list.cases.map((row) => row.id), [id]);
  const detail = await (await call(route, LOJA_A, "GET", undefined, `?id=${id}`)).json();
  assert.equal(detail.rma.productName, "CELULAR REALME C85");
  assert.equal(detail.rma.status, "ENVIADO AO FORNECEDOR");
  assert.equal(detail.rma.nextAction, "COBRAR RETORNO");
  assert.deepEqual(detail.updates.map((update) => update.description), ["ENVIADO AO FORNECEDOR", "RMA CADASTRADO"]);
  assert.equal(detail.os.status, "AUTORIZADA");
  assert.deepEqual(detail.disposals, []);
  assert.equal((await call(route, LOJA_A, "GET", undefined, `?id=${avulso.id}`)).status, 404);
  assert.equal((await call(route, LOJA_B, "GET", undefined, `?id=${id}`)).status, 404);
  assert.equal((await (await call(route, LOJA_B, "GET")).json()).cases.length, 0);
  assert.equal((await call(route, LOJA_A, "PUT", { id, responsible: "X", description: "Y" })).status, 403);
  assert.equal((await call(cadastros, LOJA_A, "GET", undefined, "", "/cadastros")).status, 403);

  // Finalização com solução.
  assert.equal((await call(route, RMA, "PUT", { id, responsible: "THIERRY", description: "crédito recebido", newStatus: "FINALIZADO", solutionType: "CRÉDITO GERADO" })).status, 201);
  list = await (await call(route, RMA, "GET")).json();
  const done = list.cases.find((row) => row.id === id);
  assert.deepEqual([done.finalized, done.solutionType, done.finalizedByName, done.alerts.stale], [1, "CRÉDITO GERADO", "THIERRY", false]);
  // Editar o finalizado não muda o status.
  assert.equal((await call(route, RMA, "PATCH", { ...novo, id, status: "RECEBIDO", brand: "realme" })).status, 200);
  assert.equal((await (await call(route, RMA, "GET", undefined, `?id=${id}`)).json()).rma.status, "FINALIZADO");

  // Editar e excluir uma atualização.
  const updates = (await (await call(route, RMA, "GET", undefined, `?id=${id}`)).json()).updates;
  assert.equal((await call(route, RMA, "PATCH", { action: "edit_update", updateId: updates[0].id, description: "crédito recebido nf 204", responsible: "NAOMI" })).status, 200);
  assert.equal((await call(route, RMA, "PATCH", { action: "delete_update", updateId: updates[1].id })).status, 200);
  const after = (await (await call(route, RMA, "GET", undefined, `?id=${id}`)).json()).updates;
  assert.equal(after.length, updates.length - 1);
  assert.equal(after[0].description, "CRÉDITO RECEBIDO NF 204");

  // Crédito e descarte (rma:finance); o descarte entra na linha do tempo.
  assert.equal((await call(cadastros, RMA, "POST", { entity: "credit", supplier: "hoopson", creditValue: "1.479,72", usedValue: "2000" }, "", "/cadastros")).status, 400);
  assert.equal((await call(cadastros, RMA, "POST", { entity: "credit", supplier: "hoopson", creditValue: "1.479,72", status: "DISPONÍVEL" }, "", "/cadastros")).status, 201);
  assert.equal((await call(cadastros, RMA, "POST", { entity: "disposal", rmaId: avulso.id, quantity: 2, unitCost: "7,00", reason: "produto sem conserto", disposalDate: "2026-10-22" }, "", "/cadastros")).status, 201);
  const all = await (await call(cadastros, RMA, "GET", undefined, "", "/cadastros")).json();
  assert.equal(all.credits[0].creditCents, 147972);
  assert.deepEqual([all.disposals[0].totalCostCents, all.disposals[0].productName, all.disposals[0].reason], [1400, "CELULAR REALME C85", "PRODUTO SEM CONSERTO"]);
  const avulsoUpdates = (await (await call(route, RMA, "GET", undefined, `?id=${avulso.id}`)).json()).updates;
  assert.match(avulsoUpdates[0].description, /^DESCARTE REGISTRADO: 2 UN\./);

  // Exclusão: só rma:delete e login sem loja.
  assert.equal((await call(route, RMA, "DELETE", { id })).status, 403);
  assert.equal((await call(route, LOJA_A, "DELETE", { id })).status, 403);
  assert.equal((await call(route, { id: "adm", role: "admin", permissions: [] }, "DELETE", { id })).status, 200);
});

test("anexo importado: só copia da pasta pública do Base44; fora do escopo = 404", async () => {
  db.insert("rma_cases", { id: "legacy", code: "RMA-AAAAAA", store_id: B, store_name: "TACARUNA", status: "RECEBIDO", product_name: "X", deleted: 0 });
  db.insert("rma_attachments", { id: "f1", owner_type: "rma", owner_id: "legacy", rma_id: "legacy", file_name: "nf.pdf", r2_key: "", source_url: "https://evil.example/nf.pdf", deleted: 0 });
  const get = (actor) => callRoute(file.GET, actor, "GET", "/api/assistencia/rma/file?id=f1");
  assert.equal((await get(LOJA_A)).status, 404);
  // Endereço fora do Base44 não é buscado.
  assert.equal((await get(LOJA_B)).status, 404);
  // Cópia em lote: loja não pode; endereço fora do Base44 não é copiado e continua pendente.
  assert.equal((await callRoute(file.POST, LOJA_A, "POST", "/api/assistencia/rma/file", { action: "sync" })).status, 403);
  const sync = await (await callRoute(file.POST, RMA, "POST", "/api/assistencia/rma/file", { action: "sync" })).json();
  assert.deepEqual([sync.copied, sync.failed, sync.pending], [0, ["nf.pdf"], 1]);
});
