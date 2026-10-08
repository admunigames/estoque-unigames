import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Controle GD: gordura por venda, escopo por loja, permissões granulares e
// SALDO ANTERIOR automático/corrigido à mão.

const db = await setupRouteDb(["shared_state", "commercial_gd_balance_adjustments", "commercial_gd_opening_balances", "hr_employees"]);
const route = await import("../app/api/controle-gd/route.ts");

const A = "clojaalfa1";
const B = "clojabeta1";
db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([{ id: A, name: "LOJA ALFA" }, { id: B, name: "LOJA BETA" }]),
});
const CENTRAL = { id: "central", permissions: ["controle_gd:view", "controle_gd:create", "controle_gd:edit", "controle_gd:opening"] };
const LOJA_A = { id: "loja-a", companyId: A, permissions: ["controle_gd:view", "controle_gd:create"] };
const SO_VE = { id: "so-ve", permissions: ["controle_gd:view"] };

const call = (actor, method, body, query = "") => callRoute(route[method], actor, method, `/api/controle-gd${query}`, body);
const entry = (storeId, entryDate, amountCents, extra = {}) =>
  call(CENTRAL, "POST", { storeId, entryDate, saleCode: "330685", sellerName: "brenndha", amountCents, ...extra });

test("lança gordura com ID e vendedor; campos obrigatórios; sem permissão = 403", async () => {
  assert.equal((await entry(A, "2026-09-10", 10000)).status, 201); // fecha setembro em +100
  assert.equal((await entry(A, "2026-10-06", 1000)).status, 201);
  assert.equal((await entry(A, "2026-10-07", -500, { sellerName: "RENATO" })).status, 201);
  assert.equal((await entry(B, "2026-10-07", 700)).status, 201);
  assert.equal((await entry(A, "2026-10-07", 100, { saleCode: "" })).status, 400);
  assert.equal((await entry(A, "2026-10-07", 0)).status, 400);
  assert.equal((await call(SO_VE, "POST", { storeId: A, entryDate: "2026-10-07", saleCode: "1", sellerName: "X", amountCents: 100 })).status, 403);
  // Loja só lança na própria loja.
  assert.equal((await call(LOJA_A, "POST", { storeId: B, entryDate: "2026-10-07", saleCode: "1", sellerName: "X", amountCents: 100 })).status, 400);
});

test("saldo anterior automático entra no total; loja vê só a própria loja", async () => {
  const all = await (await call(CENTRAL, "GET", undefined, "?month=2026-10")).json();
  assert.equal(all.allStores, true);
  const alfa = all.stores.find((s) => s.storeId === A);
  assert.equal(alfa.openingCents, 10000);
  assert.equal(alfa.positiveCents, 1000);
  assert.equal(alfa.negativeCents, -500);
  assert.equal(alfa.balanceCents, 10500);
  assert.equal(all.entries.length, 3);
  assert.equal(all.entries.find((e) => e.amountCents === -500).sellerName, "RENATO");
  assert.equal(all.entries.find((e) => e.amountCents === 1000).sellerName, "BRENNDHA");

  const own = await (await call(LOJA_A, "GET", undefined, "?month=2026-10")).json();
  assert.equal(own.allStores, false);
  assert.deepEqual(own.stores.map((s) => s.storeId), [A]);
  assert.ok(own.entries.every((e) => e.storeId === A));
});

test("editar/excluir: permissão própria; total recalcula", async () => {
  const before = await (await call(CENTRAL, "GET", undefined, "?month=2026-10")).json();
  const target = before.entries.find((e) => e.amountCents === 1000);
  const patch = { id: target.id, entryDate: "2026-10-06", saleCode: "330685", sellerName: "BRENNDHA", amountCents: 2000, notes: "CORRIGIDO" };
  assert.equal((await call(LOJA_A, "PATCH", patch)).status, 403);
  assert.equal((await call(CENTRAL, "PATCH", patch)).status, 200);
  const negative = before.entries.find((e) => e.amountCents === -500);
  assert.equal((await call(CENTRAL, "DELETE", { id: negative.id })).status, 200);
  const after = await (await call(CENTRAL, "GET", undefined, "?month=2026-10")).json();
  assert.equal(after.stores.find((s) => s.storeId === A).balanceCents, 12000);
  assert.equal(after.entries.find((e) => e.id === target.id).notes, "CORRIGIDO");
});

test("saldo anterior corrigido à mão vale para o mês e segue nos seguintes; null volta ao automático", async () => {
  assert.equal((await call(LOJA_A, "PUT", { storeId: A, month: "2026-10", balanceCents: 5000 })).status, 403);
  assert.equal((await call(CENTRAL, "PUT", { storeId: A, month: "2026-10", balanceCents: -5000 })).status, 200);
  let data = await (await call(CENTRAL, "GET", undefined, "?month=2026-10")).json();
  let alfa = data.stores.find((s) => s.storeId === A);
  assert.equal(alfa.openingCents, -5000);
  assert.equal(alfa.openingManual, true);
  assert.equal(alfa.balanceCents, -3000);
  data = await (await call(CENTRAL, "GET", undefined, "?month=2026-11")).json();
  assert.equal(data.stores.find((s) => s.storeId === A).openingCents, -3000);
  assert.equal((await call(CENTRAL, "PUT", { storeId: A, month: "2026-10", balanceCents: null })).status, 200);
  data = await (await call(CENTRAL, "GET", undefined, "?month=2026-10")).json();
  alfa = data.stores.find((s) => s.storeId === A);
  assert.equal(alfa.openingCents, 10000);
  assert.equal(alfa.openingManual, false);
});
