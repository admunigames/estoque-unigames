import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Comercial — LÍDER COMERCIAL, OPERACIONAL, META/FEITO DA ASSISTÊNCIA e a aba
// INDICAÇÃO por loja (pedido de 2026-10-16). Rotas reais sobre SQLite.

const db = await setupRouteDb([
  "shared_state", "hr_employees", "commercial_monthly", "commercial_rules", "commercial_newcomers",
  "commercial_credit_entries", "commercial_store_goals", "hr_commissions", "hr_commission_items", "hr_payroll_settings",
  "commercial_roles", "commercial_indications", "commercial_weekend_goals",
]);
const migration = await readFile(new URL("../drizzle/0098_comercial_lider_operacional_indicacao.sql", import.meta.url), "utf8");

const lib = await import("../app/lib/commercial.ts");
const rulesRoute = await import("../app/api/commercial/rules/route.ts");
const overview = await import("../app/api/commercial/overview/route.ts");
const sellersRoute = await import("../app/api/commercial/sellers/route.ts");
const rolesRoute = await import("../app/api/commercial/roles/route.ts");
const entriesRoute = await import("../app/api/commercial/entries/route.ts");
const storesRoute = await import("../app/api/commercial/stores/route.ts");
const rankingRoute = await import("../app/api/commercial/ranking/route.ts");
const newcomersRoute = await import("../app/api/commercial/newcomers/route.ts");
const weekendRoute = await import("../app/api/commercial/weekend/route.ts");
const assistanceRoute = await import("../app/api/commercial/assistance/route.ts");
const migration0099 = await readFile(new URL("../drizzle/0099_comercial_fim_de_semana_indicacao_loja.sql", import.meta.url), "utf8");
const hrCommissionsRoute = await import("../app/api/hr-payroll/commissions/route.ts");

const STORE_A = "clojaalfa1";
const STORE_B = "clojabeta1";
db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([{ id: STORE_A, name: "LOJA ALFA" }, { id: STORE_B, name: "LOJA BETA" }, { id: "clojadigit1", name: "LOJA DIGITAL" }]),
});
// [id, nome, loja, cargo, status, admissão, conta]
for (const [id, name, companyId, roleTitle, status = "active", admission = "", userId = ""] of [
  ["emp-lider", "Wamberto Portal", STORE_A, "Vendedor"],
  ["emp-v1", "Vendedor Um", STORE_A, "Vendedor"],
  ["emp-v2", "Vendedor Novato", STORE_A, "Vendedor"],
  ["emp-v3", "Vendedor Inativo", STORE_A, "Vendedor", "inactive"],
  ["emp-v4", "Vendedor Quatro", STORE_A, "Vendedor"],
  ["emp-v5", "Vendedor Beta", STORE_B, "Vendedor"],
  ["emp-op1", "Giovanna Gomes", STORE_A, "OPERACIONAL", "active", "2025-01-10", "user-op1"],
  ["emp-op2", "Aline Leticia", STORE_A, "LÍDER OPERACIONAL"],
  ["emp-op3", "Waleska Queiroz", STORE_B, "Supervisor Operacional"],
  ["emp-op-off", "Operacional Saiu", STORE_A, "OPERACIONAL", "inactive"],
  ["emp-op-new", "Operacional Novo", STORE_A, "OPERACIONAL", "active", "2026-11-05"],
  ["emp-dig", "Vendedor Digital", "clojadigit1", "Vendedor"],
]) {
  db.insert("hr_employees", {
    id, full_name: name, company_id: companyId, company_name: { [STORE_A]: "LOJA ALFA", [STORE_B]: "LOJA BETA" }[companyId] || "LOJA DIGITAL",
    role_title: roleTitle, status, admission_date: admission, user_id: userId, cpf: id,
  });
}

const ADMIN = { id: "admin", role: "admin" };
const RULES = { id: "u-rules", permissions: ["comercial:rules"] };
const DASHBOARD = { id: "u-dash", permissions: ["comercial:dashboard", "comercial:ranking"] };
const OP1_DASH = { id: "user-op1", companyId: STORE_A, permissions: ["comercial:dashboard"] };
const OP1_COMMISSION = { ...OP1_DASH, permissions: ["comercial:dashboard", "comercial:commission"] };
const PAYROLL = { id: "u-rh", permissions: ["payroll:manage"] };

const BASE_RULE = {
  revenueRateHighBps: 60, revenueRateLowBps: 40, warrantyRateBps: 600, warrantyAttachTarget: 30,
  creditRateBps: 200, partnerSaleRateBps: 0,
  premiumTiers: [{ percent: 110, cents: 50_000 }, { percent: 120, cents: 150_000 }],
};
const postRule = (body) => callRoute(rulesRoute.POST, RULES, "POST", "/api/commercial/rules", body);

// Todos batem os critérios (itens, realme, anexo 3 de 10).
const sellerBody = (month, employeeId, targetRevenueCents, revenueCents, extra = {}) => ({
  month, employeeId, zone: "SUL", targetRevenueCents, revenueCents, targetItems: 10, items: 10, targetRealme: 1, realme: 1,
  warrantyQty: 3, notebookQty: 10, warrantyCents: 0, ...extra,
});
const putSeller = async (body) => {
  const response = await callRoute(sellersRoute.PUT, ADMIN, "PUT", "/api/commercial/sellers", body);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
};
// Meta Loja grava vendas E assistência da loja na mesma linha (a aba Meta
// Assistência é só o painel).
const putStore = async (month, companyId, values) => {
  const response = await callRoute(storesRoute.PUT, ADMIN, "PUT", "/api/commercial/stores", { month, companyId, ...values });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
};
const putRole = (user, body) => callRoute(rolesRoute.PUT, user, "PUT", "/api/commercial/roles", body);
const getOverview = async (user, month, extra = "") => {
  const response = await callRoute(overview.GET, user, "GET", `/api/commercial/overview?month=${month}${extra}`);
  assert.equal(response.status, 200);
  return response.json();
};
// Total enviado ao RH = comissão + premiação do Comercial (gravadas separadas
// desde 22/10/2026 — o total do recibo não muda).
const hrRow = (employeeId, month) =>
  db.sqlite.prepare("SELECT commission_cents + commercial_premium_cents AS c, commission_cents AS commission, commercial_premium_cents AS premium FROM hr_commissions WHERE employee_id=? AND month=?").get(employeeId, month);

