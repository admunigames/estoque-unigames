import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Financeiro — totais de Contas a Pagar sem canceladas (A), rateio só nas
// lojas escolhidas (B), despesa rateada como UMA linha em Contas a Pagar (C)
// e cadastro de Contas Financeiras (D). Rotas reais sobre SQLite.

const db = await setupRouteDb([
  "shared_state", "accounts_payable", "accounts_payable_payments", "expenses", "expense_rateio_shares",
  "finance_rateio_model_shares", "finance_store_revenue", "finance_store_headcount", "finance_items", "finance_categories",
  "finance_cost_centers", "finance_store_entries", "finance_accounts", "supplier_open_debts", "finance_suppliers",
]);
const lib = await import("../app/lib/rateio-distribute.ts");
const payables = await import("../app/api/finance/payables/route.ts");
const payablesBulk = await import("../app/api/finance/payables/bulk/route.ts");
const expenses = await import("../app/api/finance/expenses/route.ts");
const preview = await import("../app/api/finance/expenses/rateio-preview/route.ts");
const accounts = await import("../app/api/finance/accounts/route.ts");

const ADMIN = { id: "admin", role: "admin" };
const json = (response) => response.json();
const post = (handler, path, body) => callRoute(handler, ADMIN, "POST", path, body);
const list = async (query = "") => json(await callRoute(payables.GET, ADMIN, "GET", `/api/finance/payables?pageSize=100${query}`));

const STORES = ["criomar01", "ctacaruna1", "cshopping1", "cboaviagem", "cguararap1", "ccaruaru01", "cpetrolin1", "cfabrica01"];
db.sqlite.prepare("INSERT INTO shared_state (state_key, value_json) VALUES ('companies_list', ?)").run(
  JSON.stringify(STORES.map((id) => ({ id, name: id.slice(1).toUpperCase() }))),
);
db.insert("finance_categories", { id: "cat-1", name: "OPERACIONAL" });
db.insert("finance_items", { id: "item-1", category_id: "cat-1", name: "MARKETING" });
db.insert("finance_items", { id: "item-2", category_id: "cat-1", name: "GRÁFICA" });
// Rateio PADRÃO com as 8 lojas: 2000, 2000, 1000 × 6 (soma 10000).
STORES.forEach((companyId, index) =>
  db.insert("finance_rateio_model_shares", { id: `m-${index}`, model: "padrao", company_id: companyId, company_name: companyId.slice(1).toUpperCase(), percent_basis_points: index < 2 ? 2000 : 1000 }),
);
const expenseBody = (extra) => ({
  idempotencyKey: crypto.randomUUID(), kind: "single", companyId: STORES[0], companyName: "RIOMAR01",
  description: "CAMPANHA", financeItemId: "item-1", originalAmountCents: 100_000, dueDate: "2026-11-10",
  rateioType: "rateio", rateioModel: "padrao", ...extra,
});

// ---------------------------------------------------------------------------
// Puras
// ---------------------------------------------------------------------------

test("weightsToBasisPoints: soma exata 10000 pelo maior resto", () => {
  const bps = lib.weightsToBasisPoints([{ companyId: "a", companyName: "A", weight: 1 }, { companyId: "b", companyName: "B", weight: 1 }, { companyId: "c", companyName: "C", weight: 1 }]);
  assert.deepEqual(bps.map((s) => s.percentBasisPoints), [3334, 3333, 3333]);
  assert.equal(lib.weightsToBasisPoints([]).length, 0);
});

test("restrictRateioWeights: só as escolhidas, sem peso fica de fora, uma loja = 100%", () => {
  const weights = [{ companyId: "a", companyName: "A", weight: 2000 }, { companyId: "b", companyName: "B", weight: 1000 }];
  const two = lib.restrictRateioWeights(weights, [{ id: "a", name: "A" }, { id: "c", name: "C" }, { id: "b", name: "B" }]);
  assert.deepEqual(two.weights.map((w) => w.companyId), ["a", "b"]);
  assert.deepEqual(two.skipped, [{ companyId: "c", companyName: "C" }]);
  assert.deepEqual(lib.restrictRateioWeights(weights, [{ id: "c", name: "C" }]).weights, [{ companyId: "c", companyName: "C", weight: 1 }]);
  assert.ok("error" in lib.restrictRateioWeights(weights, [{ id: "c", name: "C" }, { id: "d", name: "D" }]));
});

