import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Permissões do Comercial > Acompanhamento Metas, uma por aba:
//   comercial:dashboard  → Dashboard e Ranking (sem R$ de comissão)
//   comercial:commission → Comissão
//   comercial:goals      → Cadastro de Metas (importação da planilha)
// Carrega as rotas reais de /api/commercial trocando só o getD1() por um
// SQLite em memória (exposto via globalThis.__commercialTestEnv). A expansão
// das chaves antigas (comercial:view/manage) e o login só-Comercial são do
// Worker e ficam em tests/rendered-html.test.mjs.
const hooks = `
const DB_STUB = "export async function getD1() { return globalThis.__commercialTestEnv.DB; }";
export async function resolve(specifier, context, next) {
  if (
    (specifier === "../../../db" || specifier === "../../../../db") &&
    context.parentURL && context.parentURL.includes("/app/api/commercial/")
  ) {
    return { url: "data:text/javascript," + encodeURIComponent(DB_STUB), shortCircuit: true };
  }
  if (specifier.startsWith(".") && !/\\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.startsWith("file:")) {
    try {
      return await next(specifier + ".ts", context);
    } catch {
      // segue para a resolução normal
    }
  }
  return next(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(hooks));

const MONTH = "2026-09";

function createFakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE shared_state (state_key text PRIMARY KEY, value_json text NOT NULL);
    CREATE TABLE hr_employees (id text PRIMARY KEY, full_name text NOT NULL, company_id text, user_id text);
    CREATE TABLE commercial_imports (
      id text PRIMARY KEY, month text NOT NULL, file_name text, sheet_name text, rows_imported integer,
      rows_ignored integer, created_by_name text, created_at text
    );
    CREATE TABLE commercial_monthly (
      employee_id text NOT NULL, employee_name text NOT NULL, company_id text NOT NULL, company_name text,
      sheet_seller_name text, sheet_store_name text, zone text, month text NOT NULL,
      target_revenue_cents integer, target_items integer, target_super_items integer,
      target_warranty_cents integer, target_realme integer, revenue_cents integer, items integer,
      warranty_cents integer, realme integer, warranty_qty integer, notebook_qty integer,
      updated_at text, updated_by_name text, credit_sales_cents integer DEFAULT 0
    );
    CREATE TABLE commercial_rules (
      id text PRIMARY KEY, valid_from text, revenue_rate_high_bps integer, revenue_rate_low_bps integer,
      premium_tiers_json text, warranty_rate_bps integer, warranty_attach_target integer, credit_rate_bps integer,
      notes text, updated_by_name text, updated_at text
    );
    CREATE TABLE commercial_newcomers (id text PRIMARY KEY, employee_id text, month text);
  `);
  sqlite.prepare("INSERT INTO shared_state VALUES ('companies_list', ?)").run(
    JSON.stringify([{ id: "loja-a", name: "LOJA A" }, { id: "loja-b", name: "LOJA B" }]),
  );
  const sellers = [
    ["emp-1", "ANA VENDEDORA", "loja-a", "user-ana"],
    ["emp-2", "BRUNO VENDEDOR", "loja-a", null],
    ["emp-3", "CARLA VENDEDORA", "loja-b", null],
  ];
  for (const [id, name, companyId, userId] of sellers) {
    sqlite.prepare("INSERT INTO hr_employees VALUES (?, ?, ?, ?)").run(id, name, companyId, userId);
    sqlite.prepare(
      `INSERT INTO commercial_monthly VALUES (?, ?, ?, ?, ?, ?, 'NORTE', ?,
        10000000, 100, 120, 500000, 10, 11000000, 100, 400000, 10, 3, 10, '2026-09-20T12:00:00Z', 'GESTOR', 0)`,
    ).run(id, name, companyId, companyId.toUpperCase(), name, companyId.toUpperCase(), MONTH);
  }
  return {
    prepare(text) {
      // node:sqlite antigo (ex.: Node 22.13 do CI) não liga parâmetros
      // posicionais a placeholders "?1": converte para "?" na ordem de uso.
      const order = [];
      const sql = text.replace(/\?(\d+)/g, (_match, index) => {
        order.push(Number(index) - 1);
        return "?";
      });
      let params = [];
      const statement = {
        bind(...values) {
          params = order.length ? order.map((index) => values[index]) : values;
          return statement;
        },
        async run() {
          sqlite.prepare(sql).run(...params);
          return { success: true };
        },
        async first() {
          return sqlite.prepare(sql).get(...params) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...params) };
        },
      };
      return statement;
    },
  };
}

globalThis.__commercialTestEnv = { DB: createFakeD1() };

const overview = await import("../app/api/commercial/overview/route.ts");
const ranking = await import("../app/api/commercial/ranking/route.ts");
const importRoute = await import("../app/api/commercial/import/route.ts");

const BASE = "http://127.0.0.1/api/commercial";

function headersFor(user) {
  return {
    "x-unigames-user-id": user.id,
    "x-unigames-display-name": "TESTE",
    "x-unigames-role": user.role || "user",
    "x-unigames-company-id": user.companyId || "",
    "x-unigames-permissions": (user.permissions || []).join(","),
    "sec-fetch-site": "same-origin",
  };
}