// Mês com o líder, os vendedores da loja ALFA (+ um da BETA) e as metas da loja.
async function seedMonth(month) {
  await putSeller(sellerBody(month, "emp-lider", 10_000_000, 12_500_000, { warrantyCents: 100_000 }));
  await putSeller(sellerBody(month, "emp-v1", 10_000_000, 11_500_000)); // 115% ✓
  await putSeller(sellerBody(month, "emp-v2", 10_000_000, 11_000_000)); // 110% exato ✓ (novato)
  await putSeller(sellerBody(month, "emp-v3", 10_000_000, 20_000_000)); // inativo ✗
  await putSeller(sellerBody(month, "emp-v4", 10_000_000, 10_500_000)); // 105% ✗
  await putSeller(sellerBody(month, "emp-v5", 10_000_000, 15_000_000)); // outra loja ✗
  const credit = await callRoute(entriesRoute.POST, ADMIN, "POST", "/api/commercial/entries", {
    month, kind: "payjoy", saleRef: `${month}-lider`, employeeId: "emp-lider", amountCents: 1_000_000,
  });
  assert.equal(credit.status, 201);
  const newcomer = await callRoute(newcomersRoute.PUT, ADMIN, "PUT", "/api/commercial/newcomers", { employeeId: "emp-v2", month, newcomer: true });
  assert.equal(newcomer.status, 200);
  // Loja ALFA: 120% da meta e assistência 120%.
  await putStore(month, STORE_A, { targetCents: 10_000_000, revenueCents: 12_000_000, assistTargetCents: 1_000_000, assistRevenueCents: 1_200_000 });
}

test("lib: tipo pelo cargo — qualquer OPERACIONAL é operacional; LÍDER (sem operacional) é líder", () => {
  assert.equal(lib.roleFromTitle("OPERACIONAL"), "operacional");
  assert.equal(lib.roleFromTitle("LÍDER OPERACIONAL"), "operacional");
  assert.equal(lib.roleFromTitle("Supervisor Operacional"), "operacional");
  assert.equal(lib.roleFromTitle("OPERACIONAL ASSISTÊNCA"), "operacional");
  assert.equal(lib.roleFromTitle("Líder Comercial"), "lider");
  assert.equal(lib.roleFromTitle("Vendedor"), "vendedor");
});

test("lib: líder — 0,4% abaixo de 100% (inclusive < 80%), 0,6% a partir de 100%, sobre faturado − crediário", () => {
  const leader = lib.DEFAULT_ROLE_RULES.leader;
  const clock = lib.monthClock("2026-10", "2026-10-16");
  const goal = { targetRevenueCents: 10_000_000, targetItems: 0, targetSuperItems: 0, targetWarrantyCents: 0, targetRealme: 0 };
  const realized = (revenueCents) => ({
    revenueCents, items: 0, warrantyCents: 50_000, realme: 0, warrantyQty: 0, notebookQty: 0, salesQty: 0,
    creditSalesCents: 1_000_000, partnerSalesCents: 0,
  });
  const run = (revenueCents) => {
    const metrics = lib.computeSellerMetrics(goal, realized(revenueCents), clock);
    return lib.leaderCommission(metrics, realized(revenueCents), 0, leader, [], null);
  };
  for (const [revenue, rate] of [[5_000_000, 40], [8_500_000, 40], [9_999_999, 40], [10_000_000, 60], [14_000_000, 60]]) {
    const commission = run(revenue);
    assert.equal(commission.revenueRateBps, rate, `faturado ${revenue}`);
    assert.equal(commission.revenueBaseCents, revenue - 1_000_000);
    assert.equal(commission.revenueCommissionCents, Math.round(((revenue - 1_000_000) * rate) / 10_000));
    assert.equal(commission.warrantyCommissionCents, 3_000); // 6%
    assert.equal(commission.creditCommissionCents, 20_000); // 2%
    assert.equal(commission.revenuePremiumCents, 0, "sem premiação de vendedor");
  }
});

test("lib: liderados que contam — novato conta; inativo, o próprio líder, outro líder e outra loja não", () => {
  const member = (employeeId, extra) => ({
    employeeId, name: employeeId.toUpperCase(), companyId: "A", inactive: false, role: "vendedor",
    targetRevenueCents: 100, revenueCents: 110, ...extra,
  });
  const qualified = lib.leaderQualifiedSellers({ employeeId: "lider", companyId: "A" }, [
    member("lider", { role: "lider", revenueCents: 200 }),
    member("ok"),
    member("novato"),
    member("inativo", { inactive: true }),
    member("outro-lider", { role: "lider" }),
    member("outra-loja", { companyId: "B" }),
    member("abaixo", { revenueCents: 109 }),
    member("sem-meta", { targetRevenueCents: 0 }),
  ], 110);
  assert.deepEqual(qualified, ["OK", "NOVATO"]);
});

