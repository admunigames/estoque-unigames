import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// CORRIDA UBER na gordura (23/10/2026): a gordura marcada vira corrida "sem
// cartão" na Conciliação Uber; casa com a cobrança da fatura de um cartão e
// passa a ser dele; desfazer devolve ao pool; editar/desmarcar/excluir a
// gordura atualiza ou apaga a corrida.

const db = await setupRouteDb([
  "shared_state", "commercial_gd_balance_adjustments", "commercial_gd_opening_balances", "commercial_gd_store_info",
  "finance_corporate_cards", "finance_card_invoice_entries", "finance_uber_rides",
]);
const gd = await import("../app/api/controle-gd/route.ts");
const uber = await import("../app/api/finance/corporate-cards/[id]/uber/route.ts");

const LOJA = "clojaalfa1";
const OUTRA = "clojabeta1";
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: LOJA, name: "LOJA ALFA" }, { id: OUTRA, name: "LOJA BETA" }]) });
db.insert("finance_corporate_cards", { id: "card-1", name: "CARTÃO DIRETORIA", company_id: "", company_name: "", status: "active", created_by: "seed" });
db.insert("finance_corporate_cards", { id: "card-beta", name: "CARTÃO BETA", company_id: OUTRA, company_name: "LOJA BETA", status: "active", created_by: "seed" });
db.insert("finance_card_invoice_entries", { id: "c1", import_id: "f1", card_id: "card-1", entry_date: "2026-10-06", merchant: "UBER *TRIP", amount_cents: 3200 });

const CENTRAL = { id: "brenndha", displayName: "BRENNDHA", permissions: ["controle_gd:view", "controle_gd:create", "controle_gd:edit"] };
const ADMIN = { id: "admin", role: "admin" };
const one = (sql, ...params) => db.prepare(sql).bind(...params).first();
const many = async (sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
const gdCall = (method, body) => callRoute(gd[method], CENTRAL, method, "/api/controle-gd", body);
const uberGet = async (cardId) => (await callRoute(uber.GET, ADMIN, "GET", `/api/finance/corporate-cards/${cardId}/uber?month=2026-10`, undefined, { id: cardId })).json();
const uberPost = (cardId, body) => callRoute(uber.POST, ADMIN, "POST", `/api/finance/corporate-cards/${cardId}/uber`, body, { id: cardId });

let gdId = "";

test("gordura CORRIDA UBER vira corrida sem cartão; gordura comum não", async () => {
  const created = await gdCall("POST", { storeId: LOJA, entryDate: "2026-10-05", saleCode: "330685", sellerName: "ana", amountCents: -3200, notes: "uber cliente", uberRide: true });
  assert.equal(created.status, 201);
  gdId = (await created.json()).id;
  assert.equal((await gdCall("POST", { storeId: LOJA, entryDate: "2026-10-05", saleCode: "1", sellerName: "x", amountCents: 500 })).status, 201);
  const rides = await many("SELECT card_id AS cardId, company_id AS companyId, ride_date AS rideDate, amount_cents AS cents, passenger, reason, gd_adjustment_id AS gd FROM finance_uber_rides");
  assert.equal(rides.length, 1);
  assert.deepEqual({ ...rides[0] }, { cardId: "", companyId: LOJA, rideDate: "2026-10-05", cents: 3200, passenger: "ANA", reason: "VENDA 330685 · UBER CLIENTE", gd: gdId });
  const list = await (await callRoute(gd.GET, CENTRAL, "GET", "/api/controle-gd?month=2026-10")).json();
  assert.equal(Number(list.entries.find((row) => row.id === gdId).uberRide), 1);
});

test("aparece no cartão sem loja (não no de outra loja), casa com a fatura e passa a ser do cartão", async () => {
  const data = await uberGet("card-1");
  assert.equal(data.rides.length, 1);
  assert.equal(data.rides[0].gdAdjustmentId, gdId);
  assert.equal((await uberGet("card-beta")).rides.length, 0, "cartão de outra loja não vê a corrida");

  const matched = await (await uberPost("card-1", { action: "automatch", month: "2026-10" })).json();
  assert.equal(matched.matched, 1);
  assert.deepEqual({ ...(await one("SELECT card_id AS c, card_entry_id AS e FROM finance_uber_rides")) }, { c: "card-1", e: "c1" });
  assert.equal((await uberGet("card-1")).rides[0].charge.id, "c1");

  assert.equal((await uberPost("card-1", { action: "delete", ids: [data.rides[0].id] })).status, 409, "só sai pela gordura");
  assert.equal((await uberPost("card-1", { action: "unlink", rideId: data.rides[0].id })).status, 200);
  assert.deepEqual({ ...(await one("SELECT card_id AS c, card_entry_id AS e FROM finance_uber_rides")) }, { c: "", e: "" }, "volta ao pool");
});

test("editar a gordura atualiza a corrida; desmarcar ou excluir apaga", async () => {
  const base = { id: gdId, entryDate: "2026-10-07", saleCode: "330685", sellerName: "ana", amountCents: -4100, notes: "" };
  assert.equal((await gdCall("PATCH", { ...base, uberRide: true })).status, 200);
  assert.deepEqual({ ...(await one("SELECT ride_date AS d, amount_cents AS v FROM finance_uber_rides")) }, { d: "2026-10-07", v: 4100 });
  assert.equal((await gdCall("PATCH", { ...base, uberRide: false })).status, 200);
  assert.equal((await one("SELECT COUNT(*) AS n FROM finance_uber_rides")).n, 0);
  assert.equal((await gdCall("PATCH", { ...base, uberRide: true })).status, 200);
  assert.equal((await one("SELECT COUNT(*) AS n FROM finance_uber_rides")).n, 1);
  assert.equal((await gdCall("DELETE", { id: gdId })).status, 200);
  assert.equal((await one("SELECT COUNT(*) AS n FROM finance_uber_rides")).n, 0);
});

test("tela: caixa CORRIDA UBER na gordura e etiqueta GORDURA na conciliação", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /<input type="checkbox" id="gdAdjustUber"> CORRIDA UBER/);
  assert.match(html, /uberRide: el\('gdAdjustUber'\)\.checked/);
  assert.match(html, /ride\.gdAdjustmentId \? ' <span class="status-pill warn"/);
});
