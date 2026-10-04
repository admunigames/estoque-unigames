import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Financeiro 2/9 — Cartões de crédito corporativos: duplicidade na
// importação, "possível duplicado em Despesas", NÃO É DESPESA, responsável
// editável, ações em lote (classificar/lançar/excluir) e gastos por
// categoria. Rotas reais sobre SQLite (tests/helpers/route-db.mjs).

const db = await setupRouteDb([
  "finance_corporate_cards", "finance_card_invoice_imports", "finance_card_invoice_entries",
  "expenses", "expense_rateio_shares", "accounts_payable", "finance_store_entries",
  "finance_items", "finance_categories", "finance_cost_centers", "hr_employees",
]);

const cards = await import("../app/lib/corporate-cards.ts");
const invoice = await import("../app/api/finance/corporate-cards/[id]/invoice/route.ts");
const bulk = await import("../app/api/finance/corporate-cards/[id]/invoice/bulk/route.ts");
const spending = await import("../app/api/finance/corporate-cards/spending/route.ts");

const FINANCE = { id: "fin", permissions: ["finance:manage"] };
const NO_FINANCE = { id: "loja", permissions: ["outputs:view"] };
const CARD = "card-1";
const params = { id: CARD };

db.insert("finance_corporate_cards", { id: CARD, name: "VISA LOJA", last4: "1234", company_id: "criomar01", company_name: "RIOMAR" });
db.insert("finance_corporate_cards", { id: "card-2", name: "MASTER", last4: "9999", company_id: "ctacaruna1", company_name: "TACARUNA" });
db.insert("finance_categories", { id: "cat-1", name: "OPERACIONAL" });
db.insert("finance_items", { id: "item-comb", category_id: "cat-1", name: "COMBUSTÍVEL" });
db.insert("finance_items", { id: "item-mat", category_id: "cat-1", name: "MATERIAL" });
db.insert("hr_employees", { id: "emp-1", full_name: "MARIA SILVA", cpf: "1", status: "active" });
db.insert("hr_employees", { id: "emp-2", full_name: "JOAO ANTIGO", cpf: "2", status: "inactive" });

const entryRows = () =>
  db.sqlite.prepare("SELECT * FROM finance_card_invoice_entries WHERE card_id=? ORDER BY entry_date, merchant, installment_current").all(CARD);
const post = (path, body, user = FINANCE) => callRoute(invoice.POST, user, "POST", path, body, params);
const runBulk = async (action, ids, fields) =>
  (await callRoute(bulk.POST, FINANCE, "POST", `/api/finance/corporate-cards/${CARD}/invoice/bulk`, { action, ids, fields }, params)).json();

// ---------------------------------------------------------------------------
// Funções puras
// ---------------------------------------------------------------------------
test("chave de duplicidade: mesma compra; parcelas diferentes não duplicam; acento/espaço/caixa não importam", () => {
  const base = { entryDate: "2026-09-10", amountCents: 15000, merchant: "Posto São João", installmentCurrent: 2, installmentTotal: 10 };
  const key = cards.cardEntryDuplicateKey(base);
  assert.equal(cards.cardEntryDuplicateKey({ ...base, merchant: "  POSTO  SAO   JOAO " }), key);
  assert.notEqual(cards.cardEntryDuplicateKey({ ...base, installmentCurrent: 3 }), key);
  assert.notEqual(cards.cardEntryDuplicateKey({ ...base, amountCents: 15001 }), key);
  assert.notEqual(cards.cardEntryDuplicateKey({ ...base, entryDate: "2026-09-11" }), key);
  // Sem parcela = 1/1.
  assert.equal(
    cards.cardEntryDuplicateKey({ ...base, installmentCurrent: 0, installmentTotal: 0 }),
    cards.cardEntryDuplicateKey({ ...base, installmentCurrent: 1, installmentTotal: 1 }),
  );
});

test("possível duplicado em Despesas: mesmo valor a ±3 dias, ignora já lançados e NÃO É DESPESA", () => {
  const entries = [
    { id: "a", entryDate: "2026-09-10", amountCents: 500, expenseId: "", status: "pending" },
    { id: "b", entryDate: "2026-09-10", amountCents: 500, expenseId: "x", status: "expensed" },
    { id: "c", entryDate: "2026-09-10", amountCents: 500, expenseId: "", status: "not_expense" },
    { id: "d", entryDate: "2026-09-01", amountCents: 500, expenseId: "", status: "pending" },
    { id: "e", entryDate: "2026-09-10", amountCents: 501, expenseId: "", status: "classified" },
  ];
  const flagged = cards.possibleExpenseDuplicates(entries, [{ date: "2026-09-13", amountCents: 500 }]);
  assert.deepEqual([...flagged], ["a"]);
  assert.equal(cards.shiftIsoDate("2026-03-01", -1), "2026-02-28");
});