// ---------------------------------------------------------------------------
// B. Rateio só nas lojas escolhidas
// ---------------------------------------------------------------------------

test("rateio: modelo padrão com 8 lojas, escolhidas 3 → 3 contas renormalizadas; 1 loja → 100%; loja inexistente → 400", async () => {
  const three = await post(expenses.POST, "/api/finance/expenses", expenseBody({ description: "CAMPANHA 3 LOJAS", rateioCompanyIds: [STORES[0], STORES[1], STORES[2]] }));
  assert.equal(three.status, 201);
  const { id } = await json(three);
  const shares = db.sqlite.prepare("SELECT company_id, percent_basis_points, amount_cents FROM expense_rateio_shares WHERE expense_id=? ORDER BY company_id").all(id).map((r) => ({ ...r }));
  // pesos 2000/2000/1000 → 40% / 40% / 20%
  assert.deepEqual(shares.map((s) => [s.company_id, s.percent_basis_points, s.amount_cents]).sort(), [
    [STORES[2], 2000, 20_000], [STORES[0], 4000, 40_000], [STORES[1], 4000, 40_000],
  ].sort());
  const slices = db.sqlite.prepare("SELECT company_id, original_amount_cents FROM accounts_payable WHERE expense_id=?").all(id);
  assert.equal(slices.length, 3);
  assert.equal(slices.reduce((sum, s) => sum + s.original_amount_cents, 0), 100_000);

  const one = await json(await post(expenses.POST, "/api/finance/expenses", expenseBody({ description: "SÓ UMA", rateioCompanyIds: [STORES[5]] })));
  const oneShares = db.sqlite.prepare("SELECT company_id, percent_basis_points, amount_cents FROM expense_rateio_shares WHERE expense_id=?").all(one.id);
  assert.deepEqual(oneShares.map((s) => ({ ...s })), [{ company_id: STORES[5], percent_basis_points: 10000, amount_cents: 100_000 }]);

  const bad = await post(expenses.POST, "/api/finance/expenses", expenseBody({ rateioCompanyIds: [STORES[0], "cnaoexiste"] }));
  assert.equal(bad.status, 400);
  // Sem lista = comportamento anterior (as 8 lojas do modelo).
  const all = await json(await post(expenses.POST, "/api/finance/expenses", expenseBody({ description: "TODAS" })));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM accounts_payable WHERE expense_id=?").get(all.id).n, 8);
  // Prévia já filtrada, com as lojas sem peso informadas.
  db.insert("finance_store_revenue", { id: "rv1", store_id: STORES[0], month: "2026-11", amount_cents: 300_000, sales_amount_cents: 300_000, services_amount_cents: 0, created_by: "seed" });
  db.insert("finance_store_revenue", { id: "rv2", store_id: STORES[1], month: "2026-11", amount_cents: 100_000, sales_amount_cents: 100_000, services_amount_cents: 0, created_by: "seed" });
  const prev = await json(await post(preview.POST, "/api/finance/expenses/rateio-preview", {
    rateioModel: "faturamento", competenceMonth: "2026-11", originalAmountCents: 1000, companyIds: [STORES[0], STORES[1], STORES[3]],
  }));
  assert.deepEqual(prev.shares.map((s) => [s.companyId, s.percentBasisPoints, s.amountCents]), [[STORES[0], 7500, 750], [STORES[1], 2500, 250]]);
  assert.deepEqual(prev.skipped.map((s) => s.companyId), [STORES[3]]);
});

// ---------------------------------------------------------------------------
// A + C. Contas a Pagar: totais sem canceladas e despesa rateada numa linha
// ---------------------------------------------------------------------------

