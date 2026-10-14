import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Assistência > Consulta de Preços: loja consulta; só a assistência (login
// sem loja) cadastra, altera e exclui, cada ação com a própria permissão.

await setupRouteDb(["assist_repair_prices"]);
const route = await import("../app/api/assistencia/precos/route.ts");

const ASSIST = { id: "assist", name: "TÉCNICO", permissions: ["precos_assistencia:view", "precos_assistencia:create", "precos_assistencia:edit"] };
const LOJA = { id: "loja", companyId: "clojaalfa1", permissions: ["precos_assistencia:view", "precos_assistencia:create", "precos_assistencia:edit", "precos_assistencia:delete"] };
const SEM = { id: "sem", permissions: [] };
const ADMIN = { id: "adm", role: "admin", permissions: [] };
const call = (actor, method, body) => callRoute(route[method], actor, method, "/api/assistencia/precos", body);
const price = (extra = {}) => ({ service: "BATERIA", brand: "samsung", model: "a15 5g", priceCents: 17999, ...extra });

test("assistência cadastra/edita; loja só consulta; validações", async () => {
  assert.equal((await call(ASSIST, "POST", price())).status, 201);
  assert.equal((await call(ASSIST, "POST", price({ model: "s24 ultra", priceCents: null }))).status, 201);
  assert.equal((await call(ASSIST, "POST", price({ service: "OUTRO" }))).status, 400);
  assert.equal((await call(ASSIST, "POST", price({ model: "" }))).status, 400);
  assert.equal((await call(ASSIST, "POST", price({ priceCents: -5 }))).status, 400);
  assert.equal((await call(LOJA, "POST", price())).status, 403);
  assert.equal((await call(SEM, "GET")).status, 403);

  const data = await (await call(LOJA, "GET")).json();
  assert.equal(data.prices.length, 2);
  const a15 = data.prices.find((row) => row.model === "A15 5G");
  assert.equal(a15.brand, "SAMSUNG");
  assert.equal(a15.priceCents, 17999);
  assert.equal(data.prices.find((row) => row.model === "S24 ULTRA").priceCents, null);

  assert.equal((await call(LOJA, "PATCH", { ...price({ priceCents: 1 }), id: a15.id })).status, 403);
  assert.equal((await call(ASSIST, "PATCH", { ...price({ priceCents: 18999 }), id: a15.id })).status, 200);
  const after = await (await call(ASSIST, "GET")).json();
  const edited = after.prices.find((row) => row.id === a15.id);
  assert.equal(edited.priceCents, 18999);
  assert.equal(edited.updatedByName, "TÉCNICO");

  assert.equal((await call(ASSIST, "DELETE", { id: a15.id })).status, 403);
  assert.equal((await call(LOJA, "DELETE", { id: a15.id })).status, 403);
  assert.equal((await call(ADMIN, "DELETE", { id: a15.id })).status, 200);
  assert.equal((await (await call(ASSIST, "GET")).json()).prices.length, 1);
});
