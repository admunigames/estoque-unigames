import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Assistência > Estoque: só a assistência (login sem loja); entrada e baixa
// com permissões próprias; baixa nunca deixa o saldo negativo; histórico.

await setupRouteDb(["assist_stock_items", "assist_stock_movements"]);
const route = await import("../app/api/assistencia/estoque/route.ts");

const GESTOR = { id: "g", name: "GESTOR", permissions: ["estoque_assistencia:view", "estoque_assistencia:manage", "estoque_assistencia:entrada", "estoque_assistencia:baixa"] };
const TECNICO = { id: "t", name: "TÉCNICO", permissions: ["estoque_assistencia:view", "estoque_assistencia:baixa"] };
const LOJA = { id: "l", companyId: "clojaalfa1", permissions: ["estoque_assistencia:view", "estoque_assistencia:entrada", "estoque_assistencia:baixa", "estoque_assistencia:manage"] };
const call = (actor, method, body, query = "") => callRoute(route[method], actor, method, `/api/assistencia/estoque${query}`, body);

test("cadastra com saldo inicial; loja não acessa; entrada/baixa com permissão e sem saldo negativo", async () => {
  assert.equal((await call(GESTOR, "POST", { category: "PLACA MÃE", name: "placa mãe h81", quantity: 53, salePriceCents: 27999 })).status, 201);
  assert.equal((await call(GESTOR, "POST", { category: "OUTRA", name: "x" })).status, 400);
  assert.equal((await call(TECNICO, "POST", { category: "SSD", name: "ssd 240gb", quantity: 1 })).status, 403);
  assert.equal((await call(LOJA, "GET")).status, 403);
  assert.equal((await call(LOJA, "POST", { category: "SSD", name: "ssd", quantity: 1 })).status, 403);

  const { items } = await (await call(TECNICO, "GET")).json();
  const h81 = items.find((item) => item.name === "PLACA MÃE H81");
  assert.equal(h81.quantity, 53);
  assert.equal(h81.salePriceCents, 27999);

  assert.equal((await call(TECNICO, "PUT", { id: h81.id, kind: "entrada", quantity: 5 })).status, 403);
  assert.equal((await call(TECNICO, "PUT", { id: h81.id, kind: "baixa", quantity: 0 })).status, 400);
  const out = await call(TECNICO, "PUT", { id: h81.id, kind: "baixa", quantity: 3, osNumber: "23299", note: "montagem" });
  assert.equal(out.status, 200);
  assert.equal((await out.json()).quantity, 50);
  assert.equal((await call(TECNICO, "PUT", { id: h81.id, kind: "baixa", quantity: 51 })).status, 409);
  assert.equal((await (await call(GESTOR, "PUT", { id: h81.id, kind: "entrada", quantity: 10 })).json()).quantity, 60);
  assert.equal((await call(LOJA, "PUT", { id: h81.id, kind: "baixa", quantity: 1 })).status, 403);

  const { movements } = await (await call(GESTOR, "GET", undefined, `?movements=${h81.id}`)).json();
  assert.equal(movements.length, 3);
  const baixa = movements.find((move) => move.kind === "baixa");
  assert.equal(baixa.balanceAfter, 50);
  assert.equal(baixa.osNumber, "23299");
  assert.equal(baixa.note, "MONTAGEM");
  assert.equal(baixa.createdByName, "TÉCNICO");
  assert.ok(movements.some((move) => move.note === "SALDO INICIAL" && move.quantity === 53));

  assert.equal((await call(GESTOR, "PATCH", { id: h81.id, category: "PLACA MÃE", name: "PLACA MÃE H81 M-ATX", salePriceCents: null })).status, 200);
  assert.equal((await call(GESTOR, "DELETE", { id: h81.id })).status, 403);
  assert.equal((await call({ id: "a", role: "admin", permissions: [] }, "DELETE", { id: h81.id })).status, 200);
  assert.equal((await (await call(GESTOR, "GET")).json()).items.length, 0);
});