test("lib: operacional — nada < 80%, 0,5% de 80% a 99,9%, 1% a partir de 100%, prêmios a 120%", () => {
  const op = lib.DEFAULT_ROLE_RULES.operational;
  const run = (assistRevenueCents, revenueCents = 0) =>
    lib.operationalCommission({ targetCents: 1_000_000, revenueCents, assistTargetCents: 1_000_000, assistRevenueCents }, op);
  assert.equal(run(799_999).commissionCents, 0);
  assert.equal(run(800_000).rateBps, 50);
  assert.equal(run(800_000).commissionCents, 4_000);
  assert.equal(run(999_999).rateBps, 50);
  assert.equal(run(1_000_000).rateBps, 100);
  assert.equal(run(1_000_000).commissionCents, 10_000);
  assert.equal(run(1_199_999).assistPremiumCents, 0);
  const top = run(1_200_000, 1_200_000);
  assert.deepEqual([top.assistPremiumCents, top.storePremiumCents, top.payslipCents, top.premiumCents, top.totalCents], [20_000, 40_000, 12_000, 60_000, 72_000]);
  assert.equal(run(500_000, 1_200_000).storePremiumCents, 40_000, "premiação da loja independe da assistência");
  assert.equal(lib.operationalCommission(null, op).totalCents, 0);
});