test("classificação: NÃO É DESPESA, volta para pendente e já lançado só aceita responsável/observação", () => {
  const entry = { status: "pending", expenseId: "", categoryItemId: "", costCenterId: "", holderName: "", notes: "" };
  assert.equal(cards.applyCardEntryFields(entry, { categoryItemId: "i" }).status, "classified");
  const notExpense = cards.applyCardEntryFields(entry, { categoryItemId: "i", expenseKind: "not_expense" });
  assert.equal(notExpense.status, "not_expense");
  assert.equal(cards.applyCardEntryFields({ ...entry, ...notExpense }, { holderName: "ANA" }).status, "not_expense");
  assert.equal(cards.applyCardEntryFields({ ...entry, status: "not_expense" }, { expenseKind: "expense" }).status, "pending");
  const expensed = { ...entry, status: "expensed", expenseId: "x" };
  assert.equal(cards.applyCardEntryFields(expensed, { holderName: "ANA" }).status, "expensed");
  assert.match(cards.applyCardEntryFields(expensed, { categoryItemId: "i" }).error, /DESPESA/);
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
test("sem finance:manage recebe 403", async () => {
  const path = `/api/finance/corporate-cards/${CARD}/invoice`;
  assert.equal((await callRoute(invoice.GET, NO_FINANCE, "GET", path, undefined, params)).status, 403);
  assert.equal((await callRoute(invoice.POST, NO_FINANCE, "POST", path, { rows: [] }, params)).status, 403);
  assert.equal((await callRoute(invoice.PATCH, NO_FINANCE, "PATCH", path, {}, params)).status, 403);
  assert.equal((await callRoute(bulk.POST, NO_FINANCE, "POST", `${path}/bulk`, {}, params)).status, 403);
  assert.equal((await callRoute(spending.GET, NO_FINANCE, "GET", "/api/finance/corporate-cards/spending?from=2026-09&to=2026-09")).status, 403);
});

const SEPT = [
  { entryDate: "2026-09-10", merchant: "Posto São João", amountCents: 15000, installmentLabel: "2/10" },
  { entryDate: "2026-09-11", merchant: "PAPELARIA CENTRAL", amountCents: 4990, installmentLabel: "" },
  { entryDate: "2026-09-12", merchant: "MERCADO BOM", amountCents: 12000, installmentLabel: "" },
  { entryDate: "2026-09-15", merchant: "LOJA PESSOAL", amountCents: 8000, installmentLabel: "" },
];

test("importar: prévia aponta duplicadas; reimportar a mesma fatura pula tudo; parcela seguinte entra", async () => {
  const path = `/api/finance/corporate-cards/${CARD}/invoice`;
  let res = await post(path, { referenceMonth: "2026-09", sourceName: "set.csv", fileHash: "h1", rows: SEPT });
  assert.equal(res.status, 201);
  let out = await res.json();
  assert.equal(out.inserted, 4);
  assert.equal(out.skippedDuplicates, 0);

  // Mesma fatura de novo (estabelecimento com grafia diferente): prévia e import.
  const again = SEPT.map((row) => ({ ...row, merchant: row.merchant.toLowerCase() + "  " }));
  res = await post(path, { dryRun: true, rows: again });
  assert.deepEqual((await res.json()).duplicates, [0, 1, 2, 3]);
  res = await post(path, { referenceMonth: "2026-09", sourceName: "set.csv", fileHash: "h1", rows: again });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { imported: false, inserted: 0, skippedDuplicates: 4 });

  // Marcada de propósito na prévia (outra compra igual) entra; a outra é pulada.
  res = await post(path, { referenceMonth: "2026-09", rows: [{ ...SEPT[1], allowDuplicate: true }, SEPT[2]] });
  out = await res.json();
  assert.equal(out.inserted, 1);
  assert.equal(out.skippedDuplicates, 1);

  // Fatura seguinte: parcela 3/10 da mesma compra não é duplicada.
  res = await post(path, { referenceMonth: "2026-10", rows: [{ ...SEPT[0], installmentLabel: "3/10" }] });
  assert.equal((await res.json()).inserted, 1);
  assert.equal(entryRows().length, 6);
});

test("lista: possível duplicado em Despesas e sugestões de responsável (funcionários ativos)", async () => {
  db.insert("expenses", {
    id: "exp-manual", company_id: "criomar01", description: "MERCADO", finance_item_id: "item-mat",
    original_amount_cents: 12000, issue_date: "2026-09-14", due_date: "2026-09-14", idempotency_key: "k-manual",
  });
  db.insert("expenses", {
    id: "exp-outra-loja", company_id: "ctacaruna1", description: "PAPELARIA", finance_item_id: "item-mat",
    original_amount_cents: 4990, issue_date: "2026-09-11", due_date: "2026-09-11", idempotency_key: "k-outra",
  });
  const res = await callRoute(invoice.GET, FINANCE, "GET", `/api/finance/corporate-cards/${CARD}/invoice?month=2026-09`, undefined, params);
  const { entries, holderSuggestions } = await res.json();
  const flagged = entries.filter((e) => e.possibleExpenseDuplicate).map((e) => e.merchant);
  assert.deepEqual(flagged, ["MERCADO BOM"]);
  assert.deepEqual(holderSuggestions, ["MARIA SILVA"]);
});

test("PATCH: responsável editável; NÃO É DESPESA não vira despesa e volta para pendente", async () => {
  const path = `/api/finance/corporate-cards/${CARD}/invoice`;
  const pessoal = entryRows().find((r) => r.merchant === "LOJA PESSOAL");
  let res = await callRoute(invoice.PATCH, FINANCE, "PATCH", path, { entryId: pessoal.id, holderName: "MARIA SILVA", expenseKind: "not_expense" }, params);
  assert.equal((await res.json()).status, "not_expense");
  let row = entryRows().find((r) => r.id === pessoal.id);
  assert.equal(row.holder_name, "MARIA SILVA");
  assert.equal(row.status, "not_expense");

  // Vincular despesa a um NÃO É DESPESA é recusado.
  res = await callRoute(invoice.PATCH, FINANCE, "PATCH", path, { entryId: pessoal.id, expenseId: "x" }, params);
  assert.equal(res.status, 409);
  // Lançar em lote também pula.
  const out = await runBulk("launch", [pessoal.id], {});
  assert.equal(out.applied, 0);
  assert.equal(out.skipped[0].reason, "MARCADO COMO NÃO É DESPESA");

  // Volta para pendente.
  res = await callRoute(invoice.PATCH, FINANCE, "PATCH", path, { entryId: pessoal.id, expenseKind: "expense" }, params);
  assert.equal((await res.json()).status, "pending");
  row = entryRows().find((r) => r.id === pessoal.id);
  assert.equal(row.holder_name, "MARIA SILVA");
  await callRoute(invoice.PATCH, FINANCE, "PATCH", path, { entryId: pessoal.id, expenseKind: "not_expense" }, params);
});

test("lote: classificar só os campos enviados; lançar cria Despesa + contas a pagar numa transação; excluir pula lançados", async () => {
  const sept = entryRows().filter((r) => r.status === "pending" && r.installment_current !== 3);
  const ids = sept.map((r) => r.id);
  assert.equal(ids.length, 4); // posto, papelaria ×2, mercado (pessoal é NÃO É DESPESA)

  let out = await runBulk("classify", ids, { categoryItemId: "item-mat", holderName: "MARIA SILVA" });
  assert.equal(out.applied, 4);
  const posto = entryRows().find((r) => r.merchant === "Posto São João" && r.installment_current === 2);
  out = await runBulk("classify", [posto.id], { categoryItemId: "item-comb" });
  let row = entryRows().find((r) => r.id === posto.id);
  assert.equal(row.category_item_id, "item-comb");
  assert.equal(row.holder_name, "MARIA SILVA"); // não enviado = mantido
  assert.equal(row.status, "classified");

  // Lançar: os 4 classificados + 1 pendente sem categoria (pulado).
  const parcela3 = entryRows().find((r) => r.installment_current === 3);
  out = await runBulk("launch", [...ids, parcela3.id], {});
  assert.equal(out.applied, 4);
  assert.deepEqual(out.skipped.map((s) => s.reason), ["SEM CATEGORIA — CLASSIFIQUE ANTES"]);
  const launched = entryRows().filter((r) => ids.includes(r.id));
  assert.ok(launched.every((r) => r.status === "expensed" && r.expense_id));
  const expense = db.sqlite.prepare("SELECT * FROM expenses WHERE id=?").get(launched.find((r) => r.id === posto.id).expense_id);
  assert.equal(expense.original_amount_cents, 15000);
  assert.equal(expense.card_id, CARD);
  assert.equal(expense.idempotency_key, `card-entry:${posto.id}`);
  assert.match(expense.notes, /parcela 2\/10/);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM accounts_payable").get().n, 4);
  // DRE recalculada por loja/categoria/mês (mesma regra do POST /expenses).
  const dre = db.sqlite.prepare("SELECT item_id, amount_cents FROM finance_store_entries ORDER BY item_id").all();
  assert.deepEqual(dre.map((d) => [d.item_id, d.amount_cents]), [["item-comb", 15000], ["item-mat", 4990 * 2 + 12000]]);

  // Já lançado não é reclassificado nem lançado de novo.
  out = await runBulk("classify", [posto.id], { categoryItemId: "item-mat" });
  assert.match(out.skipped[0].reason, /JÁ LANÇADO/);
  out = await runBulk("launch", [posto.id], {});
  assert.equal(out.skipped[0].reason, "JÁ LANÇADO EM DESPESAS");

  // Excluir: lançado é pulado, o resto sai.
  out = await runBulk("delete", [posto.id, parcela3.id], undefined);
  assert.equal(out.applied, 1);
  assert.match(out.skipped[0].reason, /JÁ LANÇADO EM DESPESAS/);
  assert.ok(entryRows().some((r) => r.id === posto.id));
  assert.ok(!entryRows().some((r) => r.id === parcela3.id));

  // id de outro cartão / inexistente → 404 e nada muda.
  const res = await callRoute(bulk.POST, FINANCE, "POST", `/api/finance/corporate-cards/${CARD}/invoice/bulk`, { action: "delete", ids: [posto.id, "nao-existe"] }, params);
  assert.equal(res.status, 404);
});

test("LANÇAR DESPESA de um só com categoria e vencimento escolhidos no diálogo", async () => {
  await post(`/api/finance/corporate-cards/${CARD}/invoice`, { referenceMonth: "2026-09", rows: [{ entryDate: "2026-09-20", merchant: "FARMACIA", amountCents: 3000 }] });
  const farm = entryRows().find((r) => r.merchant === "FARMACIA");
  const out = await runBulk("launch", [farm.id], { categoryItemId: "item-mat", dueDate: "2026-10-10", notes: "REMÉDIO" });
  assert.equal(out.applied, 1);
  const row = entryRows().find((r) => r.id === farm.id);
  const expense = db.sqlite.prepare("SELECT * FROM expenses WHERE id=?").get(row.expense_id);
  assert.equal(expense.due_date, "2026-10-10");
  assert.equal(expense.finance_item_id, "item-mat");
  assert.equal(row.notes, "REMÉDIO");
});

test("gastos por categoria: soma no servidor, SEM CATEGORIA à parte, filtros e lançamentos da barra", async () => {
  await callRoute(invoice.POST, FINANCE, "POST", `/api/finance/corporate-cards/card-2/invoice`, { referenceMonth: "2026-09", rows: [{ entryDate: "2026-09-05", merchant: "OUTRO CARTAO", amountCents: 99900 }] }, { id: "card-2" });
  const get = async (query) => (await callRoute(spending.GET, FINANCE, "GET", `/api/finance/corporate-cards/spending?${query}`)).json();

  let out = await get(`from=2026-09&to=2026-09&cardId=${CARD}`);
  // Setembro do cartão 1: posto 150 (comb.), papelaria 49,90×2 + mercado 120 + farmácia 30 (mat.); pessoal 80 = NÃO É DESPESA (fora).
  assert.deepEqual(out.categories.map((c) => [c.label, c.totalCents]), [
    ["OPERACIONAL › MATERIAL", 4990 * 2 + 12000 + 3000],
    ["OPERACIONAL › COMBUSTÍVEL", 15000],
  ]);
  assert.equal(out.totalCents, 4990 * 2 + 12000 + 3000 + 15000);
  assert.equal(out.categories.reduce((sum, c) => sum + c.shareBps, 0), 10000);

  out = await get(`from=2026-09&to=2026-09&cardId=${CARD}&includeNotExpense=1`);
  assert.deepEqual(out.categories.find((c) => c.label === "SEM CATEGORIA"), { categoryItemId: "", label: "SEM CATEGORIA", totalCents: 8000, entryCount: 1, shareBps: Math.round((8000 / out.totalCents) * 10000) });

  out = await get("from=2026-09&to=2026-09");
  assert.equal(out.categories[0].label, "SEM CATEGORIA"); // cartão 2: R$ 999,00 sem categoria
  out = await get("from=2026-09&to=2026-09&companyId=criomar01&category=__none__&includeNotExpense=1");
  assert.deepEqual(out.entries.map((e) => [e.merchant, e.cardName]), [["LOJA PESSOAL", "VISA LOJA"]]);
  out = await get("from=2026-10&to=2026-10");
  assert.deepEqual(out.categories, []);

  // Login com loja só vê a própria loja.
  const storeLogin = { id: "fin-loja", companyId: "criomar01", permissions: ["finance:manage"] };
  const res = await callRoute(spending.GET, storeLogin, "GET", "/api/finance/corporate-cards/spending?from=2026-09&to=2026-09&companyId=ctacaruna1");
  assert.equal(res.status, 403);
});
