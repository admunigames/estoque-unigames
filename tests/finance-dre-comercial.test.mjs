import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// DRE (prompt 7, 22/10/2026): receita automática do Comercial (VENDAS = FEITO
// da Meta Loja; SERVIÇOS = FEITO ASSISTÊNCIA; CONSOLIDADA = soma das lojas),
// RH automático sem o mapeamento RH NA DRE, e sem a aba DRE ASSISTÊNCIA.

const db = await setupRouteDb([
  "shared_state", "finance_categories", "finance_items", "finance_store_entries", "finance_store_revenue",
  "commercial_store_goals", "hr_payroll_entries", "hr_benefits", "hr_commissions", "hr_payroll_settings", "hr_dre_mapping",
  "finance_rateio_model_shares", "finance_store_headcount",
]);
const dreRoute = await import("../app/api/finance/dre/route.ts");
const revenueRoute = await import("../app/api/finance/revenue/route.ts");
const { computeRateioShares } = await import("../app/api/finance/expenses/rateio.ts");

const ALFA = "clojaalfa1";
const BETA = "clojabeta1";
const ADMIN = { id: "admin", role: "admin" };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }, { id: BETA, name: "LOJA BETA" }]) });
db.insert("commercial_store_goals", { id: "g1", month: "2026-10", company_id: ALFA, revenue_cents: 800000, assist_revenue_cents: 200000, updated_at: "2026-10-20T10:00:00Z", updated_by_name: "COMERCIAL" });
db.insert("commercial_store_goals", { id: "g2", month: "2026-10", company_id: BETA, revenue_cents: 500000, assist_revenue_cents: 0 });
// Valor antigo digitado na DRE: não vale mais.
db.insert("finance_store_revenue", { id: "old", store_id: ALFA, month: "2026-10", amount_cents: 1, sales_amount_cents: 1, services_amount_cents: 0, created_by: "x" });
db.insert("hr_payroll_entries", { id: "p1", month: "2026-10", company_id: ALFA, employee_id: "e1", base_salary_cents: 200000, created_by: "x" });
db.insert("hr_commissions", { id: "c1", month: "2026-10", company_id: ALFA, employee_id: "e1", commission_cents: 30000, premiums_cents: 5000, created_by: "x" });

const get = async (path) => (await callRoute(dreRoute.GET, ADMIN, "GET", path)).json();

test("receita da loja = VENDAS (FEITO) + SERVIÇOS (FEITO ASSISTÊNCIA) do Comercial; consolidada = soma", async () => {
  const store = await get(`/api/finance/dre?scope=store&storeId=${ALFA}&month=2026-10`);
  assert.equal(store.revenueCents, 1_000_000);
  const consolidated = await get("/api/finance/dre?scope=consolidated&month=2026-10");
  assert.equal(consolidated.revenueCents, 1_500_000);
  const revenue = (await (await callRoute(revenueRoute.GET, ADMIN, "GET", `/api/finance/revenue?storeId=${ALFA}&month=2026-10`)).json()).revenue;
  assert.deepEqual([revenue.salesAmountCents, revenue.servicesAmountCents, revenue.source, revenue.updatedByName], [800000, 200000, "commercial", "COMERCIAL"]);
  const post = await callRoute(revenueRoute.POST, ADMIN, "POST", "/api/finance/revenue", { storeId: ALFA, month: "2026-10", salesAmountCents: 1 });
  assert.equal(post.status, 410);
});

test("RH entra automático em PESSOAL — RH sem mapeamento (custo total) e a aba Assistência saiu", async () => {
  const store = await get(`/api/finance/dre?scope=store&storeId=${ALFA}&month=2026-10`);
  const rh = store.categories.find((category) => category.id === "rh-pessoal");
  assert.ok(rh, "categoria automática do RH");
  assert.deepEqual(rh.items.map((item) => [item.id, item.payrollCents]), [["rh-folha", 200000], ["rh-beneficios", null], ["rh-comissoes", 35000]]);
  assert.equal(rh.totalCents, 235000);
  assert.equal(store.expenseTotalCents, 235000);
  assert.equal((await callRoute(dreRoute.GET, ADMIN, "GET", "/api/finance/dre?scope=assistencia&month=2026-10")).status, 400);
});

test("Rateio por Faturamento usa o faturamento do Comercial", async () => {
  const result = await computeRateioShares(globalThis.__routeTestDb, { model: "faturamento_vendas", competenceMonth: "2026-10", totalAmountCents: 1300 });
  assert.deepEqual(result.shares.map((share) => [share.companyId, share.amountCents]), [[ALFA, 800], [BETA, 500]]);
});

test("tela da DRE: receita só leitura vinda do Comercial, sem RH NA DRE e sem aba DRE ASSISTÊNCIA", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /id="dreRevenueSales" placeholder="R\$ 0,00" readonly/);
  assert.match(html, /id="dreRevenueServices" placeholder="R\$ 0,00" readonly/);
  assert.match(html, /'VEM DO COMERCIAL'\+/);
  assert.doesNotMatch(html, /id="btnSaveDreRevenue"|id="btnOpenRhDreMapping"|id="rhDreMappingDialog"|>RH NA DRE</);
  assert.doesNotMatch(html, /data-dre-tab="assistencia"|id="dreTabAssistencia"|scope=assistencia/);
  assert.match(html, /AUTOMÁTICO \(RH\)/);
});