test("regras: líder/operacional por vigência, validados; vigência sem eles mantém o líder como vendedor", async () => {
  const bad = await postRule({ ...BASE_RULE, validFrom: "2026-10", roles: { leader: { ...lib.DEFAULT_ROLE_RULES.leader, rateLowBps: 20_000 }, operational: lib.DEFAULT_ROLE_RULES.operational } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /LÍDER ABAIXO DA META/);
  assert.equal((await postRule({ ...BASE_RULE, validFrom: "2026-09" })).status, 201);
  assert.equal((await postRule({ ...BASE_RULE, validFrom: "2026-10", roles: lib.DEFAULT_ROLE_RULES })).status, 201);
  const data = await (await callRoute(rulesRoute.GET, RULES, "GET", "/api/commercial/rules")).json();
  assert.deepEqual(data.items.find((rule) => rule.validFrom === "2026-10").roles, lib.DEFAULT_ROLE_RULES);
  assert.equal(data.items.find((rule) => rule.validFrom === "2026-09").roles, null);
  assert.deepEqual(data.roleDefaults, lib.DEFAULT_ROLE_RULES);
});

test("tipo no mês (aba Vendedores): comercial:goals, escopo de loja, '' volta ao cargo", async () => {
  assert.equal((await putRole(DASHBOARD, { month: "2026-10", employeeId: "emp-lider", role: "lider" })).status, 403);
  const goalsB = { id: "u-goals-b", companyId: STORE_B, permissions: ["comercial:goals"] };
  assert.equal((await putRole(goalsB, { month: "2026-10", employeeId: "emp-lider", role: "lider" })).status, 404);
  assert.equal((await putRole(ADMIN, { month: "2026-10", employeeId: "emp-lider", role: "chefe" })).status, 400);
  for (const month of ["2026-09", "2026-10"]) {
    assert.equal((await putRole(ADMIN, { month, employeeId: "emp-lider", role: "lider" })).status, 200);
  }
  const sellers = await (await callRoute(sellersRoute.GET, ADMIN, "GET", "/api/commercial/sellers?month=2026-10")).json();
  assert.equal(sellers.rolesEnabled, true);
  assert.deepEqual(sellers.roleOverrides, { "emp-lider": "lider" });
  assert.equal(sellers.employees.find((employee) => employee.id === "emp-op2").cargoRole, "operacional");
  const september = await (await callRoute(sellersRoute.GET, ADMIN, "GET", "/api/commercial/sellers?month=2026-09")).json();
  assert.equal(september.rolesEnabled, false);
});

test("líder: comissão própria, sem premiação de vendedor; R$ 500 por liderado com 110%+ e R$ 1.500 só com loja E assistência em 120%", async () => {
  await seedMonth("2026-10");
  const data = await getOverview(ADMIN, "2026-10", "&inactive=1");
  const leader = data.sellers.find((seller) => seller.employeeId === "emp-lider");
  assert.equal(leader.role, "lider");
  const c = leader.metrics.commission;
  // 125% da meta: 0,6% de (12.500.000 − 1.000.000 de crediário).
  assert.equal(c.revenueRateBps, 60);
  assert.equal(c.revenueCommissionCents, 69_000);
  assert.equal(c.warrantyCommissionCents, 6_000);
  assert.equal(c.creditCommissionCents, 20_000);
  assert.deepEqual([...c.leader.qualified].sort(), ["VENDEDOR NOVATO", "VENDEDOR UM"]);
  assert.equal(c.leader.sellersPremiumCents, 100_000);
  assert.equal(c.leader.storePremiumCents, 150_000);
  // A premiação de vendedor (R$ 1.500 a 120%) NÃO entra: só a do líder.
  assert.equal(c.revenuePremiumCents, 250_000);
  assert.deepEqual([c.payslipCents, c.premiumCents, c.totalCents], [95_000, 250_000, 345_000]);
  assert.equal(hrRow("emp-lider", "2026-10").c, 345_000);
  // Os vendedores continuam com a regra de vendedor.
  const v1 = data.sellers.find((seller) => seller.employeeId === "emp-v1");
  assert.equal(v1.role, "vendedor");
  assert.equal(v1.metrics.commission.revenuePremiumCents, 50_000);

  // Assistência em 119,9%: sai o R$ 1.500 (precisa das duas).
  await putStore("2026-10", STORE_A, { targetCents: 10_000_000, revenueCents: 12_000_000, assistTargetCents: 1_000_000, assistRevenueCents: 1_199_000 });
  let again = (await getOverview(ADMIN, "2026-10")).sellers.find((seller) => seller.employeeId === "emp-lider");
  assert.equal(again.metrics.commission.leader.storePremiumCents, 0);
  assert.equal(hrRow("emp-lider", "2026-10").c, 195_000);
  // Loja em 119,9% e assistência em 120%: também não.
  await putStore("2026-10", STORE_A, { targetCents: 10_000_000, revenueCents: 11_990_000, assistTargetCents: 1_000_000, assistRevenueCents: 1_200_000 });
  again = (await getOverview(ADMIN, "2026-10")).sellers.find((seller) => seller.employeeId === "emp-lider");
  assert.equal(again.metrics.commission.leader.storePremiumCents, 0);
  // Volta as duas em 120%.
  await putStore("2026-10", STORE_A, { targetCents: 10_000_000, revenueCents: 12_000_000, assistTargetCents: 1_000_000, assistRevenueCents: 1_200_000 });
  assert.equal(hrRow("emp-lider", "2026-10").c, 345_000);
});

test("vigência: em 09/2026 (sem regras de líder/operacional) o líder é vendedor comum e não há operacionais", async () => {
  await seedMonth("2026-09");
  const data = await getOverview(ADMIN, "2026-09");
  const leader = data.sellers.find((seller) => seller.employeeId === "emp-lider");
  assert.equal(leader.role, "vendedor");
  assert.equal(leader.metrics.commission.leader, undefined);
  assert.equal(leader.metrics.commission.revenuePremiumCents, 150_000); // faixa de 120% do vendedor
  assert.deepEqual(data.operationals, []);
});

test("operacional: pelo cargo (ativo, com loja, admitido até o mês), valor CHEIO para cada um, + R$ 200 / R$ 400; vai para o RH", async () => {
  const data = await getOverview(ADMIN, "2026-10");
  const ids = data.operationals.map((person) => person.employeeId).sort();
  // Fora: inativo e admitido depois do mês. A BETA entra (sem meta = R$ 0).
  assert.deepEqual(ids, ["emp-op1", "emp-op2", "emp-op3"]);
  for (const id of ["emp-op1", "emp-op2"]) {
    const person = data.operationals.find((item) => item.employeeId === id);
    assert.deepEqual(
      [person.commission.rateBps, person.commission.commissionCents, person.commission.assistPremiumCents, person.commission.storePremiumCents, person.commission.totalCents],
      [100, 12_000, 20_000, 40_000, 72_000],
      id,
    );
    assert.equal(hrRow(id, "2026-10").c, 72_000);
  }
  assert.equal(data.operationals.find((item) => item.employeeId === "emp-op3").commission.totalCents, 0);
  assert.equal(hrRow("emp-op3", "2026-10"), undefined, "operacional zerado não ganha cabeçalho novo no RH");
  // Operacional não é vendedor: fora do Dashboard de vendedores e do Ranking.
  assert.ok(!data.sellers.some((seller) => seller.employeeId.startsWith("emp-op")));
  const rank = await (await callRoute(rankingRoute.GET, DASHBOARD, "GET", "/api/commercial/ranking?month=2026-10")).json();
  assert.ok(!rank.items.some((item) => item.employeeId.startsWith("emp-op")));
  // Assistência em 85%: 0,5%; em 79%: nada. A loja vale pelo TOTAL (vendas +
  // assistência): 12.000.000 + 850.000 de 11.000.000 = 116,8% → sem os R$ 400.
  await putStore("2026-10", STORE_A, { targetCents: 10_000_000, revenueCents: 12_000_000, assistTargetCents: 1_000_000, assistRevenueCents: 850_000 });
  let op1 = (await getOverview(ADMIN, "2026-10")).operationals.find((item) => item.employeeId === "emp-op1");
  assert.deepEqual([op1.commission.rateBps, op1.commission.commissionCents, op1.commission.storePremiumCents, op1.commission.totalCents], [50, 4_250, 0, 4_250]);
  assert.equal(hrRow("emp-op1", "2026-10").c, 4_250);
  // Vendas compensam: 12.350.000 + 850.000 = 13.200.000 de 11.000.000 = 120% → volta os R$ 400.
  await putStore("2026-10", STORE_A, { targetCents: 10_000_000, revenueCents: 12_350_000, assistTargetCents: 1_000_000, assistRevenueCents: 850_000 });
  op1 = (await getOverview(ADMIN, "2026-10")).operationals.find((item) => item.employeeId === "emp-op1");
  assert.equal(op1.commission.storePremiumCents, 40_000);
  assert.equal(op1.commission.storePercent, 120);
  // Comissão (4.250) e premiação (R$ 400) vão separadas para o RH; o total não muda.
  assert.deepEqual([hrRow("emp-op1", "2026-10").c, hrRow("emp-op1", "2026-10").commission, hrRow("emp-op1", "2026-10").premium], [44_250, 4_250, 40_000]);
  await putStore("2026-10", STORE_A, { targetCents: 10_000_000, revenueCents: 12_000_000, assistTargetCents: 1_000_000, assistRevenueCents: 790_000 });
  op1 = (await getOverview(ADMIN, "2026-10")).operationals.find((item) => item.employeeId === "emp-op1");
  assert.deepEqual([op1.commission.rateBps, op1.commission.commissionCents], [0, 0]);
  await putStore("2026-10", STORE_A, { targetCents: 10_000_000, revenueCents: 12_000_000, assistTargetCents: 1_000_000, assistRevenueCents: 1_200_000 });
  // RH: vem do Comercial, com o tipo (recibo do operacional = natureza salarial).
  const hr = await (await callRoute(hrCommissionsRoute.GET, PAYROLL, "GET", "/api/hr-payroll/commissions?month=2026-10")).json();
  const row = hr.commissions.find((item) => item.employeeId === "emp-op1");
  assert.equal(row.fromCommercial, true);
  assert.equal(row.commercialRole, "operacional");
  assert.equal(hr.commissions.find((item) => item.employeeId === "emp-lider").commercialRole, "lider");
});

test("operacional: conta vinculada vê só o próprio cartão; sem comercial:commission, só % (nenhum R$)", async () => {
  const own = await getOverview(OP1_COMMISSION, "2026-10");
  assert.equal(own.ownOnly, true);
  assert.deepEqual(own.sellers, []);
  assert.deepEqual(own.operationals.map((item) => item.employeeId), ["emp-op1"]);
  assert.equal(own.operationals[0].commission.totalCents, 72_000);
  const dash = await getOverview(OP1_DASH, "2026-10");
  assert.deepEqual(Object.keys(dash.operationals[0].commission).sort(), ["assistPercent", "premiumPercent", "rateBps", "storePercent"]);
  const leader = (await getOverview(DASHBOARD, "2026-10")).sellers.find((seller) => seller.employeeId === "emp-lider");
  assert.equal(leader.metrics.commission.leader, undefined, "premiação do líder só com comercial:commission");
});

test("tipo trocado para OPERACIONAL na aba Vendedores: sai dos vendedores, entra nos operacionais e continua no cadastro", async () => {
  assert.equal((await putRole(ADMIN, { month: "2026-10", employeeId: "emp-v4", role: "operacional" })).status, 200);
  const data = await getOverview(ADMIN, "2026-10");
  assert.ok(!data.sellers.some((seller) => seller.employeeId === "emp-v4"));
  assert.equal(data.operationals.find((item) => item.employeeId === "emp-v4").commission.totalCents, 72_000);
  const cadastro = await getOverview(ADMIN, "2026-10", "&for=cadastro");
  assert.equal(cadastro.sellers.find((seller) => seller.employeeId === "emp-v4").role, "operacional");
  assert.equal((await putRole(ADMIN, { month: "2026-10", employeeId: "emp-v4", role: "" })).status, 200);
  assert.ok((await getOverview(ADMIN, "2026-10")).sellers.some((seller) => seller.employeeId === "emp-v4"));
});

test("copiar o mês anterior leva junto o tipo trocado (LÍDER)", async () => {
  const copied = await callRoute(sellersRoute.POST, ADMIN, "POST", "/api/commercial/sellers", { month: "2026-11" });
  assert.equal(copied.status, 201);
  const roles = db.sqlite.prepare("SELECT employee_id AS e, role FROM commercial_roles WHERE month='2026-11'").all().map((row) => ({ ...row }));
  assert.deepEqual(roles, [{ e: "emp-lider", role: "lider" }]);
});

test("Meta Assistência: lançada na Meta Loja (vendas e assistência lado a lado); a aba é só o painel (ver), com o mês anterior", async () => {
  const ASSIST_VIEW = { id: "u-assist-view", permissions: ["comercial:assist_view"] };
  const STORES_B = { id: "u-stores-b2", companyId: STORE_B, permissions: ["comercial:stores"] };
  const get = async (user, month) => callRoute(assistanceRoute.GET, user, "GET", `/api/commercial/assistance?month=${month}`);
  assert.equal((await get(DASHBOARD, "2026-10")).status, 403);
  assert.equal("PUT" in assistanceRoute, false, "a aba não grava nada");
  assert.equal((await callRoute(storesRoute.PUT, ADMIN, "PUT", "/api/commercial/stores", { month: "2026-10", companyId: STORE_A, assistTargetCents: -1 })).status, 400);
  assert.equal((await callRoute(storesRoute.PUT, STORES_B, "PUT", "/api/commercial/stores", { month: "2026-10", companyId: STORE_A, assistTargetCents: 1 })).status, 404);
  await putStore("2026-09", STORE_A, { assistTargetCents: 900_000, assistRevenueCents: 800_000 });
  const view = await (await get(ASSIST_VIEW, "2026-10")).json();
  assert.equal(view.previousMonth, "2026-09");
  assert.equal(view.premiumPercent, 120);
  const row = view.rows.find((item) => item.companyId === STORE_A);
  assert.deepEqual([row.targetCents, row.revenueCents, row.previousTargetCents, row.previousRevenueCents], [1_000_000, 1_200_000, 900_000, 800_000]);
  // "Atualizado em" só muda quando a assistência muda.
  const stamp = row.updatedAt;
  assert.ok(stamp);
  await putStore("2026-10", STORE_A, { targetCents: 10_000_000, revenueCents: 12_000_000, assistTargetCents: 1_000_000, assistRevenueCents: 1_200_000, indicationQty: 1 });
  assert.equal((await (await get(ADMIN, "2026-10")).json()).rows.find((item) => item.companyId === STORE_A).updatedAt, stamp);
  const store = (await (await callRoute(storesRoute.GET, ADMIN, "GET", "/api/commercial/stores?month=2026-10")).json()).rows.find((item) => item.companyId === STORE_A);
  assert.deepEqual([store.revenueCents, store.assistTargetCents, store.assistRevenueCents], [12_000_000, 1_000_000, 1_200_000]);
  const panel = await (await callRoute(storesRoute.GET, DASHBOARD, "GET", "/api/commercial/stores?month=2026-10")).json();
  assert.equal(panel.items.find((item) => item.companyId === STORE_A).percent, lib.progressPercent(13_200_000, 11_000_000));
});

test("linha ASSISTÊNCIA da Meta Loja: meta à mão, feito = soma da assistência das lojas, fora do total da rede", async () => {
  const HUB = "clojaassist";
  const list = JSON.parse(db.sqlite.prepare("SELECT value_json AS v FROM shared_state WHERE state_key='companies_list'").get().v);
  db.sqlite.prepare("UPDATE shared_state SET value_json=? WHERE state_key='companies_list'").run(JSON.stringify([...list, { id: HUB, name: "ASSISTÊNCIA" }]));
  try {
    const before = (await (await callRoute(storesRoute.GET, ADMIN, "GET", "/api/commercial/stores?month=2026-10")).json()).total;
    await putStore("2026-10", HUB, { targetCents: 2_000_000, revenueCents: 99_999_999, assistTargetCents: 5, assistRevenueCents: 5 });
    const data = await (await callRoute(storesRoute.GET, ADMIN, "GET", "/api/commercial/stores?month=2026-10")).json();
    const hub = data.rows.find((item) => item.companyId === HUB);
    const assistDone = data.rows.filter((item) => !item.assistanceHub).reduce((sum, item) => sum + item.assistRevenueCents, 0);
    assert.equal(hub.assistanceHub, true);
    assert.deepEqual([hub.targetCents, hub.revenueCents, hub.assistTargetCents, hub.assistRevenueCents], [2_000_000, assistDone, 0, 0]);
    assert.equal(data.items.find((item) => item.companyId === HUB).percent, lib.progressPercent(assistDone, 2_000_000));
    assert.deepEqual(data.total, before, "fora do total das lojas");
    // Painel da Meta Assistência: meta da rede = a da linha ASSISTÊNCIA; a linha não vira loja lá.
    const panel = await (await callRoute(assistanceRoute.GET, ADMIN, "GET", "/api/commercial/assistance?month=2026-10")).json();
    assert.equal(panel.companyTargetCents, 2_000_000);
    assert.ok(!panel.rows.some((item) => item.companyId === HUB));
  } finally {
    db.sqlite.prepare("UPDATE shared_state SET value_json=? WHERE state_key='companies_list'").run(JSON.stringify(list));
  }
});

test("Dashboard do operacional e do líder: acompanhamento da loja (loja + assistência) só das lojas deles", async () => {
  const op = await getOverview(OP1_DASH, "2026-10");
  // Loja = TOTAL (vendas 10.000.000/12.000.000 + assistência 1.000.000/1.200.000).
  assert.deepEqual(op.tracking, [{ companyId: STORE_A, name: "LOJA ALFA", targetCents: 11_000_000, revenueCents: 13_200_000, assistTargetCents: 1_000_000, assistRevenueCents: 1_200_000 }]);
  const all = await getOverview(ADMIN, "2026-10");
  // ALFA (líder e operacionais) e BETA (operacional); nunca loja sem eles.
  assert.deepEqual(all.tracking.map((item) => item.companyId).sort(), [STORE_A, STORE_B].sort());
  assert.deepEqual((await getOverview(ADMIN, "2026-10", "&for=cadastro")).tracking, []);
});

test("lib: LOJA DIGITAL — abaixo de 100% a % do vendedor de loja; 0,8% de 100% a 119,9% e 1% a partir de 120% sobre o faturamento total; nada mais", () => {
  const digital = lib.DEFAULT_ROLE_RULES.digital;
  const clock = lib.monthClock("2026-10", "2026-10-22");
  const rules = { ...lib.DEFAULT_COMMERCIAL_RULES, creditRateBps: 200, warrantyRateBps: 600 };
  const goal = { targetRevenueCents: 10_000_000, targetItems: 10, targetSuperItems: 0, targetWarrantyCents: 0, targetRealme: 1 };
  const run = (revenueCents) => {
    const realized = { revenueCents, items: 10, warrantyCents: 100_000, realme: 1, warrantyQty: 3, notebookQty: 10, salesQty: 0, creditSalesCents: 1_000_000, partnerSalesCents: 50_000 };
    return lib.digitalCommission(lib.computeSellerMetrics(goal, realized, clock, rules), digital);
  };
  assert.deepEqual([run(9_000_000).revenueRateBps, run(9_000_000).revenueBaseCents], [60, 8_000_000], "abaixo de 100%: regra de loja (critérios batidos, sem o crediário)");
  assert.deepEqual([run(10_000_000).revenueRateBps, run(10_000_000).revenueCommissionCents], [80, 80_000]);
  assert.equal(run(11_999_999).revenueRateBps, 80);
  assert.deepEqual([run(12_000_000).revenueRateBps, run(12_000_000).revenueCommissionCents], [100, 120_000]);
  const top = run(15_000_000);
  assert.deepEqual([top.revenuePremiumCents, top.warrantyCommissionCents, top.creditCommissionCents, top.partnerCommissionCents, top.totalCents], [0, 0, 0, 0, 150_000]);
  assert.equal(lib.isDigitalStore("Loja Digital"), true);
  assert.equal(lib.isDigitalStore("RIOMAR"), false);
});

test("LOJA DIGITAL na rota: vendedor da loja do RH com DIGITAL ganha só a comissão própria e vai assim para o RH", async () => {
  await putSeller(sellerBody("2026-10", "emp-dig", 10_000_000, 12_500_000, { warrantyCents: 100_000 }));
  const data = await getOverview(ADMIN, "2026-10");
  const seller = data.sellers.find((item) => item.employeeId === "emp-dig");
  assert.equal(seller.metrics.commission.digital, true);
  assert.deepEqual([seller.metrics.commission.revenueRateBps, seller.metrics.commission.totalCents], [100, 125_000]);
  assert.equal(hrRow("emp-dig", "2026-10").c, 125_000);
  // Quem não vê R$ recebe só o selo.
  const dash = (await getOverview(DASHBOARD, "2026-10")).sellers.find((item) => item.employeeId === "emp-dig");
  assert.deepEqual(Object.keys(dash.metrics.commission).sort(), ["allCriteriaMet", "digital", "newcomer", "revenueRateBps"]);
  // Setembro (vigência sem regra da loja digital): vendedor comum.
  await putSeller(sellerBody("2026-09", "emp-dig", 10_000_000, 12_500_000, { warrantyCents: 100_000 }));
  const september = (await getOverview(ADMIN, "2026-09")).sellers.find((item) => item.employeeId === "emp-dig");
  assert.equal(september.metrics.commission.digital, undefined);
});

test("Crediários: lança também para OPERACIONAL do mês — SÓ REGISTRO (não muda comissão, vendedor nem RH)", async () => {
  const CREDIT_B = { id: "u-credit-b", companyId: STORE_B, permissions: ["comercial:credit"] };
  const post = (user, body) => callRoute(entriesRoute.POST, user, "POST", "/api/commercial/entries", { month: "2026-10", kind: "payjoy", amountCents: 500_000, ...body });
  const opCommission = async () => (await getOverview(ADMIN, "2026-10")).operationals.find((item) => item.employeeId === "emp-op1").commission.totalCents;
  const sellerTotals = async () => (await getOverview(ADMIN, "2026-10")).sellers.map((seller) => [seller.employeeId, seller.metrics.commission.totalCents, seller.realized.creditSalesCents]);
  const hrRows = () => db.sqlite.prepare("SELECT employee_id AS e, commission_cents AS c FROM hr_commissions WHERE month='2026-10' ORDER BY e").all().map((row) => ({ ...row }));
  const [opBefore, sellersBefore, hrBefore] = [await opCommission(), await sellerTotals(), hrRows()];

  // Operacional pelo cargo (não está na aba Vendedores): aceito.
  const created = await post(ADMIN, { saleRef: "OP-PJ-1", employeeId: "emp-op1" });
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  // Nem vendedor nem operacional no mês (admitido depois / inativo): recusado.
  for (const employeeId of ["emp-op-new", "emp-op-off"]) {
    const refused = await post(ADMIN, { saleRef: `NAO-${employeeId}`, employeeId });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, "FUNCIONÁRIO NÃO É VENDEDOR NEM OPERACIONAL NESTE MÊS.");
  }
  // Login de loja: só a própria loja.
  assert.equal((await post(CREDIT_B, { saleRef: "OP-PJ-B", employeeId: "emp-op1" })).status, 404);
  assert.equal((await post(CREDIT_B, { saleRef: "OP-PJ-B", employeeId: "emp-op3" })).status, 201);
  // Mesma checagem de venda duplicada.
  assert.equal((await post(ADMIN, { saleRef: "OP-PJ-1", employeeId: "emp-op2" })).status, 409);

  // Nada muda nos cálculos nem no RH.
  assert.equal(await opCommission(), opBefore);
  assert.deepEqual(await sellerTotals(), sellersBefore);
  assert.deepEqual(hrRows(), hrBefore);

  // Na lista: o tipo de cada um e o total da tabela (com o registro).
  const list = await (await callRoute(entriesRoute.GET, ADMIN, "GET", "/api/commercial/entries?month=2026-10&kind=payjoy")).json();
  const entry = list.items.find((item) => item.saleRef === "OP-PJ-1");
  assert.equal(entry.role, "operacional");
  assert.equal(list.items.find((item) => item.saleRef === "2026-10-lider").role, "vendedor");
  assert.equal(list.totalCents, list.items.reduce((sum, item) => sum + item.amountCents, 0));
  // A aba Crediários recebe os operacionais para o seletor.
  const cadastro = await getOverview(ADMIN, "2026-10", "&for=cadastro");
  assert.ok(cadastro.operationals.some((item) => item.employeeId === "emp-op1"));

  // Operacional que está na aba Vendedores (tipo trocado): também só registro.
  assert.equal((await putRole(ADMIN, { month: "2026-10", employeeId: "emp-v4", role: "operacional" })).status, 200);
  try {
    const hrMid = hrRows();
    assert.equal((await post(ADMIN, { saleRef: "OP-PJ-V4", employeeId: "emp-v4" })).status, 201);
    const v4 = (await getOverview(ADMIN, "2026-10", "&for=cadastro")).sellers.find((item) => item.employeeId === "emp-v4");
    assert.equal(v4.realized.creditSalesCents, 0);
    assert.deepEqual(hrRows(), hrMid);
    const v4Entry = (await (await callRoute(entriesRoute.GET, ADMIN, "GET", "/api/commercial/entries?month=2026-10&kind=payjoy")).json()).items.find((item) => item.saleRef === "OP-PJ-V4");
    assert.equal(v4Entry.role, "operacional");
  } finally {
    await putRole(ADMIN, { month: "2026-10", employeeId: "emp-v4", role: "" });
    const id = db.sqlite.prepare("SELECT id FROM commercial_credit_entries WHERE sale_ref='OP-PJ-V4'").get()?.id;
    if (id) await callRoute(entriesRoute.DELETE, ADMIN, "DELETE", `/api/commercial/entries?id=${id}`);
  }
});