test("totais sem canceladas: CONTAS e valores só das abertas, CANCELADAS à parte", async () => {
  db.sqlite.prepare("DELETE FROM accounts_payable").run();
  const payable = (id, extra) => db.insert("accounts_payable", {
    id, company_id: STORES[0], company_name: "RIOMAR01", description: "CARTOES DE VISITA", finance_item_id: "item-2",
    original_amount_cents: 1875, paid_amount_cents: 0, competence_month: "2026-10", due_date: "2026-10-20", status: "open",
    idempotency_key: `k-${id}`, created_by: "seed", ...extra,
  });
  for (let i = 0; i < 8; i++) payable(`canc-${i}`, { status: "canceled" });
  payable("aberta-1", { original_amount_cents: 5000 });
  payable("aberta-2", { original_amount_cents: 3000, paid_amount_cents: 1000, status: "partially_paid" });
  const data = await list();
  assert.equal(data.total, 10);
  assert.deepEqual(data.totals, { count: 2, canceledCount: 8, originalCents: 8000, paidCents: 1000, balanceCents: 7000 });
  // BUSCAR (5 parâmetros no mesmo trecho do filtro) volta a funcionar.
  const search = await list("&search=visita");
  assert.equal(search.total, 10);
  assert.equal((await list("&search=nada-disso")).total, 0);
  const onlyCanceled = await list("&status=canceled");
  assert.deepEqual(onlyCanceled.totals, { count: 0, canceledCount: 8, originalCents: 0, paidCents: 0, balanceCents: 0 });
});

test("despesa rateada em 8 lojas = 1 linha agrupada com shares[]; filtro por loja do rateio; pagar o grupo paga as 8", async () => {
  db.sqlite.prepare("DELETE FROM accounts_payable").run();
  const created = await json(await post(expenses.POST, "/api/finance/expenses", expenseBody({ description: "RATEIO 8 LOJAS", rateioCompanyIds: STORES })));
  db.insert("accounts_payable", {
    id: "avulsa", company_id: STORES[3], company_name: "BOAVIAGEM", description: "AVULSA", finance_item_id: "item-2",
    original_amount_cents: 700, competence_month: "2026-11", due_date: "2026-11-01", status: "open", idempotency_key: "k-av", created_by: "seed",
  });
  const data = await list();
  assert.equal(data.total, 2);
  assert.equal(data.rows.length, 2);
  const group = data.rows.find((row) => row.isGroup);
  assert.equal(group.description, "RATEIO 8 LOJAS");
  assert.equal(group.companyId, STORES[0]);
  assert.equal(group.originalAmountCents, 100_000);
  assert.equal(group.shares.length, 8);
  assert.equal(group.groupIds.length, 8);
  assert.equal(group.displayStatus, "upcoming");
  assert.deepEqual(data.totals, { count: 2, canceledCount: 0, originalCents: 100_700, paidCents: 0, balanceCents: 100_700 });
  // Paginação conta o grupo como 1 linha.
  const page1 = await json(await callRoute(payables.GET, ADMIN, "GET", "/api/finance/payables?pageSize=1&sort=dueDate"));
  assert.equal(page1.total, 2);
  assert.equal(page1.rows.length, 1);
  assert.equal(page1.rows[0].id, "avulsa");
  // Filtro por uma loja do rateio (não a da despesa): a linha inteira aparece.
  const byStore = await list(`&companyId=${STORES[6]}`);
  assert.equal(byStore.rows.length, 1);
  assert.equal(byStore.rows[0].shares.length, 8);
  // Pagar o grupo (ids das fatias) paga as 8.
  const paid = await json(await post(payablesBulk.POST, "/api/finance/payables/bulk", { action: "pay", ids: group.groupIds, fields: { paymentDate: "2026-11-10" } }));
  assert.equal(paid.applied, 8);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM accounts_payable WHERE expense_id=? AND status='paid'").get(created.id).n, 8);
  const after = (await list()).rows.find((row) => row.isGroup);
  assert.equal(after.displayStatus, "paid");
  // Uma fatia cancelada + resto pago: grupo continua PAGO e o total ignora a cancelada.
  db.sqlite.prepare("UPDATE accounts_payable SET status='canceled' WHERE id=?").run(group.groupIds[0]);
  const mixed = await list();
  assert.equal(mixed.rows.find((row) => row.isGroup).displayStatus, "paid");
  assert.equal(mixed.totals.originalCents, 100_700 - group.shares.find((s) => s.id === group.groupIds[0]).originalAmountCents);
});

