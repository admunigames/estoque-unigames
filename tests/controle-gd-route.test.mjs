import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Controle GD: gordura por venda, escopo por loja, permissões granulares e
// SALDO ANTERIOR automático/corrigido à mão.

const db = await setupRouteDb(["shared_state", "commercial_gd_balance_adjustments", "commercial_gd_opening_balances", "commercial_gd_store_info", "hr_employees"]);
const route = await import("../app/api/controle-gd/route.ts");

const A = "clojaalfa1";
const B = "clojabeta1";
db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([{ id: A, name: "LOJA ALFA" }, { id: B, name: "LOJA BETA" }]),
});
const CENTRAL = { id: "central", permissions: ["controle_gd:view", "controle_gd:create", "controle_gd:edit", "controle_gd:opening"] };
// Loja com TODAS as permissões: mesmo assim só visualiza.
const LOJA_A = { id: "loja-a", companyId: A, permissions: ["controle_gd:view", "controle_gd:create", "controle_gd:edit", "controle_gd:opening"] };
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
  // Vendedor não é obrigatório.
  assert.equal((await entry(B, "2026-10-07", 100, { sellerName: "" })).status, 201);
  assert.equal((await entry(A, "2026-10-07", 0)).status, 400);
  assert.equal((await call(SO_VE, "POST", { storeId: A, entryDate: "2026-10-07", saleCode: "1", sellerName: "X", amountCents: 100 })).status, 403);
  // Login de loja só visualiza: não lança nem na própria loja.
  for (const storeId of [A, B]) {
    assert.equal((await call(LOJA_A, "POST", { storeId, entryDate: "2026-10-07", saleCode: "1", sellerName: "X", amountCents: 100 })).status, 403);
  }
});

