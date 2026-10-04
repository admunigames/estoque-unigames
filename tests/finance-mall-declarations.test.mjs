import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Financeiro 1/9 — Declaração de Vendas (ex-"Declaração de Shopping"):
// fórmulas (sugerido = mínimo ÷ %, aluguel % = máx(0, declarado × % − mínimo)),
// mesma conta no front e no back, faturamento puxado de finance_store_revenue,
// cadastro em lote e ações em lote. Rotas reais de app/api com o getD1()
// trocado por um SQLite em memória (mesmo esquema de tests/store-scope.test.mjs).
const hooks = `
const DB_STUB = "export async function getD1() { return globalThis.__mallTestDb; }";
const CF_STUB = "export const env = { get UPLOADS() { return globalThis.__mallTestBucket; } };";
export async function resolve(specifier, context, next) {
  if (/^(\\.\\.\\/)+db$/.test(specifier) && context.parentURL && context.parentURL.includes("/app/api/")) {
    return { url: "data:text/javascript," + encodeURIComponent(DB_STUB), shortCircuit: true };
  }
  if (specifier === "cloudflare:workers") {
    return { url: "data:text/javascript," + encodeURIComponent(CF_STUB), shortCircuit: true };
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

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
  CREATE TABLE finance_store_revenue (id TEXT PRIMARY KEY, store_id TEXT, month TEXT, amount_cents INTEGER DEFAULT 0);
  CREATE TABLE finance_mall_declarations (
    id TEXT PRIMARY KEY, mall_name TEXT NOT NULL DEFAULT '', company_id TEXT NOT NULL DEFAULT '',
    company_name TEXT NOT NULL DEFAULT '', competence_month TEXT NOT NULL,
    real_revenue_cents INTEGER NOT NULL DEFAULT 0, avg_declared_cents INTEGER NOT NULL DEFAULT 0,
    suggested_declared_cents INTEGER NOT NULL DEFAULT 0, declared_cents INTEGER NOT NULL DEFAULT 0,
    declaration_date TEXT NOT NULL DEFAULT '', contract_percent_bps INTEGER NOT NULL DEFAULT 0,
    minimum_rent_cents INTEGER NOT NULL DEFAULT 0, percentage_rent_cents INTEGER NOT NULL DEFAULT 0,
    percentage_rent_paid INTEGER NOT NULL DEFAULT 0, amount_paid_cents INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_by_name TEXT NOT NULL DEFAULT '',
    created_at TEXT, updated_by TEXT NOT NULL DEFAULT '', updated_by_name TEXT NOT NULL DEFAULT '', updated_at TEXT
  );
  CREATE UNIQUE INDEX finance_mall_declarations_unique ON finance_mall_declarations (company_id, mall_name, competence_month);
  CREATE TABLE finance_mall_declaration_attachments (id TEXT PRIMARY KEY, declaration_id TEXT, r2_key TEXT);
`);

function statement(text) {
  const order = [];
  const sql = text.replace(/\?(\d+)/g, (_match, index) => {
    order.push(Number(index) - 1);
    return "?";
  });
  let params = [];
  const prepared = {
    bind(...values) {
      params = order.length ? order.map((index) => values[index]) : values;
      return prepared;
    },
    execute() {
      return sqlite.prepare(sql).run(...params);
    },
    async run() {
      prepared.execute();
      return { success: true };
    },
    async first() {
      return sqlite.prepare(sql).get(...params) ?? null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...params) };
    },
  };
  return prepared;
}

