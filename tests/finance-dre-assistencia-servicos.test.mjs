import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// DRE (26/11/2026): SERVIÇOS DA ASSISTÊNCIA de cada loja (FEITO ASSISTÊNCIA do
// Comercial) somam na DRE da loja ASSISTÊNCIA, não na receita da loja.
// Dados fictícios.

const db = await setupRouteDb([
  "shared_state", "finance_categories", "finance_items", "finance_store_entries", "finance_store_revenue",
  "commercial_store_goals", "hr_payroll_entries", "hr_benefits", "hr_commissions", "hr_payroll_settings", "hr_dre_mapping",
  "finance_rateio_model_shares", "finance_store_headcount",
]);
const dreRoute = await import("../app/api/finance/dre/route.ts");
const revenueRoute = await import("../app/api/finance/revenue/route.ts");

const GUA = "clojagua01";
const PNW = "clojapnw01";
const HUB = "clojahub01";
const ADMIN = { id: "admin", role: "admin" };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: GUA, name: "GUARARAPES" }, { id: PNW, name: "PNWS" }, { id: HUB, name: "Assistência" }]) });
db.insert("commercial_store_goals", { id: "g1", month: "2026-11", company_id: GUA, revenue_cents: 800_000, assist_revenue_cents: 200_000 });
db.insert("commercial_store_goals", { id: "g2", month: "2026-11", company_id: PNW, revenue_cents: 500_000, assist_revenue_cents: 50_000 });

const dre = async (query) => (await callRoute(dreRoute.GET, ADMIN, "GET", `/api/finance/dre?${query}&month=2026-11`)).json();
const revenue = async (storeId) => (await (await callRoute(revenueRoute.GET, ADMIN, "GET", `/api/finance/revenue?storeId=${storeId}&month=2026-11`)).json()).revenue;

test("loja = só VENDAS; ASSISTÊNCIA = SERVIÇOS de todas as lojas; consolidada não muda", async () => {
  assert.equal((await dre(`scope=store&storeId=${GUA}`)).revenueCents, 800_000);
  assert.equal((await dre(`scope=store&storeId=${PNW}`)).revenueCents, 500_000);
  assert.equal((await dre(`scope=store&storeId=${HUB}`)).revenueCents, 250_000);
  assert.equal((await dre("scope=consolidated")).revenueCents, 1_550_000);
  const byStore = new Map((await dre("scope=by-store")).stores.map((store) => [store.storeId, store.revenueCents]));
  assert.deepEqual([byStore.get(GUA), byStore.get(PNW), byStore.get(HUB)], [800_000, 500_000, 250_000]);
});

test("painel de receita: loja mostra o que foi para a ASSISTÊNCIA; ASSISTÊNCIA mostra a soma", async () => {
  const gua = await revenue(GUA);
  assert.deepEqual([gua.salesAmountCents, gua.servicesAmountCents, gua.assistanceHub, gua.servicesToAssistanceCents], [800_000, 0, false, 200_000]);
  const hub = await revenue(HUB);
  assert.deepEqual([hub.salesAmountCents, hub.servicesAmountCents, hub.assistanceHub], [0, 250_000, true]);
});
