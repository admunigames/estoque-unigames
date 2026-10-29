import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Assistência > Ordens de Serviço: criticidade da data limite, ordem da lista,
// atualização diária com histórico, permissões e loja só visualiza.

const db = await setupRouteDb(["shared_state", "assist_service_orders", "assist_service_order_updates", "assist_quotes", "assist_quote_items"]);
const route = await import("../app/api/assistencia/ordens-servico/route.ts");
const { approvalState, compareOrders, deadlineInfo, recifeDate } = await import("../app/lib/ordens-servico.ts");

const A = "clojaalfa1";
const B = "clojabeta1";
db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([{ id: A, name: "LOJA ALFA" }, { id: B, name: "LOJA BETA" }, { id: "cassist001", name: "ASSISTÊNCIA" }]),
});
const TECNICO = { id: "tec", permissions: ["ordens_servico:view", "ordens_servico:create", "ordens_servico:edit"] };
const LOJA_A = { id: "loja-a", companyId: A, permissions: ["ordens_servico:view", "ordens_servico:create", "ordens_servico:edit", "ordens_servico:delete"] };
const SO_VE = { id: "so-ve", permissions: ["ordens_servico:view"] };
const LOJA_A_TESTE = { id: "loja-a-teste", name: "GERENTE ALFA", companyId: A, permissions: ["ordens_servico:view", "ordens_servico:store_test"] };
const LOJA_B_TESTE = { id: "loja-b-teste", companyId: B, permissions: ["ordens_servico:view", "ordens_servico:store_test"] };
const ADMIN = { id: "adm", role: "admin", permissions: [] };