const deletedKeys = [];
globalThis.__mallTestBucket = { async delete(keys) { deletedKeys.push(...[].concat(keys)); } };
globalThis.__mallTestDb = {
  prepare: statement,
  async batch(statements) {
    sqlite.exec("BEGIN");
    try {
      for (const item of statements) item.execute();
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
    return statements.map(() => ({ success: true }));
  },
};

const mall = await import("../app/lib/mall-declarations.ts");
const route = await import("../app/api/finance/mall-declarations/route.ts");
const batch = await import("../app/api/finance/mall-declarations/batch/route.ts");
const bulk = await import("../app/api/finance/mall-declarations/bulk/route.ts");

const ADMIN = { id: "admin", role: "admin", permissions: [] };
const FINANCE = { id: "fin", role: "user", permissions: ["finance:manage"] };
const NO_FINANCE = { id: "loja", role: "user", permissions: ["outputs:view"] };

function call(handler, user, method, path, body) {
  return handler(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers: {
        "x-unigames-user-id": user.id,
        "x-unigames-display-name": user.id.toUpperCase(),
        "x-unigames-role": user.role,
        "x-unigames-permissions": user.permissions.join(","),
        "sec-fetch-site": "same-origin",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
const rowOf = (id) => sqlite.prepare("SELECT * FROM finance_mall_declarations WHERE id=?").get(id);

// ---------------------------------------------------------------------------
// Função pura
// ---------------------------------------------------------------------------
test("sugerido = mínimo ÷ % (arredondado para baixo) e aluguel % = máx(0, declarado × % − mínimo)", () => {
  const base = { realRevenueCents: 0, contractPercentBps: 700, minimumRentCents: 700_000 };
  assert.equal(mall.deriveMallDeclaration({ ...base, declaredCents: 0 }).breakpointCents, 10_000_000);
  // R$ 1.000,00 ÷ 3% = 33.333,333… → 33.333,33 (para baixo).
  assert.equal(mall.deriveMallDeclaration({ ...base, contractPercentBps: 300, minimumRentCents: 100_000, declaredCents: 0 }).breakpointCents, 3_333_333);
  assert.equal(mall.deriveMallDeclaration({ ...base, declaredCents: 12_000_000 }).percentageRentCents, 140_000);
  assert.equal(mall.deriveMallDeclaration({ ...base, declaredCents: 5_000_000 }).percentageRentCents, 0);
});

test("declarar exatamente o sugerido zera o aluguel percentual", () => {
  for (const [bps, min] of [[700, 700_000], [300, 100_000], [650, 1_234_567], [1, 1], [9999, 50_001]]) {
    const { breakpointCents } = mall.deriveMallDeclaration({ realRevenueCents: 0, declaredCents: 0, contractPercentBps: bps, minimumRentCents: min });
    const d = mall.deriveMallDeclaration({ realRevenueCents: 0, declaredCents: breakpointCents, contractPercentBps: bps, minimumRentCents: min });
    assert.equal(d.percentageRentCents, 0, `${bps} bps / ${min}`);
    assert.equal(d.alertLevel, "none");
  }
});

test("sem percentual não há sugestão, aluguel % nem alerta", () => {
  const d = mall.deriveMallDeclaration({ realRevenueCents: 99_999_999, declaredCents: 99_999_999, contractPercentBps: 0, minimumRentCents: 700_000 });
  assert.equal(d.breakpointCents, 0);
  assert.equal(d.percentageRentCents, 0);
  assert.equal(d.alertLevel, "none");
});

test("o front (declShoppingDerive) faz a mesma conta da função pura", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  const start = html.indexOf("function declShoppingDerive(");
  assert.notEqual(start, -1);
  let depth = 0;
  let end = html.indexOf("{", start);
  for (; end < html.length; end++) {
    if (html[end] === "{") depth++;
    if (html[end] === "}" && --depth === 0) break;
  }
  const front = new Function(`${html.slice(start, end + 1)}; return declShoppingDerive;`)();
  for (const real of [0, 9_000_000, 12_000_000]) {
    for (const declared of [0, 3_333_333, 3_333_334, 10_000_000, 10_000_001]) {
      for (const [bps, min] of [[0, 0], [700, 700_000], [300, 100_000], [700, 0]]) {
        const input = { realRevenueCents: real, declaredCents: declared, contractPercentBps: bps, minimumRentCents: min };
        const back = mall.deriveMallDeclaration(input);
        const got = front(input);
        assert.deepEqual(
          [got.breakpointCents, got.percentageRentCents, got.alertLevel],
          [back.breakpointCents, back.percentageRentCents, back.alertLevel],
          JSON.stringify(input),
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
test("sem finance:manage recebe 403 em todas as rotas", async () => {
  assert.equal((await call(route.GET, NO_FINANCE, "GET", "/api/finance/mall-declarations")).status, 403);
  assert.equal((await call(route.POST, NO_FINANCE, "POST", "/api/finance/mall-declarations", {})).status, 403);
  assert.equal((await call(batch.GET, NO_FINANCE, "GET", "/api/finance/mall-declarations/batch?month=2026-09")).status, 403);
  assert.equal((await call(batch.POST, NO_FINANCE, "POST", "/api/finance/mall-declarations/batch", {})).status, 403);
  assert.equal((await call(bulk.POST, NO_FINANCE, "POST", "/api/finance/mall-declarations/bulk", {})).status, 403);
  assert.equal((await call(route.GET, FINANCE, "GET", "/api/finance/mall-declarations")).status, 200);
});

test("faturamento real é puxado de finance_store_revenue quando vem vazio; sugerido e aluguel % são recalculados", async () => {
  sqlite.prepare("INSERT INTO finance_store_revenue (id, store_id, month, amount_cents) VALUES ('r1','lojaA','2026-08',12000000)").run();
  const res = await call(route.POST, ADMIN, "POST", "/api/finance/mall-declarations", {
    companyId: "lojaA", companyName: "LOJA A", competenceMonth: "2026-08", declaredCents: 11_000_000,
    contractPercentBps: 700, minimumRentCents: 700_000, suggestedDeclaredCents: 1, percentageRentCents: 1,
    mallName: "IGNORADO", amountPaidCents: 999,
  });
  assert.equal(res.status, 201);
  const row = rowOf((await res.json()).id);
  assert.equal(row.real_revenue_cents, 12_000_000);
  assert.equal(row.suggested_declared_cents, 10_000_000);
  assert.equal(row.percentage_rent_cents, 70_000);
  assert.equal(row.mall_name, "");
  assert.equal(row.amount_paid_cents, 0);

  // Mesma loja/competência de novo → 409 (índice vira loja + competência).
  const dup = await call(route.POST, ADMIN, "POST", "/api/finance/mall-declarations", { companyId: "lojaA", competenceMonth: "2026-08" });
  assert.equal(dup.status, 409);

  // Sem faturamento cadastrado: vale o digitado. Sem percentual: mínimo zera.
  const typed = await call(route.POST, ADMIN, "POST", "/api/finance/mall-declarations", {
    companyId: "lojaB", competenceMonth: "2026-08", realRevenueCents: 5_000_000, declaredCents: 4_000_000, minimumRentCents: 500_000,
  });
  const typedRow = rowOf((await typed.json()).id);
  assert.equal(typedRow.real_revenue_cents, 5_000_000);
  assert.equal(typedRow.minimum_rent_cents, 0);
  assert.equal(typedRow.suggested_declared_cents, 0);
});

test("registro antigo com shopping continua editável sem perder o shopping", async () => {
  sqlite.prepare(`INSERT INTO finance_mall_declarations (id, mall_name, company_id, competence_month, declared_cents)
    VALUES ('old1','RIOMAR','lojaC','2026-01',100), ('old2','TACARUNA','lojaC','2026-01',200)`).run();
  const res = await call(route.POST, ADMIN, "POST", "/api/finance/mall-declarations", { id: "old1", companyId: "lojaC", competenceMonth: "2026-01", declaredCents: 150 });
  assert.equal(res.status, 200);
  assert.equal(rowOf("old1").mall_name, "RIOMAR");
  assert.equal(rowOf("old1").declared_cents, 150);
});

test("contexto do mês: faturamento, declaração existente e % / mínimo da última declaração", async () => {
  const res = await call(batch.GET, FINANCE, "GET", "/api/finance/mall-declarations/batch?month=2026-09");
  const { stores } = await res.json();
  assert.equal(stores.lojaA.existingId, "");
  assert.equal(stores.lojaA.lastContractPercentBps, 700);
  assert.equal(stores.lojaA.lastMinimumRentCents, 700_000);
  const aug = await (await call(batch.GET, FINANCE, "GET", "/api/finance/mall-declarations/batch?month=2026-08")).json();
  assert.equal(aug.stores.lojaA.revenueCents, 12_000_000);
  assert.ok(aug.stores.lojaA.existingId);
  assert.equal(aug.stores.lojaB.revenueCents, null);
});

test("lote cria só as lojas sem declaração no mês e pula as existentes / sem declarado", async () => {
  sqlite.prepare("INSERT INTO finance_store_revenue (id, store_id, month, amount_cents) VALUES ('r2','lojaD','2026-08',8000000)").run();
  const res = await call(batch.POST, FINANCE, "POST", "/api/finance/mall-declarations/batch", {
    competenceMonth: "2026-08",
    rows: [
      { companyId: "lojaA", companyName: "LOJA A", declaredCents: 1 },
      { companyId: "lojaD", companyName: "LOJA D", realRevenueCents: 1, contractPercentBps: 500, minimumRentCents: 300_000, declaredCents: 6_000_000 },
      { companyId: "lojaE", companyName: "LOJA E", realRevenueCents: 2_000_000, declaredCents: 1_500_000, notes: "OBS" },
      { companyId: "lojaF", companyName: "LOJA F", declaredCents: "" },
      { companyId: "lojaE", companyName: "LOJA E", declaredCents: 1 },
    ],
  });
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.equal(out.created, 2);
  assert.deepEqual(out.skipped.map((s) => [s.companyId, s.reason]), [
    ["lojaA", "JÁ CADASTRADA NO MÊS"],
    ["lojaF", "SEM VALOR DECLARADO"],
    ["lojaE", "LOJA REPETIDA NO LOTE"],
  ]);
  const d = sqlite.prepare("SELECT * FROM finance_mall_declarations WHERE company_id='lojaD'").get();
  assert.equal(d.real_revenue_cents, 8_000_000); // cadastrado vence o digitado
  assert.equal(d.suggested_declared_cents, 6_000_000);
  assert.equal(d.percentage_rent_cents, 0);
  const e = sqlite.prepare("SELECT * FROM finance_mall_declarations WHERE company_id='lojaE'").get();
  assert.equal(e.real_revenue_cents, 2_000_000);
  assert.equal(e.notes, "OBS");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM finance_mall_declarations WHERE company_id='lojaA'").get().n, 1);
});

test("ações em lote: marcar/desmarcar pago e excluir (com anexos); id inexistente não altera nada", async () => {
  const ids = sqlite.prepare("SELECT id FROM finance_mall_declarations WHERE competence_month='2026-08' ORDER BY id").all().map((r) => r.id);
  assert.equal(ids.length, 4);
  let res = await call(bulk.POST, FINANCE, "POST", "/api/finance/mall-declarations/bulk", { action: "mark-paid", ids });
  assert.equal((await res.json()).updated, 4);
  assert.ok(ids.every((id) => rowOf(id).percentage_rent_paid === 1));
  res = await call(bulk.POST, FINANCE, "POST", "/api/finance/mall-declarations/bulk", { action: "unmark-paid", ids: [ids[0]] });
  assert.equal(rowOf(ids[0]).percentage_rent_paid, 0);

  res = await call(bulk.POST, FINANCE, "POST", "/api/finance/mall-declarations/bulk", { action: "delete", ids: [ids[0], "nao-existe"] });
  assert.equal(res.status, 404);
  assert.ok(rowOf(ids[0]));
  assert.equal((await call(bulk.POST, FINANCE, "POST", "/api/finance/mall-declarations/bulk", { action: "sumir", ids })).status, 400);

  sqlite.prepare("INSERT INTO finance_mall_declaration_attachments (id, declaration_id, r2_key) VALUES ('a1', ?, 'k1')").run(ids[1]);
  res = await call(bulk.POST, FINANCE, "POST", "/api/finance/mall-declarations/bulk", { action: "delete", ids: ids.slice(0, 2) });
  assert.equal((await res.json()).deleted, 2);
  assert.equal(rowOf(ids[0]), undefined);
  assert.equal(rowOf(ids[1]), undefined);
  assert.ok(rowOf(ids[2]));
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM finance_mall_declaration_attachments").get().n, 0);
  assert.deepEqual(deletedKeys, ["k1"]);
});
