import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Filtro CATEGORIA de Contas a Pagar e Despesas (26/11/2026): antes só o ITEM
// ia para o servidor e escolher só a categoria não filtrava nada. Agora filtra
// pelos itens da categoria e das subcategorias. Dados fictícios.

const db = await setupRouteDb(["finance_replacement_entries", 
  "shared_state", "accounts_payable", "accounts_payable_payments", "finance_items", "finance_categories", "finance_accounts",
  "finance_cost_centers", "finance_store_entries", "finance_rateio_model_shares", "finance_suppliers",
  "supplier_open_debts", "supplier_invoices", "supplier_invoice_installments", "supplier_invoice_events",
  "expenses", "expense_rateio_shares", "finance_store_revenue", "finance_store_headcount",
]);
const payables = await import("../app/api/finance/payables/route.ts");
const payablesBatch = await import("../app/api/finance/payables/batch/route.ts");
const expenses = await import("../app/api/finance/expenses/route.ts");
const ALFA = "clojaalfa1";
const ADMIN = { id: "admin", role: "admin" };
db.insert("shared_state", { state_key: "companies_list", value_json: JSON.stringify([{ id: ALFA, name: "LOJA ALFA" }]) });
db.insert("finance_categories", { id: "cat-rh", name: "RH", parent_id: null, position: 0, created_by: "admin" });
db.insert("finance_categories", { id: "cat-rh-exames", name: "EXAMES", parent_id: "cat-rh", position: 1, created_by: "admin" });
db.insert("finance_categories", { id: "cat-ocup", name: "OCUPAÇÃO", parent_id: null, position: 2, created_by: "admin" });
for (const [id, category] of [["item-vale", "cat-rh"], ["item-aso", "cat-rh-exames"], ["item-luz", "cat-ocup"]]) {
  db.insert("finance_items", { id, category_id: category, name: id.toUpperCase(), created_by: "admin" });
}
let seq = 0;
for (const item of ["item-vale", "item-aso", "item-luz"]) {
  const body = { idempotencyKey: `k-${++seq}`, companyId: ALFA, description: `CONTA ${item}`, financeItemId: item, originalAmountCents: 1000, dueDate: "2026-11-20" };
  assert.equal((await callRoute(payables.POST, ADMIN, "POST", "/api/finance/payables", body)).status, 201);
  assert.ok((await callRoute(expenses.POST, ADMIN, "POST", "/api/finance/expenses", { ...body, description: `DESPESA ${item}`, idempotencyKey: `e-${seq}`, kind: "single" })).status < 300);
}
const items = async (route, path) => ((await (await callRoute(route.GET, ADMIN, "GET", path)).json()).rows || []).map((row) => row.financeItemId).filter((id, i, all) => all.indexOf(id) === i).sort();

test("Contas a Pagar: CATEGORIA filtra os itens dela e das subcategorias; ITEM continua mandando", async () => {
  assert.deepEqual(await items(payables, "/api/finance/payables?categoryId=cat-rh&pageSize=100"), ["item-aso", "item-vale"]);
  assert.deepEqual(await items(payables, "/api/finance/payables?categoryId=cat-rh-exames&pageSize=100"), ["item-aso"]);
  assert.deepEqual(await items(payables, "/api/finance/payables?categoryId=cat-rh&financeItemId=item-vale&pageSize=100"), ["item-vale"]);
  assert.equal((await items(payables, "/api/finance/payables?pageSize=100")).length, 3);
});

test("Despesas: CATEGORIA também filtra", async () => {
  assert.deepEqual(await items(expenses, "/api/finance/expenses?categoryId=cat-ocup&pageSize=100"), ["item-luz"]);
});

test("tela: CATEGORIA vai para o servidor nas duas listas", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  assert.match(html, /const categoryId = el\('payablesCategory'\) \? el\('payablesCategory'\)\.value : '';\s*if\(categoryId && !financeItemId\) params\.set\('categoryId', categoryId\);/);
  assert.match(html, /const categoryId = el\('expensesCategory'\) \? el\('expensesCategory'\)\.value : '';\s*if\(categoryId && !financeItemId\) params\.set\('categoryId', categoryId\);/);
});