const call = (actor, method, body, query = "") => callRoute(route[method], actor, method, `/api/assistencia/ordens-servico${query}`, body);
const shift = (days) => {
  const [y, m, d] = recifeDate().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const order = (osNumber, deadline, extra = {}) => ({
  osNumber, category: "CONSOLE", equipment: "ps5 slim", status: "AUTORIZADA", storeId: A, deadline, situation: "garantia de serviço", ...extra,
});

test("deadlineInfo e compareOrders", () => {
  assert.deepEqual(deadlineInfo("2026-10-10", "2026-10-14"), { days: -4, level: "atrasada" });
  assert.equal(deadlineInfo("2026-10-14", "2026-10-14").level, "hoje");
  assert.equal(deadlineInfo("2026-10-16", "2026-10-14").level, "proxima");
  assert.equal(deadlineInfo("2026-10-20", "2026-10-14").level, "no_prazo");
  assert.equal(deadlineInfo("", "2026-10-14").level, "sem_data");
  const sorted = [
    { osNumber: "5", deadline: "", closed: 0 },
    { osNumber: "4", deadline: "2026-10-20", closed: 0 },
    { osNumber: "3", deadline: "2026-10-01", closed: 1, closedAt: "x" },
    { osNumber: "2", deadline: "2026-10-09", closed: 0 },
    { osNumber: "10", deadline: "2026-10-09", closed: 0 },
  ].sort(compareOrders).map((row) => row.osNumber);
  assert.deepEqual(sorted, ["2", "10", "4", "5", "3"]);
});

test("cadastra, valida, recusa duplicada e ordena pela data limite mais crítica", async () => {
  assert.equal((await call(TECNICO, "POST", order("23299", shift(5), { updateText: "PRODUÇÃO PEDRO" }))).status, 201);
  assert.equal((await call(TECNICO, "POST", order("23328", shift(-3)))).status, 201);
  assert.equal((await call(TECNICO, "POST", order("23196", "", { storeId: B, category: "CELULAR" }))).status, 201);
  assert.equal((await call(TECNICO, "POST", order("23342", shift(0)))).status, 201);
  assert.equal((await call(TECNICO, "POST", order("23299", shift(1)))).status, 409);
  assert.equal((await call(TECNICO, "POST", order("", shift(1)))).status, 400);
  assert.equal((await call(TECNICO, "POST", order("1", shift(1), { category: "OUTRO" }))).status, 400);
  // Garantia/venda saíram do STATUS (viraram observação); entraram SETOR QUALIDADE e PREVENTIVA.
  assert.equal((await call(TECNICO, "POST", order("1", shift(1), { status: "GARANTIA DE VENDA" }))).status, 400);
  assert.equal((await call(TECNICO, "POST", order("1", shift(1), { storeId: "cassist001" }))).status, 400);
  assert.equal((await call(SO_VE, "POST", order("2", shift(1)))).status, 403);
  // Login de loja só visualiza, mesmo com todas as permissões.
  assert.equal((await call(LOJA_A, "POST", order("3", shift(1)))).status, 403);

  const data = await (await call(TECNICO, "GET")).json();
  assert.deepEqual(data.orders.map((row) => row.osNumber), ["23328", "23342", "23299", "23196"]);
  assert.deepEqual(data.orders.map((row) => row.deadlineLevel), ["atrasada", "hoje", "no_prazo", "sem_data"]);
  const first = data.orders.find((row) => row.osNumber === "23299");
  assert.equal(first.equipment, "PS5 SLIM");
  assert.equal(first.situation, "GARANTIA DE SERVIÇO");
  assert.equal(first.lastUpdateText, "PRODUÇÃO PEDRO");
  assert.equal(first.updatedToday, true);
  assert.equal(data.orders.find((row) => row.osNumber === "23328").updatedToday, false);
  assert.deepEqual(data.companies.map((company) => company.id), [A, B]);
});

test("loja vê só as próprias O.S. e não atualiza nem exclui", async () => {
  const own = await (await call(LOJA_A, "GET")).json();
  assert.equal(own.allStores, false);
  assert.ok(own.orders.length && own.orders.every((row) => row.storeId === A));
  const target = own.orders[0];
  assert.equal((await call(LOJA_A, "PUT", { id: target.id, text: "X" })).status, 403);
  assert.equal((await call(LOJA_A, "DELETE", { id: target.id })).status, 403);
  const updates = await (await call(LOJA_A, "GET", undefined, `?updates=${target.id}`)).json();
  assert.ok(Array.isArray(updates.updates));
  const other = (await (await call(TECNICO, "GET")).json()).orders.find((row) => row.storeId === B);
  assert.equal((await call(LOJA_A, "GET", undefined, `?updates=${other.id}`)).status, 404);
});

test("atualização diária guarda histórico; FINALIZADA sai das abertas; excluir exige permissão", async () => {
  const data = await (await call(TECNICO, "GET")).json();
  const target = data.orders.find((row) => row.osNumber === "23328");
  assert.equal((await call(TECNICO, "PUT", { id: target.id, text: "" })).status, 400);
  assert.equal((await call(TECNICO, "PUT", { id: target.id, text: "AGUARDANDO PEÇA" })).status, 200);
  assert.equal((await call(TECNICO, "PUT", { id: target.id, text: "PEÇA CHEGOU" })).status, 200);
  const history = await (await call(TECNICO, "GET", undefined, `?updates=${target.id}`)).json();
  assert.deepEqual(history.updates.map((item) => item.text).sort(), ["AGUARDANDO PEÇA", "PEÇA CHEGOU"]);
  let after = await (await call(TECNICO, "GET")).json();
  const updated = after.orders.find((row) => row.id === target.id);
  assert.equal(updated.updatedToday, true);
  assert.ok(["AGUARDANDO PEÇA", "PEÇA CHEGOU"].includes(updated.lastUpdateText));

  const patch = { ...order("23328", target.deadline), id: target.id, status: "APROVADA", shipToStore: "nao" };
  assert.equal((await call(TECNICO, "PATCH", { ...patch, shipToStore: "" })).status, 400);
  assert.equal((await call(SO_VE, "PATCH", patch)).status, 403);
  assert.equal((await call(TECNICO, "PATCH", patch)).status, 200);
  after = await (await call(TECNICO, "GET")).json();
  assert.ok(!after.orders.some((row) => row.id === target.id));
  const closed = await (await call(TECNICO, "GET", undefined, "?closed=1")).json();
  assert.equal(closed.orders[0].id, target.id);
  assert.equal(closed.orders[0].deadlineLevel, "finalizada");
  // Finalizada libera o número para uma nova O.S.
  assert.equal((await call(TECNICO, "POST", order("23328", shift(2)))).status, 201);

  const victim = after.orders[0];
  assert.equal((await call(TECNICO, "DELETE", { id: victim.id })).status, 403);
  assert.equal((await call(ADMIN, "DELETE", { id: victim.id })).status, 200);
  const final = await (await call(TECNICO, "GET")).json();
  assert.ok(!final.orders.some((row) => row.id === victim.id));
});

test("approvalState: APROVADA finaliza ou espera a loja; voltar para a assistência desfaz o pendente", () => {
  assert.deepEqual(approvalState("APROVADA", "nao", ""), { closed: 1, storeCheck: "" });
  assert.deepEqual(approvalState("SEM SOLUÇÃO", "", "pendente"), { closed: 1, storeCheck: "" });
  assert.deepEqual(approvalState("APROVADA", "sim", ""), { closed: 0, storeCheck: "pendente" });
  assert.deepEqual(approvalState("APROVADA", "sim", "aprovada"), { closed: 1, storeCheck: "aprovada" });
  assert.deepEqual(approvalState("AUTORIZADA", "", "pendente"), { closed: 0, storeCheck: "" });
  assert.deepEqual(approvalState("AUTORIZADA", "", "reprovada"), { closed: 0, storeCheck: "reprovada" });
});

test("segue para a loja: loja testa; reprovado em loja volta para a assistência com quem e quando", async () => {
  assert.equal((await call(TECNICO, "POST", order("30001", shift(3), { status: "SETOR QUALIDADE" }))).status, 201);
  assert.equal((await call(TECNICO, "POST", order("40001", shift(1), { status: "NÃO AUTORIZADO" }))).status, 201);
  assert.equal((await call(TECNICO, "POST", order("40002", shift(1), { status: "SEM SOLUÇÃO" }))).status, 201);
  // Sem conserto: finaliza na hora e segue para a loja só para devolver ao cliente.
  const returned = (await (await call(TECNICO, "GET", undefined, "?closed=1")).json()).orders.filter((row) => ["40001", "40002"].includes(row.osNumber));
  assert.equal(returned.length, 2);
  assert.ok(returned.every((row) => row.closed === 1 && row.shipToStore === "sim" && row.storeCheck === "" && row.shipByName === "TEC"));
  let data = await (await call(TECNICO, "GET")).json();
  const os = data.orders.find((row) => row.osNumber === "30001");
  const approve = { ...order("30001", os.deadline), id: os.id, status: "APROVADA", shipToStore: "sim" };
  // Ainda não seguiu para a loja: teste recusado.
  assert.equal((await call(LOJA_A_TESTE, "PATCH", { id: os.id, action: "store_test", result: "aprovada" })).status, 409);
  assert.equal((await call(TECNICO, "PATCH", approve)).status, 200);
  data = await (await call(TECNICO, "GET")).json();
  let row = data.orders.find((item) => item.id === os.id);
  assert.equal(row.closed, 0);
  assert.equal(row.storeCheck, "pendente");
  assert.equal(row.shipToStore, "sim");
  assert.equal(row.shipByName, "TEC");
  assert.ok(row.shipAt);
  // Sem permissão de teste / outra loja / login de loja sem store_test.
  assert.equal((await call(SO_VE, "PATCH", { id: os.id, action: "store_test", result: "aprovada" })).status, 403);
  assert.equal((await call(LOJA_B_TESTE, "PATCH", { id: os.id, action: "store_test", result: "aprovada" })).status, 404);
  assert.equal((await call(LOJA_A, "PATCH", { id: os.id, action: "store_test", result: "aprovada" })).status, 403);
  // Reprovar exige motivo.
  assert.equal((await call(LOJA_A_TESTE, "PATCH", { id: os.id, action: "store_test", result: "reprovada" })).status, 400);
  assert.equal((await call(LOJA_A_TESTE, "PATCH", { id: os.id, action: "store_test", result: "reprovada", note: "não liga" })).status, 200);
  data = await (await call(TECNICO, "GET")).json();
  row = data.orders.find((item) => item.id === os.id);
  assert.equal(row.status, "REPROVADO EM LOJA");
  assert.equal(row.closed, 0);
  assert.equal(row.storeCheck, "reprovada");
  assert.equal(row.storeCheckByName, "GERENTE ALFA");
  assert.equal(row.storeCheckNote, "NÃO LIGA");
  assert.match(row.lastUpdateText, /^REPROVADO EM LOJA POR GERENTE ALFA EM \d{2}\/\d{2}\/\d{4} - NÃO LIGA$/);
  // Assistência conserta e manda de novo; a loja aprova → finaliza.
  assert.equal((await call(TECNICO, "PATCH", approve)).status, 200);
  assert.equal((await call(LOJA_A_TESTE, "PATCH", { id: os.id, action: "store_test", result: "aprovada" })).status, 200);
  data = await (await call(TECNICO, "GET")).json();
  assert.ok(!data.orders.some((item) => item.id === os.id));
  const closed = await (await call(TECNICO, "GET", undefined, "?closed=1")).json();
  row = closed.orders.find((item) => item.id === os.id);
  assert.equal(row.storeCheck, "aprovada");
  const history = await (await call(TECNICO, "GET", undefined, `?updates=${os.id}`)).json();
  const texts = history.updates.map((item) => item.text);
  assert.ok(texts.includes("STATUS: APROVADA · SEGUE PARA A LOJA"));
  assert.ok(texts.some((text) => text.startsWith("APROVADA NA LOJA POR GERENTE ALFA")));
});

test("ligação com Orçamentos: status novos, valor e PDF do orçamento na O.S. (loja da O.S. também abre)", async () => {
  const { OS_STATUSES } = await import("../app/lib/ordens-servico.ts");
  assert.ok(OS_STATUSES.includes("ORÇAMENTO PRONTO") && OS_STATUSES.includes("AGUARDANDO PEÇA"));
  assert.equal((await call(TECNICO, "POST", order("ORC-1", shift(4), { status: "AGUARDANDO PEÇA" }))).status, 201);
  assert.equal((await call(TECNICO, "POST", order("ORC-2", shift(4), { status: "ORÇAMENTO PENDENTE" }))).status, 201);
  db.insert("assist_quotes", {
    id: "q-orc-1", os_number: "ORC-1", company_id: A, company_name: "LOJA ALFA", entry_date: "2026-10-29",
    client_name: "CLIENTE", total_cents: 15000, created_at: "2026-10-29T10:00:00Z", updated_at: "2026-10-29T10:00:00Z",
  });
  db.insert("assist_quote_items", { id: "qi-1", quote_id: "q-orc-1", device: "PS5 SLIM", defect_name: "HDMI", defect_note: "SEM IMAGEM", quantity: 1, unit_cents: 15000 });

  const data = await (await call(TECNICO, "GET")).json();
  const withQuote = data.orders.find((row) => row.osNumber === "ORC-1");
  assert.equal(withQuote.quoteId, "q-orc-1");
  assert.equal(withQuote.quoteTotalCents, 15000);
  assert.equal(data.orders.find((row) => row.osNumber === "ORC-2").quoteId, "");

  // A loja da O.S. abre o PDF; outra loja não.
  const detail = await (await call(LOJA_A, "GET", undefined, `?quote=${withQuote.id}`)).json();
  assert.equal(detail.quote.osNumber, "ORC-1");
  assert.equal(detail.equipments[0].lines[0].defectNote, "SEM IMAGEM");
  assert.equal((await call(LOJA_B_TESTE, "GET", undefined, `?quote=${withQuote.id}`)).status, 404);
  const other = data.orders.find((row) => row.osNumber === "ORC-2");
  assert.equal((await call(TECNICO, "GET", undefined, `?quote=${other.id}`)).status, 404);
  // 23612.01 / 23612.02: o orçamento do nº base vale para os dois produtos.
  assert.equal((await call(TECNICO, "POST", order("88612.01", shift(4)))).status, 201);
  assert.equal((await call(TECNICO, "POST", order("88612.02", shift(4)))).status, 201);
  db.insert("assist_quotes", {
    id: "q-base", os_number: "88612", company_id: A, company_name: "LOJA ALFA", entry_date: "2026-10-29",
    client_name: "CLIENTE", total_cents: 30000, created_at: "2026-10-29T10:00:00Z", updated_at: "2026-10-29T10:00:00Z",
  });
  const rows = (await (await call(TECNICO, "GET")).json()).orders.filter((row) => row.osNumber.startsWith("88612"));
  assert.deepEqual(rows.map((row) => [row.osNumber, row.quoteId, row.quoteTotalCents]).sort(),
    [["88612.01", "q-base", 30000], ["88612.02", "q-base", 30000]]);
  assert.equal((await (await call(LOJA_A, "GET", undefined, `?quote=${rows[1].id}`)).json()).quote.osNumber, "88612");
});