// ---------------------------------------------------------------------------
// D. Contas Financeiras
// ---------------------------------------------------------------------------

test("contas financeiras: cada TIPO com o mínimo, PIX de cada tipo, duplicidades e conta sem número", async () => {
  const base = { companyId: STORES[0], companyName: "RIOMAR01" };
  const create = (extra) => post(accounts.POST, "/api/finance/accounts", { ...base, ...extra });
  const minimum = {
    checking: { bankName: "ITAÚ", agency: "1234", accountNumber: "10001" },
    savings: { bankName: "CAIXA", agency: "0001", accountNumber: "20002" },
    cash: {},
    wallet: {},
    digital: { bankName: "NUBANK", accountNumber: "30003" },
    card: { bankName: "STONE", accountNumber: "40004" },
    investment: { bankName: "XP", accountNumber: "50005" },
    other: { bankName: "OUTRO", accountNumber: "60006" },
  };
  for (const [type, fields] of Object.entries(minimum)) {
    const res = await create({ name: `CONTA ${type.toUpperCase()}`, type, ...fields });
    assert.equal(res.status, 201, type);
  }
  assert.equal((await json(await create({ name: "SEM AGENCIA", type: "checking", bankName: "BB", accountNumber: "1" }))).error, "INFORME A AGÊNCIA.");
  assert.equal((await json(await create({ name: "SEM BANCO", type: "digital", accountNumber: "1" }))).error, "INFORME O BANCO/INSTITUIÇÃO FINANCEIRA.");

  const pix = [["cpf", "529.982.247-25"], ["cnpj", "11.222.333/0001-81"], ["email", "fin@unigames.com.br"], ["phone", "+5581999990000"], ["random", "123e4567-e89b-12d3-a456-426614174000"], ["other", "CHAVE-XYZ"]];
  for (const [pixKeyType, pixKey] of pix) {
    assert.equal((await create({ name: `PIX ${pixKeyType}`, type: "cash", pixKeyType, pixKey })).status, 201, pixKeyType);
  }
  const badPhone = await json(await create({ name: "PIX RUIM", type: "cash", pixKeyType: "phone", pixKey: "999" }));
  assert.match(badPhone.error, /TELEFONE COM DDD/);
  const badRandom = await json(await create({ name: "PIX RUIM 2", type: "cash", pixKeyType: "random", pixKey: "abc" }));
  assert.match(badRandom.error, /CHAVE ALEATÓRIA/);

  const dupName = await create({ name: "CONTA CASH", type: "cash" });
  assert.equal(dupName.status, 409);
  assert.match((await json(dupName)).error, /COM ESSE NOME/);
  const dupNumber = await create({ name: "OUTRO NOME", type: "checking", bankName: "ITAÚ", agency: "1234", accountNumber: "10001" });
  assert.equal(dupNumber.status, 409);
  assert.match((await json(dupNumber)).error, /BANCO, AGÊNCIA E NÚMERO/);
  // Duas contas sem número (CAIXA/CARTEIRA) nunca caem na duplicidade do número.
  assert.equal((await create({ name: "CAIXA 2", type: "cash" })).status, 201);
  assert.equal((await create({ name: "CAIXA 3", type: "cash" })).status, 201);
  // A regra antiga ("?4 != ''") saiu do SQL.
  const source = await (await import("node:fs/promises")).readFile(new URL("../app/api/finance/accounts/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\?\d+ != ''/);
});

test("filtros com vários parâmetros no mesmo trecho: helpers numeram só o '?' ainda livre", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["payables", "receivables", "invoices", "expenses", "supplier-debts"]) {
    const source = await readFile(new URL(`../app/api/finance/${file}/route.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /fragment\.replace\("\?"/, file);
  }
});