test("rótulo CATEGORIA › ITEM não repete quando o item tem o nome da categoria", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  const start = html.indexOf("function financeJoinItemLabel(");
  const body = html.slice(start, html.indexOf("\n  }", start) + 4);
  const normalizeSearchText = (v) => String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const join = new Function("normalizeSearchText", `${body}; return financeJoinItemLabel;`)(normalizeSearchText);
  assert.equal(join("EXAME ADMISSIONAL/DEMISSIONAL", "EXAME ADMISSIONAL/DEMISSIONAL"), "EXAME ADMISSIONAL/DEMISSIONAL");
  assert.equal(join("RH › EXAMES", "Exames"), "RH › EXAMES");
  assert.equal(join("OCUPAÇÃO", "ENERGIA"), "OCUPAÇÃO › ENERGIA");
  assert.equal(join("", "ENERGIA"), "ENERGIA");
});

test("conta REPETIDA (mesma loja, fornecedor, item, valor, vencimento e descrição): avisa; cria só com allowDuplicate", async () => {
  const body = { companyId: ALFA, description: "admissional fulano teste", financeItemId: "item-aso", originalAmountCents: 4500, dueDate: "2026-11-20" };
  const post = (extra) => callRoute(payables.POST, ADMIN, "POST", "/api/finance/payables", { ...body, idempotencyKey: `dup-${++seq}`, ...extra });
  assert.equal((await post()).status, 201);
  const again = await post();
  assert.equal(again.status, 409);
  const payload = await again.json();
  assert.equal(payload.duplicate, true);
  assert.match(payload.error, /^JÁ EXISTE UMA CONTA IGUAL: ADMISSIONAL FULANO TESTE · VENCIMENTO 20\/11\/2026/);
  // Outra pessoa (descrição diferente) no mesmo exame/valor/dia não é repetida.
  assert.equal((await post({ description: "admissional beltrano teste" })).status, 201);
  assert.equal((await post({ allowDuplicate: true })).status, 201);
  // Despesa igual também é avisada.
  const expense = await callRoute(expenses.POST, ADMIN, "POST", "/api/finance/expenses", { ...body, kind: "single", idempotencyKey: `dup-e-${++seq}` });
  assert.equal(expense.status, 409);
});

test("CADASTRAR EM LOTE lançado de novo: linhas repetidas voltam marcadas; allowDuplicates grava", async () => {
  const rows = [{ companyId: ALFA, description: "DEMISSIONAL CICLANO TESTE", financeItemId: "item-aso", originalAmountCents: 4500, dueDate: "2026-11-21" }];
  const send = (extra) => callRoute(payablesBatch.POST, ADMIN, "POST", "/api/finance/payables/batch", { rows, batchKey: `b-${++seq}`, ...extra }).then((r) => r.json());
  assert.equal((await send()).created, 1);
  const again = await send();
  assert.deepEqual(again.errors.map((e) => [e.line, e.duplicate]), [[1, true]]);
  assert.equal((await send({ allowDuplicates: true })).created, 1);
});

test("item com o mesmo nome na mesma categoria: criar devolve o existente; renomear para nome existente é recusado", async () => {
  const itemsRoute = await import("../app/api/finance/items/route.ts");
  const post = (body) => callRoute(itemsRoute.POST, ADMIN, "POST", "/api/finance/items", body);
  const first = await (await post({ name: "Combustível", categoryId: "cat-ocup" })).json();
  const again = await post({ name: "COMBUSTÍVEL ", categoryId: "cat-ocup" });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { created: false, existing: true, id: first.id });
  assert.equal((await post({ name: "COMBUSTÍVEL", categoryId: "cat-rh" })).status, 201); // outra categoria pode
  assert.equal((await post({ id: "item-luz", name: "combustível", categoryId: "cat-ocup" })).status, 409);
  assert.equal((await post({ id: first.id, name: "COMBUSTÍVEL", categoryId: "cat-ocup" })).status, 200); // salvar o próprio nome
});
