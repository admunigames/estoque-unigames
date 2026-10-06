import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Comercial — regras de comissão por vigência (comercial:rules), NOVATO no
// mês (Dashboard) e as abas de atualização manual e ao vivo: Vendedores
// (comercial:goals), Crediários (comercial:credit) e Meta Loja
// (comercial:stores). Rotas reais sobre SQLite, com os seeds das migrations
// 0085 e 0086.

const db = await setupRouteDb([
  "shared_state", "hr_employees", "commercial_monthly", "commercial_rules", "commercial_newcomers",
  "commercial_credit_entries", "commercial_store_goals",
]);
const migration = await readFile(new URL("../drizzle/0085_comercial_regras.sql", import.meta.url), "utf8");
const migration0086 = await readFile(new URL("../drizzle/0086_comercial_lancamentos.sql", import.meta.url), "utf8");
const statements = (sql) => sql.split("--> statement-breakpoint").map((part) => part.trim());
const seed = statements(migration).filter((part) => part.startsWith("INSERT INTO"));
assert.equal(seed.length, 1, "a migration tem um INSERT de seed");
db.sqlite.exec(seed[0]);
// 0086: % da venda P.A/Unigames = 2% na vigência 2026-10 (as colunas já vêm do schema).
db.sqlite.exec(statements(migration0086).find((part) => part.startsWith("UPDATE")));

const rulesRoute = await import("../app/api/commercial/rules/route.ts");
const newcomersRoute = await import("../app/api/commercial/newcomers/route.ts");
const overview = await import("../app/api/commercial/overview/route.ts");
const sellersRoute = await import("../app/api/commercial/sellers/route.ts");
const entriesRoute = await import("../app/api/commercial/entries/route.ts");
const storesRoute = await import("../app/api/commercial/stores/route.ts");
const rankingRoute = await import("../app/api/commercial/ranking/route.ts");

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
const SELLER_ANA_GOALS = { ...SELLER_ANA, permissions: [...SELLER_ANA.permissions, "comercial:goals"] };
const CREDIT_A = { id: "u-cred-a", companyId: STORE_A, permissions: ["comercial:credit"] };
const STORES = { id: "u-stores", permissions: ["comercial:stores", "comercial:dashboard"] };
const STORES_B = { id: "u-stores-b", companyId: STORE_B, permissions: ["comercial:stores"] };

// Todos batem os critérios: itens 100/100, realme 10/10, anexo 3 de 10.
const ROWS = {
  "emp-ana": { revenueCents: 12_000_000, warrantyCents: 100_000 },
  "emp-bruno": { revenueCents: 5_000_000, warrantyCents: 0 },
  "emp-carla": { revenueCents: 8_000_000, warrantyCents: 0 },
};
const sellerBody = (month, employeeId, values = {}) => ({
  month, employeeId, zone: employeeId === "emp-carla" ? "NORTE" : "SUL",
  targetRevenueCents: 10_000_000, targetItems: 100, targetSuperItems: 120, targetWarrantyCents: 0, targetRealme: 10,
  items: 100, realme: 10, warrantyQty: 3, notebookQty: 10, salesQty: 40, ...ROWS[employeeId], ...values,
});
const putSeller = (user, body) => callRoute(sellersRoute.PUT, user, "PUT", "/api/commercial/sellers", body);
const postEntry = (user, body) => callRoute(entriesRoute.POST, user, "POST", "/api/commercial/entries", body);
// Lança o mês à mão (aba Vendedores) e o crediário da Ana (R$ 20.000 em
// PAYJOY + CREFAZ) e da Carla (R$ 5.000 em ODRES).
async function seedMonth(month, withCredit = true) {
  for (const employeeId of Object.keys(ROWS)) {
    const response = await putSeller(ADMIN, sellerBody(month, employeeId));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  }
  if (!withCredit) return;
  for (const [kind, employeeId, amountCents] of [["payjoy", "emp-ana", 1_500_000], ["crefaz", "emp-ana", 500_000], ["odres", "emp-carla", 500_000]]) {
    const response = await postEntry(ADMIN, { month, kind, saleRef: `${month}-${kind}`, employeeId, amountCents });
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  }
}
async function sellersOf(user, month) {
  const response = await callRoute(overview.GET, user, "GET", `/api/commercial/overview?month=${month}`);
  assert.equal(response.status, 200);
  return response.json();
}
const byId = (data, id) => data.sellers.find((seller) => seller.employeeId === id);

