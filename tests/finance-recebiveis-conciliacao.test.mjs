import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// CONCILIAÇÃO DE CONTAS A RECEBER (23/10/2026): previsto × créditos do
// extrato da conta. Sugestão por valor igual (ou parecido) em até 5 dias;
// conciliar marca recebido pelo valor/data do extrato; desfazer volta.

const db = await setupRouteDb(["accounts_receivable", "finance_bank_statement_entries", "finance_accounts"]);
const { suggestReceivableMatches } = await import("../app/lib/receivables-recon.ts");
const route = await import("../app/api/finance/receivables/reconciliation/route.ts");

const FINANCE = { id: "fin", permissions: ["finance:manage"] };
const one = (sql, ...params) => db.prepare(sql).bind(...params).first();
const get = async (path) => (await callRoute(route.GET, FINANCE, "GET", path)).json();
const post = (body) => callRoute(route.POST, FINANCE, "POST", "/api/finance/receivables/reconciliation", body);

test("sugestão: valor igual primeiro (data mais próxima), depois valor parecido; um crédito por recebível", () => {
  const result = suggestReceivableMatches(
    [
      { id: "r1", expectedDate: "2026-10-10", expectedAmountCents: 10_000 },
      { id: "r2", expectedDate: "2026-10-10", expectedAmountCents: 10_000 },
      { id: "r3", expectedDate: "2026-10-20", expectedAmountCents: 50_000 },
      { id: "r4", expectedDate: "2026-10-01", expectedAmountCents: 7_000 },
    ],
    [
      { id: "c-longe", entryDate: "2026-10-14", amountCents: 10_000 },
      { id: "c-perto", entryDate: "2026-10-11", amountCents: 10_000 },
      { id: "c-parecido", entryDate: "2026-10-21", amountCents: 49_500 },
      { id: "c-fora", entryDate: "2026-10-09", amountCents: 7_000 },
    ],
  );
  assert.deepEqual(result, [
    { receivableId: "r1", entryId: "c-perto", exact: true },
    { receivableId: "r2", entryId: "c-longe", exact: true },
    { receivableId: "r3", entryId: "c-parecido", exact: false },
  ]);
});

const receivable = (id, row) => db.insert("accounts_receivable", {
  id, company_id: "loja", company_name: "LOJA", operator_text: "STONE", competence_month: "2026-09",
  expected_amount_cents: 10_000, canceled: 0, idempotency_key: id, created_by: "seed", ...row,
});
const credit = (id, row) => db.insert("finance_bank_statement_entries", {
  id, import_id: "imp", finance_account_id: "acc-itau", description: "CRED STONE", ...row,
});
db.insert("finance_accounts", { id: "acc-itau", name: "ITAÚ", active: 1 });
receivable("igual", { expected_date: "2026-10-05", finance_account_id: "acc-itau" });
receivable("sem-conta", { expected_date: "2026-10-12", expected_amount_cents: 20_000 });
receivable("diferente", { expected_date: "2026-10-15", expected_amount_cents: 30_000 });
receivable("nao-entrou", { expected_date: "2026-10-02", expected_amount_cents: 4_000 });
receivable("outra-conta", { expected_date: "2026-10-05", finance_account_id: "acc-bb" });
credit("e1", { entry_date: "2026-10-06", amount_cents: 10_000 });
credit("e2", { entry_date: "2026-10-12", amount_cents: 20_000 });
credit("e3", { entry_date: "2026-10-16", amount_cents: 29_700 });
credit("e-avulso", { entry_date: "2026-10-20", amount_cents: 1_234, description: "PIX CLIENTE" });
credit("e-debito", { entry_date: "2026-10-06", amount_cents: -10_000 });

test("tela do mês: sugestões, NÃO ENTROU e crédito sem previsto", async () => {
  const data = await get("/api/finance/receivables/reconciliation?accountId=acc-itau&month=2026-10");
  const byId = Object.fromEntries(data.lines.map((line) => [line.id, line]));
  assert.deepEqual(Object.keys(byId).sort(), ["diferente", "igual", "nao-entrou", "sem-conta"], "outra conta fica de fora");
  assert.equal(byId.igual.status, "suggested");
  assert.equal(byId.igual.suggestion.id, "e1");
  assert.equal(byId["sem-conta"].suggestion.id, "e2");
  assert.equal(byId.diferente.suggestion.exact, false);
  assert.equal(byId["nao-entrou"].status, "missing");
  assert.deepEqual(data.unmatchedCredits.map((row) => row.id), ["e-avulso"]);
  assert.equal(data.totals.expectedCents, 64_000);
  assert.equal((await callRoute(route.GET, FINANCE, "GET", "/api/finance/receivables/reconciliation?month=2026-10")).status, 400);
});

test("conciliar sugestões de valor igual, vincular manual com diferença, desfazer", async () => {
  const bulk = await (await post({ action: "link-suggested", accountId: "acc-itau", month: "2026-10" })).json();
  assert.deepEqual(bulk, { linked: 2, skipped: 1 });
  const linked = await one("SELECT bank_entry_id AS e, received_amount_cents AS v, received_date AS d, finance_account_id AS a FROM accounts_receivable WHERE id = 'sem-conta'");
  assert.deepEqual({ ...linked }, { e: "e2", v: 20_000, d: "2026-10-12", a: "acc-itau" });

  const manual = await post({ action: "link", receivableId: "diferente", entryId: "e3" });
  assert.equal(manual.status, 200);
  assert.equal((await manual.json()).differenceCents, -300);
  assert.equal((await post({ action: "link", receivableId: "nao-entrou", entryId: "e3" })).status, 409, "crédito já usado");
  assert.equal((await post({ action: "link", receivableId: "nao-entrou", entryId: "e-debito" })).status, 400, "débito não concilia");

  let data = await get("/api/finance/receivables/reconciliation?accountId=acc-itau&month=2026-10");
  const status = Object.fromEntries(data.lines.map((line) => [line.id, line.status]));
  assert.deepEqual(status, { "nao-entrou": "missing", igual: "ok", "sem-conta": "ok", diferente: "divergent" });
  assert.equal(data.totals.enteredCents, 59_700);
  assert.equal(data.lines.find((line) => line.id === "diferente").entry.description, "CRED STONE");

  assert.equal((await post({ action: "unlink", receivableId: "diferente" })).status, 200);
  const back = await one("SELECT bank_entry_id AS e, received_amount_cents AS v FROM accounts_receivable WHERE id = 'diferente'");
  assert.deepEqual({ ...back }, { e: "", v: null });
  data = await get("/api/finance/receivables/reconciliation?accountId=acc-itau&month=2026-10");
  assert.equal(data.lines.find((line) => line.id === "diferente").status, "suggested");
});

test("sem finance:manage é bloqueado", async () => {
  const response = await callRoute(route.GET, { id: "x", permissions: ["stock:view"] }, "GET", "/api/finance/receivables/reconciliation?accountId=acc-itau&month=2026-10");
  assert.equal(response.status, 403);
});

test("tela: seção de conciliação na aba RECEBÍVEIS", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /CONCILIAÇÃO DE CONTAS A RECEBER \(PREVISTO × ENTROU NA CONTA\)/);
  for (const id of ["rrAccount", "rrMonth", "btnRrLinkSuggested", "rrBody", "rrCreditsBody"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /loadReceivablesRecon\(\)\]\)/);
});
