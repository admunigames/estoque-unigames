import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Assistência > Ordens de Serviço: criticidade da data limite, ordem da lista,
// atualização diária com histórico, permissões e loja só visualiza.

const db = await setupRouteDb(["shared_state", "assist_service_orders", "assist_service_order_updates"]);
const route = await import("../app/api/assistencia/ordens-servico/route.ts");
const { compareOrders, deadlineInfo, recifeDate } = await import("../app/lib/ordens-servico.ts");

const A = "clojaalfa1";
const B = "clojabeta1";
db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([{ id: A, name: "LOJA ALFA" }, { id: B, name: "LOJA BETA" }, { id: "cassist001", name: "ASSISTÊNCIA" }]),
});
const TECNICO = { id: "tec", permissions: ["ordens_servico:view", "ordens_servico:create", "ordens_servico:edit"] };
const LOJA_A = { id: "loja-a", companyId: A, permissions: ["ordens_servico:view", "ordens_servico:create", "ordens_servico:edit", "ordens_servico:delete"] };
const SO_VE = { id: "so-ve", permissions: ["ordens_servico:view"] };
const ADMIN = { id: "adm", role: "admin", permissions: [] };

const call = (actor, method, body, query = "") => callRoute(route[method], actor, method, `/api/assistencia/ordens-servico${query}`, body);
const shift = (days) => {
  const [y, m, d] = recifeDate().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const order = (osNumber, deadline, extra = {}) => ({
  osNumber, category: "CONSOLE", equipment: "ps5 slim", status: "AUTORIZADA", storeId: A, deadline, situation: "no prazo", ...extra,
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
  assert.equal((await call(TECNICO, "POST", order("1", shift(1), { storeId: "cassist001" }))).status, 400);
  assert.equal((await call(SO_VE, "POST", order("2", shift(1)))).status, 403);
  // Login de loja só visualiza, mesmo com todas as permissões.
  assert.equal((await call(LOJA_A, "POST", order("3", shift(1)))).status, 403);

  const data = await (await call(TECNICO, "GET")).json();
  assert.deepEqual(data.orders.map((row) => row.osNumber), ["23328", "23342", "23299", "23196"]);
  assert.deepEqual(data.orders.map((row) => row.deadlineLevel), ["atrasada", "hoje", "no_prazo", "sem_data"]);
  const first = data.orders.find((row) => row.osNumber === "23299");
  assert.equal(first.equipment, "PS5 SLIM");
  assert.equal(first.situation, "NO PRAZO");
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

  const patch = { ...order("23328", target.deadline), id: target.id, status: "FINALIZADA" };
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