const get = (route, user, path) => route.GET(new Request(`${BASE}${path}`, { headers: headersFor(user) }));
const postImport = (user, body) =>
  importRoute.POST(new Request(`${BASE}/import`, {
    method: "POST",
    headers: { ...headersFor(user), "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

const DASHBOARD = { id: "u-dash", permissions: ["comercial:dashboard"] };
const COMMISSION = { id: "u-com", permissions: ["comercial:commission"] };
const GOALS = { id: "u-goals", permissions: ["comercial:goals"] };
const SELLER = { id: "user-ana", companyId: "loja-a", permissions: ["comercial:dashboard", "comercial:commission"] };
const ADMIN = { id: "admin", role: "admin", permissions: [] };

test("só comercial:dashboard: overview sem comissão, ranking ok, Cadastro de Metas e importação 403", async () => {
  const response = await get(overview, DASHBOARD, `/overview?month=${MONTH}`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.sellers.length, 3);
  assert.deepEqual([data.canDashboard, data.canCommission, data.canGoals], [true, false, false]);
  assert.equal("canManage" in data, false);
  for (const seller of data.sellers) {
    // Selo do Dashboard igual para todos: critérios e taxa, sem R$.
    assert.deepEqual(seller.metrics.commission, { allCriteriaMet: true, revenueRateBps: 60, newcomer: false });
    assert.ok(seller.metrics.revenue && seller.metrics.items && seller.metrics.warranty);
  }
  assert.doesNotMatch(JSON.stringify(data), /CommissionCents|PremiumCents|totalCents/);

  assert.equal((await get(ranking, DASHBOARD, `/ranking?month=${MONTH}`)).status, 200);
  const cadastro = await get(overview, DASHBOARD, `/overview?month=${MONTH}&for=cadastro`);
  assert.equal(cadastro.status, 403);
  assert.equal((await cadastro.json()).error, "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR METAS.");
  assert.equal((await get(importRoute, DASHBOARD, `/import?month=${MONTH}`)).status, 403);
  assert.equal((await postImport(DASHBOARD, { month: MONTH })).status, 403);
});

test("só comercial:commission: overview com a comissão, ranking 403", async () => {
  const response = await get(overview, COMMISSION, `/overview?month=${MONTH}`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual([data.canDashboard, data.canCommission, data.canGoals], [false, true, false]);
  for (const seller of data.sellers) assert.equal(typeof seller.metrics.commission.totalCents, "number");

  const rank = await get(ranking, COMMISSION, `/ranking?month=${MONTH}`);
  assert.equal(rank.status, 403);
  assert.equal((await rank.json()).error, "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O COMERCIAL.");
  assert.equal((await get(overview, COMMISSION, `/overview?month=${MONTH}&for=cadastro`)).status, 403);
});

test("só comercial:goals: Cadastro de Metas e importação liberados, Dashboard/Comissão/Ranking 403", async () => {
  const cadastro = await get(overview, GOALS, `/overview?month=${MONTH}&for=cadastro`);
  assert.equal(cadastro.status, 200);
  const data = await cadastro.json();
  assert.equal(data.sellers.length, 3);
  assert.equal(data.canGoals, true);
  // Sem comercial:commission a comissão também não sai pelo Cadastro de Metas.
  for (const seller of data.sellers) assert.equal("totalCents" in seller.metrics.commission, false);

  assert.equal((await get(importRoute, GOALS, `/import?month=${MONTH}`)).status, 200);
  // Passa da guarda de permissão (cai na validação do mês).
  const posted = await postImport(GOALS, { month: "x" });
  assert.equal(posted.status, 400);
  assert.equal((await posted.json()).error, "MÊS INVÁLIDO.");

  const plain = await get(overview, GOALS, `/overview?month=${MONTH}`);
  assert.equal(plain.status, 403);
  assert.equal((await plain.json()).error, "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O COMERCIAL.");
  assert.equal((await get(ranking, GOALS, `/ranking?month=${MONTH}`)).status, 403);
});

test("vendedor vinculado (dashboard + commission): só os próprios números, com a própria comissão", async () => {
  const response = await get(overview, SELLER, `/overview?month=${MONTH}`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ownOnly, true);
  assert.equal(data.allStores, false);
  assert.deepEqual(data.sellers.map((seller) => seller.employeeId), ["emp-1"]);
  assert.equal(typeof data.sellers[0].metrics.commission.totalCents, "number");

  // Ranking: empresa inteira, só percentuais.
  const rank = await (await get(ranking, SELLER, `/ranking?month=${MONTH}`)).json();
  assert.equal(rank.items.length, 3);
  assert.doesNotMatch(JSON.stringify(rank), /Cents|commission/);
});

test("sem nenhuma permissão do Comercial: tudo 403; admin vê tudo", async () => {
  const none = { id: "u-none", permissions: ["tasks:view"] };
  assert.equal((await get(overview, none, `/overview?month=${MONTH}`)).status, 403);
  assert.equal((await get(ranking, none, `/ranking?month=${MONTH}`)).status, 403);
  assert.equal((await get(importRoute, none, `/import?month=${MONTH}`)).status, 403);

  const data = await (await get(overview, ADMIN, `/overview?month=${MONTH}`)).json();
  assert.deepEqual([data.canDashboard, data.canCommission, data.canGoals], [true, true, true]);
  assert.equal(typeof data.sellers[0].metrics.commission.totalCents, "number");
});
