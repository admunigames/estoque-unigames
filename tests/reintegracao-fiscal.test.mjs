import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Estoque > Reintegração Fiscal: anota cancelamentos e fecha um a um com
// data + nº da nota de reintegração. Interno: login com loja não vê.

const db = await setupRouteDb(["shared_state", "fiscal_reintegrations"]);
const route = await import("../app/api/reintegracao-fiscal/route.ts");

const A = "clojaalfa1";
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: A, name: "Guararapes" }]) });

const FISCAL = { id: "fiscal", name: "ANA FISCAL", permissions: ["reintegracao_fiscal:view", "reintegracao_fiscal:create", "reintegracao_fiscal:emit"] };
const LEITOR = { id: "leitor", name: "LEITOR", permissions: ["reintegracao_fiscal:view"] };
const LOJA = { id: "loja", name: "LOJA", companyId: A, permissions: ["reintegracao_fiscal:view", "reintegracao_fiscal:create", "reintegracao_fiscal:emit"] };
const call = (actor, method, body) => callRoute(route[method], actor, method, "/api/reintegracao-fiscal", body);

test("lança, emite um a um, reabre; loja não vê", async () => {
  assert.equal((await call(LOJA, "GET")).status, 403);
  assert.equal((await call(LOJA, "POST", { companyId: A, saleId: "1", requestedDate: "2026-11-01" })).status, 403);
  assert.equal((await call(LEITOR, "POST", { companyId: A, saleId: "1", requestedDate: "2026-11-01" })).status, 403);
  assert.equal((await call(FISCAL, "POST", { companyId: A, requestedDate: "2026-11-01" })).status, 400);
  assert.equal((await call(FISCAL, "POST", { companyId: A, saleId: "1", requestedDate: "2099-01-01" })).status, 400);
  assert.equal((await call(FISCAL, "POST", { companyId: "cxxxxxx9", saleId: "1", requestedDate: "2026-11-01" })).status, 400);

  const created = await call(FISCAL, "POST", { companyId: A, saleId: "v-123", invoiceNumber: "", requestedDate: "2026-11-01", requestedBy: "joão" });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  await call(FISCAL, "POST", { companyId: A, invoiceNumber: "4455", requestedDate: "2026-11-02" });

  let list = await (await call(LEITOR, "GET")).json();
  assert.equal(list.items.length, 2);
  const item = list.items.find((row) => row.id === id);
  assert.equal(item.saleId, "V-123");
  assert.equal(item.requestedBy, "JOÃO");
  assert.equal(item.companyName, "GUARARAPES");
  assert.equal(item.status, "aberto");
  assert.equal(list.can.emit, false);

  assert.equal((await call(LEITOR, "PATCH", { id, action: "emit", reintegrationDate: "2026-11-03", reintegrationNumber: "9" })).status, 403);
  assert.equal((await call(FISCAL, "PATCH", { id, action: "emit", reintegrationDate: "2026-10-31", reintegrationNumber: "9" })).status, 400);
  assert.equal((await call(FISCAL, "PATCH", { id, action: "emit", reintegrationDate: "2026-11-03", reintegrationNumber: "" })).status, 400);
  assert.equal((await call(FISCAL, "PATCH", { id, action: "emit", reintegrationDate: "2026-11-03", reintegrationNumber: "nf 9001" })).status, 200);
  assert.equal((await call(FISCAL, "PATCH", { id, action: "emit", reintegrationDate: "2026-11-03", reintegrationNumber: "x" })).status, 409);

  list = await (await call(FISCAL, "GET")).json();
  const emitted = list.items.find((row) => row.id === id);
  assert.equal(emitted.status, "emitido");
  assert.equal(emitted.reintegrationNumber, "NF 9001");
  assert.equal(emitted.closedByName, "ANA FISCAL");

  assert.equal((await call(FISCAL, "PATCH", { id, action: "reopen" })).status, 200);
  assert.equal((await call(FISCAL, "PATCH", { id, action: "x" })).status, 400);
  assert.equal((await call(FISCAL, "DELETE", { id })).status, 403);
  assert.equal((await call({ ...FISCAL, permissions: ["reintegracao_fiscal:delete"] }, "DELETE", { id })).status, 200);
  list = await (await call(FISCAL, "GET")).json();
  assert.equal(list.items.length, 1);
});