const RULE_BODY = {
  validFrom: "2026-12", revenueRateHighBps: 70, revenueRateLowBps: 30, warrantyRateBps: 500,
  warrantyAttachTarget: 25, creditRateBps: 300, partnerSaleRateBps: 100,
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
      warrantyRateBps: 600, warrantyAttachTarget: 30, creditRateBps: 200, partnerSaleRateBps: 200, updatedByName: "SISTEMA",
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
  for (const table of ["commercial_credit_entries", "commercial_store_goals"]) {
    assert.match(migration0086, new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`));
    assert.match(migration0086, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(migration0086, /ADD COLUMN IF NOT EXISTS "sales_qty"/);
  assert.match(migration0086, /ADD COLUMN IF NOT EXISTS "partner_sale_rate_bps"/);
  assert.doesNotMatch(migration0086, /DROP|DELETE/);
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
  assert.equal(list.items[0].partnerSaleRateBps, 100);
});

test("overview: setembro na regra padrão (4%), outubro na seed (6% + crediário 2%), dezembro na vigência nova", async () => {
  await seedMonth("2026-09");
  await seedMonth("2026-10");
  await seedMonth("2026-12");

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

test("mês sem crediário lançado: crediário 0 e faturamento inteiro na base", async () => {
  await seedMonth("2026-11", false);
  const ana = byId(await sellersOf(ADMIN, "2026-11"), "emp-ana");
  assert.equal(ana.realized.creditSalesCents, 0);
  assert.equal(ana.metrics.commission.revenueBaseCents, 12_000_000);
  assert.equal(ana.metrics.commission.creditCommissionCents, 0);
});

test("novatos: permissão, escopo de loja, só no mês marcado e sobrevive a tirar/recolocar o vendedor", async () => {
  const mark = (user, body) => callRoute(newcomersRoute.PUT, user, "PUT", "/api/commercial/newcomers", body);
  for (const user of [DASHBOARD, COMMISSION, SELLER_ANA]) {
    assert.equal((await mark(user, { employeeId: "emp-ana", month: "2026-10", newcomer: true })).status, 403);
  }
  // Conta de vendedor com Cadastro de Metas: não marca nem a si nem a outro.
  for (const employeeId of ["emp-ana", "emp-bruno"]) {
    const response = await mark(SELLER_ANA_GOALS, { employeeId, month: "2026-10", newcomer: true });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "CONTA DE VENDEDOR NÃO PODE MARCAR NOVATOS.");
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
    // A própria vendedora NÃO fica sabendo que é novata (nem com a permissão
    // de Cadastro de Metas): newcomer some da resposta, os valores são os reais.
    for (const user of [SELLER_ANA, SELLER_ANA_GOALS]) {
      const own = await sellersOf(user, "2026-10");
      assert.deepEqual(own.sellers.map((seller) => seller.employeeId), ["emp-ana"]);
      assert.equal(own.sellers[0].newcomer, false);
      assert.equal(own.sellers[0].metrics.commission.newcomer, false);
      assert.equal(own.canMarkNewcomer, false);
      assert.doesNotMatch(JSON.stringify(own), /"newcomer":true/);
    }
    assert.equal(byId(await sellersOf(SELLER_ANA, "2026-10"), "emp-ana").metrics.commission.totalCents, 60_000);
  };
  await check();
  // Tirar a vendedora do mês e lançar de novo não perde a marcação.
  assert.equal((await callRoute(sellersRoute.DELETE, ADMIN, "DELETE", "/api/commercial/sellers?month=2026-10&employeeId=emp-ana")).status, 200);
  assert.equal((await putSeller(ADMIN, sellerBody("2026-10", "emp-ana"))).status, 200);
  await check();

  assert.equal((await mark(RULES, { employeeId: "emp-ana", month: "2026-10", newcomer: false })).status, 200);
  const ana = byId(await sellersOf(ADMIN, "2026-10"), "emp-ana");
  assert.equal(ana.newcomer, false);
  assert.equal(ana.metrics.commission.revenuePremiumCents, 150_000);
});

test("Vendedores (comercial:goals): lança metas e realizado à mão, no escopo de loja", async () => {
  for (const user of [DASHBOARD, COMMISSION, CREDIT_A, RULES]) {
    assert.equal((await putSeller(user, sellerBody("2027-01", "emp-ana"))).status, 403);
    assert.equal((await callRoute(sellersRoute.GET, user, "GET", "/api/commercial/sellers?month=2027-01")).status, 403);
  }
  // Funcionários para adicionar: só os da loja do gestor.
  const options = await (await callRoute(sellersRoute.GET, GOALS_A, "GET", "/api/commercial/sellers?month=2027-01")).json();
  assert.deepEqual(options.employees.map((employee) => employee.id).sort(), ["emp-ana", "emp-bruno"]);
  assert.equal(options.employees[0].isSeller, true);

  assert.equal((await putSeller(GOALS_A, sellerBody("2027-01", "emp-carla"))).status, 404);
  assert.equal((await putSeller(GOALS_A, sellerBody("2027-01", "emp-ana", { items: -1 }))).status, 400);
  assert.equal((await putSeller(GOALS_A, sellerBody("2027-01", "emp-ana", { revenueCents: 1.5 }))).status, 400);
  assert.equal((await putSeller(GOALS_A, sellerBody("2027-01", "emp-ana", { zone: "LESTE" }))).status, 400);
  assert.equal((await putSeller(GOALS_A, sellerBody("2027-13", "emp-ana"))).status, 400);

  assert.equal((await putSeller(GOALS_A, sellerBody("2027-01", "emp-ana"))).status, 200);
  // Atualizar de novo só muda a linha (um registro por vendedor/mês).
  assert.equal((await putSeller(GOALS_A, sellerBody("2027-01", "emp-ana", { items: 130, salesQty: 55 }))).status, 200);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM commercial_monthly WHERE month='2027-01'").get().n, 1);
  const ana = byId(await sellersOf(ADMIN, "2027-01"), "emp-ana");
  assert.equal(ana.realized.items, 130);
  assert.equal(ana.realized.salesQty, 55);
  assert.equal(ana.zone, "SUL");
  assert.equal(ana.metrics.items.superReached, true);

  // Copiar do mês anterior: vendedores, zona e metas; realizado zerado; quem
  // já está no mês não muda; gestor de loja só copia a própria loja.
  const copied = await callRoute(sellersRoute.POST, GOALS_A, "POST", "/api/commercial/sellers", { month: "2027-01" });
  assert.equal(copied.status, 201);
  assert.equal((await copied.json()).copied, 1); // Bruno (Ana já estava; Carla é de outra loja)
  const jan = await sellersOf(ADMIN, "2027-01");
  assert.deepEqual(jan.sellers.map((seller) => seller.employeeId).sort(), ["emp-ana", "emp-bruno"]);
  const bruno = byId(jan, "emp-bruno");
  assert.equal(bruno.goal.targetRevenueCents, 10_000_000);
  assert.equal(bruno.realized.revenueCents, 0);
  assert.equal(byId(jan, "emp-ana").realized.items, 130);
  assert.equal((await (await callRoute(sellersRoute.POST, GOALS_A, "POST", "/api/commercial/sellers", { month: "2027-01" })).json()).copied, 0);

  // Tirar do mês: escopo de loja (outra loja = 404).
  assert.equal((await callRoute(sellersRoute.DELETE, GOALS_A, "DELETE", "/api/commercial/sellers?month=2026-12&employeeId=emp-carla")).status, 404);
  assert.equal((await callRoute(sellersRoute.DELETE, GOALS_A, "DELETE", "/api/commercial/sellers?month=2027-01&employeeId=emp-bruno")).status, 200);
  assert.equal(byId(await sellersOf(ADMIN, "2027-01"), "emp-bruno"), undefined);
  // O mês anterior continua guardado (virar o mês não apaga nada).
  assert.equal(byId(await sellersOf(ADMIN, "2026-12"), "emp-bruno").realized.revenueCents, 5_000_000);
});

test("Crediários (comercial:credit): ID, vendedor e valor por tabela; somam no crediário; venda P.A/Unigames à parte", async () => {
  const body = { month: "2027-01", kind: "payjoy", saleRef: "330137", employeeId: "emp-ana", amountCents: 151_499 };
  for (const user of [DASHBOARD, COMMISSION, GOALS_A, RULES]) {
    assert.equal((await postEntry(user, body)).status, 403);
    assert.equal((await callRoute(entriesRoute.GET, user, "GET", "/api/commercial/entries?month=2027-01&kind=payjoy")).status, 403);
  }
  assert.equal((await postEntry(CREDIT_A, { ...body, kind: "boleto" })).status, 400);
  assert.equal((await postEntry(CREDIT_A, { ...body, saleRef: "" })).status, 400);
  assert.equal((await postEntry(CREDIT_A, { ...body, amountCents: 0 })).status, 400);
  // Vendedor de outra loja → 404; vendedor fora da aba Vendedores do mês → 400.
  assert.equal((await postEntry(CREDIT_A, { ...body, employeeId: "emp-carla", month: "2026-12" })).status, 404);
  const notInMonth = await postEntry(CREDIT_A, { ...body, month: "2027-02" });
  assert.equal(notInMonth.status, 400);
  assert.match((await notInMonth.json()).error, /ABA VENDEDORES/);

  assert.equal((await postEntry(CREDIT_A, body)).status, 201);
  // Mesmo ID na mesma tabela (até em outro mês) → 409; em outra tabela pode.
  const duplicate = await postEntry(CREDIT_A, { ...body, amountCents: 100 });
  assert.equal(duplicate.status, 409);
  assert.match((await duplicate.json()).error, /330137 JÁ FOI LANÇADA EM PAYJOY \(01\/2027\)/);
  assert.equal((await postEntry(CREDIT_A, { ...body, kind: "parcelex", amountCents: 100_001 })).status, 201);
  assert.equal((await postEntry(CREDIT_A, { ...body, kind: "venda_pa", saleRef: "35032", amountCents: 243_998 })).status, 201);
  assert.equal((await postEntry(ADMIN, { ...body, kind: "venda_unigames", saleRef: "9", amountCents: 2 })).status, 201);

  const list = await (await callRoute(entriesRoute.GET, CREDIT_A, "GET", "/api/commercial/entries?month=2027-01&kind=payjoy")).json();
  assert.equal(list.label, "PAYJOY");
  assert.deepEqual(list.items.map((item) => [item.saleRef, item.employeeName, item.amountCents]), [["330137", "ANA SOUZA", 151_499]]);
  assert.equal(list.totalCents, 151_499);

  // Overview: crediário = PAYJOY + PARCELEX; venda P.A/Unigames separada.
  const ana = byId(await sellersOf(ADMIN, "2027-01"), "emp-ana");
  assert.equal(ana.realized.creditSalesCents, 151_499 + 100_001);
  assert.equal(ana.realized.partnerSalesCents, 243_998 + 2);
  // Janeiro/2027 está na vigência 12/2026: crediário 2,5% e venda P.A/Unigames 1%.
  assert.equal(ana.metrics.commission.creditCommissionCents, Math.round(251_500 * 0.025));
  assert.equal(ana.metrics.commission.partnerCommissionCents, Math.round(244_000 * 0.01));

  // Escopo: lançamento de outra loja some da lista e não pode ser excluído.
  const carlaEntry = db.sqlite.prepare("SELECT id FROM commercial_credit_entries WHERE employee_id='emp-carla' LIMIT 1").get();
  assert.equal((await callRoute(entriesRoute.DELETE, CREDIT_A, "DELETE", `/api/commercial/entries?id=${carlaEntry.id}`)).status, 404);
  const odres = await (await callRoute(entriesRoute.GET, CREDIT_A, "GET", "/api/commercial/entries?month=2026-12&kind=odres")).json();
  assert.equal(odres.items.length, 0);
  const own = list.items[0];
  assert.equal((await callRoute(entriesRoute.DELETE, CREDIT_A, "DELETE", `/api/commercial/entries?id=${own.id}`)).status, 200);
  assert.equal(byId(await sellersOf(ADMIN, "2027-01"), "emp-ana").realized.creditSalesCents, 100_001);
});

test("Meta Loja (comercial:stores): todos veem só o %; quem lança vê os valores do seu alcance", async () => {
  const put = (user, body) => callRoute(storesRoute.PUT, user, "PUT", "/api/commercial/stores", body);
  for (const user of [DASHBOARD, GOALS_A, CREDIT_A]) {
    assert.equal((await put(user, { month: "2027-01", companyId: STORE_A, targetCents: 1, revenueCents: 1 })).status, 403);
  }
  assert.equal((await put(STORES_B, { month: "2027-01", companyId: STORE_A, targetCents: 1, revenueCents: 1 })).status, 404);
  assert.equal((await put(STORES, { month: "2027-01", companyId: "c-nao-existe", targetCents: 1, revenueCents: 1 })).status, 404);
  assert.equal((await put(STORES, { month: "2027-01", companyId: STORE_A, targetCents: -1, revenueCents: 1 })).status, 400);

  assert.equal((await put(STORES, { month: "2027-01", companyId: STORE_A, targetCents: 50_000_000, revenueCents: 13_388_853 })).status, 200);
  assert.equal((await put(STORES_B, { month: "2027-01", companyId: STORE_B, targetCents: 36_000_000, revenueCents: 7_450_377 })).status, 200);
  // Atualizar não duplica.
  assert.equal((await put(STORES, { month: "2027-01", companyId: STORE_A, targetCents: 50_000_000, revenueCents: 15_000_000 })).status, 200);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM commercial_store_goals").get().n, 2);

  // Painel visual: qualquer permissão do Comercial (até o vendedor), só %.
  for (const user of [DASHBOARD, SELLER_ANA, GOALS_A]) {
    const response = await callRoute(storesRoute.GET, user, "GET", "/api/commercial/stores?month=2027-01");
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.items.map((item) => [item.name, item.percent]), [["LOJA ALFA", 30], ["LOJA BETA", 20.6]]);
    assert.equal(data.totalPercent, 26.1); // R$ 224.503,77 de R$ 860.000
    assert.doesNotMatch(JSON.stringify(data), /Cents/);
  }
  assert.equal((await callRoute(storesRoute.GET, { id: "x", permissions: ["tasks:view"] }, "GET", "/api/commercial/stores?month=2027-01")).status, 403);

  // Quem lança: valores das lojas do alcance; total em R$ só com todas.
  const all = await (await callRoute(storesRoute.GET, STORES, "GET", "/api/commercial/stores?month=2027-01")).json();
  assert.equal(all.canManage, true);
  assert.deepEqual(all.rows.map((row) => [row.companyId, row.targetCents, row.revenueCents]), [
    [STORE_A, 50_000_000, 15_000_000], [STORE_B, 36_000_000, 7_450_377],
  ]);
  assert.deepEqual(all.total, { targetCents: 86_000_000, revenueCents: 22_450_377 });
  const onlyB = await (await callRoute(storesRoute.GET, STORES_B, "GET", "/api/commercial/stores?month=2027-01")).json();
  assert.deepEqual(onlyB.rows.map((row) => row.companyId), [STORE_B]);
  assert.equal("total" in onlyB, false);
  // Mês sem metas: nada no painel.
  const empty = await (await callRoute(storesRoute.GET, DASHBOARD, "GET", "/api/commercial/stores?month=2027-05")).json();
  assert.deepEqual([empty.items, empty.totalPercent], [[], null]);
});

test("Ranking: totais de itens e realmes por loja (só quantidades, nada em R$), empresa inteira", async () => {
  // Gestor da LOJA ALFA vê o ranking da empresa toda (sempre geral).
  const response = await callRoute(rankingRoute.GET, GOALS_A, "GET", "/api/commercial/ranking?month=2026-12");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(
    data.stores.map((store) => [store.name, store.items, store.targetItems, store.realme, store.targetRealme]).sort(),
    [["LOJA ALFA", 200, 200, 20, 20], ["LOJA BETA", 100, 100, 10, 10]],
  );
  assert.equal(data.items.length, 3);
  assert.doesNotMatch(JSON.stringify(data), /Cents|commission|revenue"/);
});

test("nomes de vendedor sempre em CAIXA ALTA (cadastro do RH em minúsculas)", async () => {
  const overviewData = await sellersOf(ADMIN, "2026-12");
  assert.deepEqual(overviewData.sellers.map((seller) => seller.name).sort(), ["ANA SOUZA", "BRUNO LIMA", "CARLA DIAS"]);
  const rank = await (await callRoute(rankingRoute.GET, DASHBOARD, "GET", "/api/commercial/ranking?month=2026-12")).json();
  assert.ok(rank.items.every((item) => item.name === item.name.toLocaleUpperCase("pt-BR")));
  const options = await (await callRoute(sellersRoute.GET, ADMIN, "GET", "/api/commercial/sellers?month=2026-12")).json();
  assert.ok(options.employees.every((employee) => employee.fullName === employee.fullName.toLocaleUpperCase("pt-BR")));
});