test("migration 0098: só ADD COLUMN / CREATE TABLE/INDEX (e RLS nas tabelas novas) — nada apagado ou reescrito", () => {
  const statements = migration.split("--> statement-breakpoint").map((part) => part.replace(/^--.*$/gm, "").trim()).filter(Boolean);
  for (const statement of statements) {
    assert.match(statement, /^(ALTER TABLE "\w+" ADD COLUMN IF NOT EXISTS|CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS|ALTER TABLE "commercial_(roles|indications)" ENABLE ROW LEVEL SECURITY;$)/, statement);
  }
  assert.doesNotMatch(migration, /\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|RENAME)\b/i);
});

test("Meta Loja: INDICAÇÃO (quantidade e R$) por loja, só controle — não muda comissão nem RH", async () => {
  const hrBefore = db.sqlite.prepare("SELECT employee_id AS e, commission_cents + commercial_premium_cents AS c FROM hr_commissions ORDER BY e, month").all().map((row) => ({ ...row }));
  await putStore("2026-10", STORE_A, {
    targetCents: 10_000_000, revenueCents: 12_000_000, assistTargetCents: 1_000_000, assistRevenueCents: 1_200_000,
    indicationQty: 7, indicationCents: 350_000,
  });
  const bad = await callRoute(storesRoute.PUT, ADMIN, "PUT", "/api/commercial/stores", { month: "2026-10", companyId: STORE_A, indicationQty: -1 });
  assert.equal(bad.status, 400);
  const editor = await (await callRoute(storesRoute.GET, ADMIN, "GET", "/api/commercial/stores?month=2026-10")).json();
  const row = editor.rows.find((item) => item.companyId === STORE_A);
  assert.deepEqual([row.indicationQty, row.indicationCents], [7, 350_000]);
  const viewer = await (await callRoute(storesRoute.GET, DASHBOARD, "GET", "/api/commercial/stores?month=2026-10")).json();
  assert.equal(JSON.stringify(viewer).includes("indication"), false, "quem só vê o painel não recebe a indicação");
  const hrAfter = db.sqlite.prepare("SELECT employee_id AS e, commission_cents + commercial_premium_cents AS c FROM hr_commissions ORDER BY e, month").all().map((row) => ({ ...row }));
  assert.deepEqual(hrAfter, hrBefore);
});

