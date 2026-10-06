import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Comercial — regras de comissão por vigência (comercial:rules), crediário
// feito (coluna da planilha) e NOVATO no mês (Dashboard). Rotas reais sobre
// SQLite, com o seed da migration 0085.

const db = await setupRouteDb([
  "shared_state", "hr_employees", "commercial_monthly", "commercial_imports", "commercial_aliases",
  "commercial_rules", "commercial_newcomers",
]);
const migration = await readFile(new URL("../drizzle/0085_comercial_regras.sql", import.meta.url), "utf8");
const seed = migration.split("--> statement-breakpoint").map((part) => part.trim()).filter((part) => part.startsWith("INSERT INTO"));
assert.equal(seed.length, 1, "a migration tem um INSERT de seed");
db.sqlite.exec(seed[0]);

const rulesRoute = await import("../app/api/commercial/rules/route.ts");
const newcomersRoute = await import("../app/api/commercial/newcomers/route.ts");
const overview = await import("../app/api/commercial/overview/route.ts");
const importRoute = await import("../app/api/commercial/import/route.ts");

const STORE_A = "clojaalfa1";
const STORE_B = "clojabeta1";
db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([{ id: STORE_A, name: "LOJA ALFA" }, { id: STORE_B, name: "LOJA BETA" }]),
});
for (const [id, name, companyId, userId] of [
  ["emp-ana", "Ana Souza", STORE_A, "user-ana"],
  ["emp-bruno", "Bruno Lima", STORE_A, ""],
  ["emp-carla", "Carla Dias", STORE_B, ""],
]) {
  db.insert("hr_employees", {
    id, full_name: name, company_id: companyId, company_name: companyId === STORE_A ? "LOJA ALFA" : "LOJA BETA",
    role_title: "Vendedor", status: "active", user_id: userId, cpf: id,
  });
}

const ADMIN = { id: "admin", role: "admin" };
const RULES = { id: "u-rules", permissions: ["comercial:rules"] };
const GOALS_A = { id: "u-goals-a", companyId: STORE_A, permissions: ["comercial:goals", "comercial:dashboard"] };
const DASHBOARD = { id: "u-dash", permissions: ["comercial:dashboard"] };
const COMMISSION = { id: "u-com", permissions: ["comercial:dashboard", "comercial:commission"] };
const SELLER_ANA = { id: "user-ana", companyId: STORE_A, permissions: ["comercial:dashboard", "comercial:commission"] };