test("saldo anterior automático entra no total; loja vê só a própria loja", async () => {
  const all = await (await call(CENTRAL, "GET", undefined, "?month=2026-10")).json();
  assert.equal(all.allStores, true);
  const alfa = all.stores.find((s) => s.storeId === A);
  assert.equal(alfa.openingCents, 10000);
  assert.equal(alfa.positiveCents, 1000);
  assert.equal(alfa.negativeCents, -500);
  assert.equal(alfa.balanceCents, 10500);
  assert.equal(all.entries.length, 4);
  assert.equal(all.entries.filter((e) => !e.sellerName).length, 1);
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

test("Assistência: clone com dados e permissões próprios (não mistura com o Comercial)", async () => {
  const assist = await import("../app/api/gorduras-assistencia/route.ts");
  const ASSIST = { id: "assist", permissions: ["gorduras_assistencia:view", "gorduras_assistencia:create", "gorduras_assistencia:opening"] };
  const callA = (actor, method, body, query = "") => callRoute(assist[method], actor, method, `/api/gorduras-assistencia${query}`, body);
  // Permissão do Comercial não abre a Assistência, e vice-versa.
  assert.equal((await callA(CENTRAL, "GET", undefined, "?month=2026-10")).status, 403);
  assert.equal((await call(ASSIST, "GET", undefined, "?month=2026-10")).status, 403);
  assert.equal((await callA(ASSIST, "POST", { storeId: A, entryDate: "2026-10-08", saleCode: "OS-1", sellerName: "tecnico", amountCents: -300 })).status, 201);
  assert.equal((await callA(ASSIST, "PUT", { storeId: A, month: "2026-10", balanceCents: 700 })).status, 200);
  const a = await (await callA(ASSIST, "GET", undefined, "?month=2026-10")).json();
  const alfa = a.stores.find((s) => s.storeId === A);
  assert.deepEqual([alfa.openingCents, alfa.negativeCents, alfa.balanceCents], [700, -300, 400]);
  assert.equal(a.entries.length, 1);
  // Comercial segue intacto (mesmos números do teste anterior).
  const c = await (await call(CENTRAL, "GET", undefined, "?month=2026-10")).json();
  assert.equal(c.stores.find((s) => s.storeId === A).openingCents, 10000);
  assert.ok(c.entries.every((e) => e.saleCode !== "OS-1"));
  // Gordura do Comercial não é editável pela rota da Assistência.
  const comercialId = c.entries[0].id;
  const ASSIST_EDIT = { id: "ae", permissions: ["gorduras_assistencia:edit"] };
  assert.equal((await callA(ASSIST_EDIT, "DELETE", { id: comercialId })).status, 404);
});

test("isSellingStore: Assistência e Depósito ficam fora do Controle de Gorduras", async () => {
  const { isSellingStore } = await import("../app/lib/selling-stores.ts");
  for (const name of ["ASSISTÊNCIA", "Assistencia", "DEPÓSITO", "deposito central", "CD"]) assert.equal(isSellingStore(name), false, name);
  for (const name of ["RIOMAR", "P.A LOJA", "QUIOSQUE P.A", "NORTH WAY", "CDU SHOPPING"]) assert.equal(isSellingStore(name), true, name);
});

test("Assistência/Depósito não aparecem nem recebem gordura", async () => {
  db.sqlite.prepare("UPDATE shared_state SET value_json=? WHERE state_key='companies_list'").run(JSON.stringify([
    { id: A, name: "LOJA ALFA" }, { id: B, name: "LOJA BETA" }, { id: "cassist001", name: "ASSISTÊNCIA" }, { id: "cdeposi001", name: "DEPÓSITO" },
  ]));
  const data = await (await call(CENTRAL, "GET", undefined, "?month=2026-10")).json();
  assert.deepEqual(data.stores.map((s) => s.storeId), [A, B]);
  assert.equal((await entry("cassist001", "2026-10-08", 100)).status, 400);
});

test("GORDURA ATUALIZADA ATÉ: quem lança informa a data; loja só vê; data vazia volta ao padrão", async () => {
  assert.equal((await call(LOJA_A, "PUT", { storeId: A, updatedUntil: "2026-10-14" })).status, 403);
  assert.equal((await call(SO_VE, "PUT", { storeId: A, updatedUntil: "2026-10-14" })).status, 403);
  assert.equal((await call(CENTRAL, "PUT", { storeId: A, updatedUntil: "14/10/2026" })).status, 400);
  assert.equal((await call(CENTRAL, "PUT", { storeId: A, updatedUntil: "2026-10-14" })).status, 200);
  let data = await (await call(LOJA_A, "GET", undefined, "?month=2026-10")).json();
  assert.equal(data.stores[0].updatedUntil, "2026-10-14");
  assert.equal(data.stores[0].updatedUntilBy, "CENTRAL");
  assert.equal((await call(CENTRAL, "PUT", { storeId: A, updatedUntil: "" })).status, 200);
  data = await (await call(CENTRAL, "GET", undefined, "?month=2026-10")).json();
  assert.equal(data.stores.find((s) => s.storeId === A).updatedUntil, "");
});

test("PDF HISTÓRICO (?view=history): todos os meses da loja, escopo e module; saldo final = saldo do card", async () => {
  assert.equal((await entry(A, "2026-08-15", 300, { saleCode: "AGO-1" })).status, 201);
  assert.equal((await call(CENTRAL, "PUT", { storeId: A, month: "2026-09", balanceCents: 1000 })).status, 200);
  try {
    const history = async (actor, query) => call(actor, "GET", undefined, `?view=history&storeId=${A}${query || ""}`);
    const all = await (await history(CENTRAL)).json();
    // Padrão: da primeira gordura da loja até hoje.
    assert.equal(all.from, "2026-08-15");
    assert.equal(all.to, all.today);
    assert.equal(all.openingCents, 0);
    assert.deepEqual(all.months.map((m) => m.month).slice(0, 3), ["2026-08", "2026-09", "2026-10"]);
    const [aug, sep, oct] = all.months;
    assert.deepEqual([aug.openingCents, aug.closingCents], [0, 300]);
    // Setembro com SALDO ANTERIOR corrigido à mão (1000), não o fechamento de agosto.
    assert.deepEqual([sep.openingCents, sep.openingManual, sep.closingCents], [1000, true, 11000]);
    assert.equal(oct.openingCents, 11000);
    assert.ok(oct.entries.every((row, index, rows) => index === 0 || rows[index - 1].entryDate <= row.entryDate), "na ordem da data");
    // Saldo final = saldo do card do mês atual.
    const dashboard = await (await call(CENTRAL, "GET", undefined, `?month=${all.today.slice(0, 7)}`)).json();
    assert.equal(all.balanceCents, dashboard.stores.find((s) => s.storeId === A).balanceCents);
    assert.equal(all.positiveCents + all.negativeCents, all.months.reduce((sum, m) => sum + m.movementCents, 0));

    // Período DE/ATÉ: só outubro, com o saldo anterior = abertura de outubro.
    const october = await (await history(CENTRAL, "&from=2026-10-01&to=2026-10-31")).json();
    const dashOct = await (await call(CENTRAL, "GET", undefined, "?month=2026-10")).json();
    const alfaOct = dashOct.stores.find((s) => s.storeId === A);
    assert.deepEqual(october.months.map((m) => m.month), ["2026-10"]);
    assert.equal(october.openingCents, alfaOct.openingCents);
    assert.equal(october.balanceCents, alfaOct.balanceCents);
    assert.equal((await history(CENTRAL, "&from=2026-10-31&to=2026-10-01")).status, 400);

    // Login de loja: só a própria loja.
    assert.equal((await history(LOJA_A)).status, 200);
    assert.equal((await call(LOJA_A, "GET", undefined, `?view=history&storeId=${B}`)).status, 400);

    // Module: a Assistência só traz as gorduras da Assistência.
    const assist = await import("../app/api/gorduras-assistencia/route.ts");
    const ASSIST = { id: "assist", permissions: ["gorduras_assistencia:view"] };
    const fromAssist = await (await callRoute(assist.GET, ASSIST, "GET", `/api/gorduras-assistencia?view=history&storeId=${A}`)).json();
    assert.equal(fromAssist.module, "assistencia");
    assert.deepEqual(fromAssist.months.flatMap((m) => m.entries.map((row) => row.saleCode)), ["OS-1"]);
    assert.ok(all.months.flatMap((m) => m.entries).every((row) => row.saleCode !== "OS-1"));
  } finally {
    await call(CENTRAL, "PUT", { storeId: A, month: "2026-09", balanceCents: null });
  }
});