test("Meta do Fim de Semana: comercial:weekend(_view), por sábado, escopo de loja, total; só controle", async () => {
  const STORES_A = { id: "u-stores-a", companyId: STORE_A, permissions: ["comercial:weekend"] };
  const WEEKEND_VIEW = { id: "u-weekend-view", permissions: ["comercial:weekend_view"] };
  const put = (user, body) => callRoute(weekendRoute.PUT, user, "PUT", "/api/commercial/weekend", body);
  const get = async (user, query) => (await callRoute(weekendRoute.GET, user, "GET", `/api/commercial/weekend?${query}`)).json();
  const hrBefore = db.sqlite.prepare("SELECT COUNT(*) AS n, SUM(commission_cents + commercial_premium_cents) AS c FROM hr_commissions").get();
  const sellersBefore = db.sqlite.prepare("SELECT COUNT(*) AS n FROM commercial_monthly").get().n;

  assert.equal((await callRoute(weekendRoute.GET, DASHBOARD, "GET", "/api/commercial/weekend?month=2026-10")).status, 403);
  assert.equal((await put(WEEKEND_VIEW, { weekend: "2026-10-09", companyId: STORE_A })).status, 403, "ver não edita");
  assert.equal((await get(WEEKEND_VIEW, "month=2026-10")).canEdit, false);
  assert.equal((await put(ADMIN, { weekend: "2026-10-10", companyId: STORE_A })).status, 400, "sábado não é a chave do fim de semana (é a sexta)");
  assert.equal((await put(STORES_A, { weekend: "2026-10-09", companyId: STORE_B })).status, 404, "loja de fora do alcance");
  assert.equal((await put(ADMIN, { weekend: "2026-10-09", companyId: STORE_A, revenueCents: -5 })).status, 400);
  assert.equal((await put(STORES_A, { weekend: "2026-10-09", companyId: STORE_A, revenueCents: 7_010_916, targetCents: 7_000_000, targetItems: 150, items: 95 })).status, 200);
  assert.equal((await put(ADMIN, { weekend: "2026-10-09", companyId: STORE_B, revenueCents: 3_000_000, targetCents: 6_000_000, targetItems: 100, items: 50 })).status, 200);
  assert.equal((await put(ADMIN, { weekend: "2026-10-16", companyId: STORE_A, revenueCents: 1, targetCents: 2 })).status, 200);

  const all = await get(ADMIN, "month=2026-10&weekend=2026-10-09");
  // Sextas de outubro/2026 (a de 30/10 vai até domingo 01/11).
  assert.deepEqual(all.weekends, ["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30"]);
  assert.equal(all.weekend, "2026-10-09");
  assert.deepEqual(all.total, { targetCents: 13_000_000, revenueCents: 10_010_916, percent: 77, targetItems: 250, items: 145 });
  const mine = await get(STORES_A, "month=2026-10&weekend=2026-10-09");
  assert.deepEqual(mine.rows.map((row) => row.companyId), [STORE_A]);
  assert.equal(mine.total.revenueCents, 7_010_916);
  // Outro fim de semana é outro registro.
  assert.equal((await get(ADMIN, "month=2026-10&weekend=2026-10-16")).total.revenueCents, 1);
  // Fim de semana inválido cai num sábado do mês.
  assert.ok(all.weekends.includes((await get(ADMIN, "month=2026-10&weekend=2026-10-11")).weekend));

  assert.deepEqual(db.sqlite.prepare("SELECT COUNT(*) AS n, SUM(commission_cents + commercial_premium_cents) AS c FROM hr_commissions").get(), hrBefore);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM commercial_monthly").get().n, sellersBefore);
});

test("migration 0099: só ADD COLUMN / CREATE TABLE/INDEX (e RLS na tabela nova)", () => {
  const statements = migration0099.split("--> statement-breakpoint").map((part) => part.replace(/^--.*$/gm, "").trim()).filter(Boolean);
  for (const statement of statements) {
    assert.match(statement, /^(ALTER TABLE "\w+" ADD COLUMN IF NOT EXISTS|CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS|ALTER TABLE "commercial_weekend_goals" ENABLE ROW LEVEL SECURITY;$)/, statement);
  }
  assert.doesNotMatch(migration0099, /\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|RENAME)\b/i);
});