// Todos batem os critérios: itens 100/100, realme 10/10, anexo 3 de 10.
const HEADER = ["LOJAS", "VENDEDOR", "META REALMES", "REALMES FEITO", "META ITENS", "ITENS FEITO", "GAR FEITO", "QT G.A.R", "NOTEBOOK/PC", "FATURADO", "META", "ZONA"];
function sheet(withCredit) {
  const rows = [
    ["LOJA ALFA", "ANA", 10, 10, 100, 100, 1000, 3, 10, 120000, 100000, "SUL", 20000],
    ["", "BRUNO", 10, 10, 100, 100, 0, 3, 10, 50000, 100000, "SUL", 0],
    ["LOJA BETA", "CARLA", 10, 10, 100, 100, 0, 3, 10, 80000, 100000, "NORTE", 5000],
  ];
  return [withCredit ? [...HEADER, "CREDIÁRIO"] : HEADER, ...rows.map((row) => (withCredit ? row : row.slice(0, -1)))];
}
async function importSheet(month, withCredit) {
  const response = await callRoute(importRoute.POST, ADMIN, "POST", "/api/commercial/import", {
    month, fileName: "acompanhamento.xlsx", sheetName: "VENDEDORES", cells: sheet(withCredit), confirm: true,
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
}
async function sellersOf(user, month) {
  const response = await callRoute(overview.GET, user, "GET", `/api/commercial/overview?month=${month}`);
  assert.equal(response.status, 200);
  return response.json();
}
const byId = (data, id) => data.sellers.find((seller) => seller.employeeId === id);

const RULE_BODY = {
  validFrom: "2026-12", revenueRateHighBps: 70, revenueRateLowBps: 30, warrantyRateBps: 500,
  warrantyAttachTarget: 25, creditRateBps: 300,
  premiumTiers: [{ percent: 105, cents: 30_000 }, { percent: 115, cents: 90_000 }, { percent: 130, cents: 250_000 }],
};

test("seed da migration: 2026-10 com garantia 6% e crediário 2%; tabelas novas com RLS", async () => {
  const data = await (await callRoute(rulesRoute.GET, DASHBOARD, "GET", "/api/commercial/rules")).json();
  assert.equal(data.canManage, false);
  assert.equal(data.items.length, 1);
  assert.deepEqual(
    { ...data.items[0], id: undefined, updatedAt: undefined, notes: undefined },
    {
      validFrom: "2026-10", revenueRateHighBps: 60, revenueRateLowBps: 40,
      premiumTiers: [{ percent: 110, cents: 50_000 }, { percent: 120, cents: 150_000 }],
      warrantyRateBps: 600, warrantyAttachTarget: 30, creditRateBps: 200, updatedByName: "SISTEMA",
      id: undefined, updatedAt: undefined, notes: undefined,
    },
  );
  assert.equal(data.defaults.warrantyRateBps, 400);
  assert.equal(data.defaults.creditRateBps, 0);
  for (const table of ["commercial_rules", "commercial_newcomers"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "credit_sales_cents" integer DEFAULT 0 NOT NULL/);
  assert.doesNotMatch(migration, /DROP|DELETE/);
});

test("rules: GET para qualquer permissão do Comercial; POST/PUT só comercial:rules, com validação", async () => {
  const none = { id: "u-none", permissions: ["tasks:view"] };
  assert.equal((await callRoute(rulesRoute.GET, none, "GET", "/api/commercial/rules")).status, 403);
  for (const user of [DASHBOARD, COMMISSION, GOALS_A]) {
    assert.equal((await callRoute(rulesRoute.POST, user, "POST", "/api/commercial/rules", RULE_BODY)).status, 403);
    assert.equal((await callRoute(rulesRoute.PUT, user, "PUT", "/api/commercial/rules", RULE_BODY)).status, 403);
  }

  const invalid = await callRoute(rulesRoute.POST, RULES, "POST", "/api/commercial/rules", {
    ...RULE_BODY, premiumTiers: [{ percent: 120, cents: 1000 }, { percent: 110, cents: 2000 }],
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /CRESCENTES/);
  assert.equal((await callRoute(rulesRoute.POST, RULES, "POST", "/api/commercial/rules", { ...RULE_BODY, creditRateBps: 20_000 })).status, 400);

  const created = await callRoute(rulesRoute.POST, RULES, "POST", "/api/commercial/rules", { ...RULE_BODY, notes: "TRÊS FAIXAS" });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  // Mesma vigência de novo → 409.
  const clash = await callRoute(rulesRoute.POST, RULES, "POST", "/api/commercial/rules", RULE_BODY);
  assert.equal(clash.status, 409);
  assert.match((await clash.json()).error, /12\/2026/);

  const edited = await callRoute(rulesRoute.PUT, RULES, "PUT", "/api/commercial/rules", { ...RULE_BODY, id, creditRateBps: 250, notes: "TRÊS FAIXAS" });
  assert.equal(edited.status, 200);
  // Editar para o mês de outra vigência → 409; id inexistente → 404.
  assert.equal((await callRoute(rulesRoute.PUT, RULES, "PUT", "/api/commercial/rules", { ...RULE_BODY, id, validFrom: "2026-10" })).status, 409);
  assert.equal((await callRoute(rulesRoute.PUT, RULES, "PUT", "/api/commercial/rules", { ...RULE_BODY, id: "nao-existe" })).status, 404);

  const list = await (await callRoute(rulesRoute.GET, RULES, "GET", "/api/commercial/rules")).json();
  assert.equal(list.canManage, true);
  assert.deepEqual(list.items.map((rule) => rule.validFrom), ["2026-12", "2026-10"]);
  assert.equal(list.items[0].creditRateBps, 250);
  assert.equal(list.items[0].premiumTiers.length, 3);
  assert.equal(list.items[0].notes, "TRÊS FAIXAS");
  assert.equal(list.items[0].updatedByName, "U-RULES");
});

test("overview: setembro na regra padrão (4%), outubro na seed (6% + crediário 2%), dezembro na vigência nova", async () => {
  await importSheet("2026-09", true);
  await importSheet("2026-10", true);
  await importSheet("2026-12", true);

  const sept = await sellersOf(ADMIN, "2026-09");
  assert.equal(sept.rules.warrantyRateBps, 400);
  assert.equal(sept.rules.creditRateBps, 0);
  const anaSept = byId(sept, "emp-ana");
  assert.equal(anaSept.realized.creditSalesCents, 2_000_000);
  assert.equal(anaSept.newcomer, false);
  assert.equal(anaSept.metrics.commission.warrantyCommissionCents, 4_000); // 4% de R$ 1.000
  assert.equal(anaSept.metrics.commission.creditCommissionCents, 0);
  // Regra sem crediário: o faturado inteiro na base (setembro não muda).
  assert.equal(anaSept.metrics.commission.revenueCommissionCents, 72_000); // 0,6% de R$ 120.000

  const oct = await sellersOf(ADMIN, "2026-10");
  assert.equal(oct.rules.validFrom, "2026-10");
  const ana = byId(oct, "emp-ana").metrics.commission;
  assert.equal(ana.warrantyCommissionCents, 6_000); // 6% de R$ 1.000
  assert.equal(ana.creditCommissionCents, 40_000); // 2% de R$ 20.000
  assert.equal(ana.revenueCommissionCents, 60_000);
  assert.equal(ana.revenuePremiumCents, 150_000); // 120% pelo faturado total
  assert.equal(ana.totalCents, 60_000 + 150_000 + 6_000 + 40_000);

  const dec = await sellersOf(ADMIN, "2026-12");
  assert.equal(dec.rules.validFrom, "2026-12");
  const anaDec = byId(dec, "emp-ana").metrics;
  assert.equal(anaDec.commission.revenuePremiumCents, 90_000); // 120% → faixa de 115%
  assert.equal(anaDec.commission.creditCommissionCents, 50_000); // 2,5% de R$ 20.000
  assert.equal(anaDec.warranty.attachTarget, 25);

  // Sem comercial:commission: nada em R$ da comissão, mas o crediário feito
  // (realizado) e o novato continuam.
  const plain = await sellersOf(DASHBOARD, "2026-10");
  assert.deepEqual(byId(plain, "emp-ana").metrics.commission, { allCriteriaMet: true, revenueRateBps: 60, newcomer: false });
  assert.equal(byId(plain, "emp-ana").realized.creditSalesCents, 2_000_000);
  assert.doesNotMatch(JSON.stringify(plain.sellers), /CommissionCents|PremiumCents|totalCents/);
  assert.equal(plain.canMarkNewcomer, false);
});

test("planilha sem a coluna CREDIÁRIO: crediário 0 e faturamento inteiro na base", async () => {
  await importSheet("2026-11", false);
  const ana = byId(await sellersOf(ADMIN, "2026-11"), "emp-ana");
  assert.equal(ana.realized.creditSalesCents, 0);
  assert.equal(ana.metrics.commission.revenueBaseCents, 12_000_000);
  assert.equal(ana.metrics.commission.creditCommissionCents, 0);
});

test("novatos: permissão, escopo de loja, só no mês marcado e sobrevive à reimportação", async () => {
  const mark = (user, body) => callRoute(newcomersRoute.PUT, user, "PUT", "/api/commercial/newcomers", body);
  for (const user of [DASHBOARD, COMMISSION, SELLER_ANA]) {
    assert.equal((await mark(user, { employeeId: "emp-ana", month: "2026-10", newcomer: true })).status, 403);
  }
  assert.equal((await mark(RULES, { employeeId: "emp-ana", month: "2026-1", newcomer: true })).status, 400);
  assert.equal((await mark(RULES, { employeeId: "emp-ana", month: "2026-10", newcomer: "sim" })).status, 400);
  // Gestor da LOJA ALFA não marca vendedor da LOJA BETA (mesmo 404 de inexistente).
  assert.equal((await mark(GOALS_A, { employeeId: "emp-carla", month: "2026-10", newcomer: true })).status, 404);
  assert.equal((await mark(GOALS_A, { employeeId: "nao-existe", month: "2026-10", newcomer: true })).status, 404);

  assert.equal((await mark(GOALS_A, { employeeId: "emp-ana", month: "2026-10", newcomer: true })).status, 200);
  // Repetir não duplica.
  assert.equal((await mark(GOALS_A, { employeeId: "emp-ana", month: "2026-10", newcomer: true })).status, 200);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM commercial_newcomers").get().n, 1);

  const check = async () => {
    const oct = await sellersOf(ADMIN, "2026-10");
    assert.equal(oct.canMarkNewcomer, true);
    const ana = byId(oct, "emp-ana");
    assert.equal(ana.newcomer, true);
    assert.deepEqual(
      [ana.metrics.commission.revenuePremiumCents, ana.metrics.commission.warrantyCommissionCents, ana.metrics.commission.creditCommissionCents],
      [0, 0, 0],
    );
    assert.equal(ana.metrics.commission.totalCents, 60_000); // só a % do faturamento
    assert.equal(byId(oct, "emp-bruno").newcomer, false);
    // Só no mês marcado.
    assert.equal(byId(await sellersOf(ADMIN, "2026-12"), "emp-ana").newcomer, false);
    // A própria vendedora vê o selo (sem poder marcar).
    const own = await sellersOf(SELLER_ANA, "2026-10");
    assert.deepEqual(own.sellers.map((seller) => seller.employeeId), ["emp-ana"]);
    assert.equal(own.sellers[0].newcomer, true);
    assert.equal(own.canMarkNewcomer, false);
  };
  await check();
  // Reimportar a planilha do mês apaga commercial_monthly, não a marcação.
  await importSheet("2026-10", true);
  await check();

  assert.equal((await mark(RULES, { employeeId: "emp-ana", month: "2026-10", newcomer: false })).status, 200);
  const ana = byId(await sellersOf(ADMIN, "2026-10"), "emp-ana");
  assert.equal(ana.newcomer, false);
  assert.equal(ana.metrics.commission.revenuePremiumCents, 150_000);
});
