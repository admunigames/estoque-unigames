import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Financeiro 7/9 — Crediários: lógica pura (app/lib/credit-sales.ts) e rotas
// reais sobre SQLite (financeiras, cadastro individual/lote, ações em lote,
// vínculo com o extrato e desfazer, escopo de loja e 403).

const db = await setupRouteDb([
  "shared_state", "finance_accounts", "finance_bank_statement_entries", "finance_sales_recon_rows",
  "finance_credit_providers", "finance_credit_sales",
]);
const lib = await import("../app/lib/credit-sales.ts");
const providersRoute = await import("../app/api/finance/credit-providers/route.ts");
const salesRoute = await import("../app/api/finance/credit-sales/route.ts");
const batch = await import("../app/api/finance/credit-sales/batch/route.ts");
const bulk = await import("../app/api/finance/credit-sales/bulk/route.ts");
const link = await import("../app/api/finance/credit-sales/link/route.ts");
const bankEntry = await import("../app/api/finance/bank-reconciliation/[id]/route.ts");

// ---------------------------------------------------------------------------
// Lógica pura
// ---------------------------------------------------------------------------

test("computeCreditSale: pela taxa, pelo valor sem taxa, arredondamento e inválidos", () => {
  assert.deepEqual(lib.computeCreditSale({ grossCents: 100000, feeBps: 1000 }), { grossCents: 100000, feeBps: 1000, feeCents: 10000, netCents: 90000 });
  assert.deepEqual(lib.computeCreditSale({ grossCents: 100000, netCents: 90000 }), { grossCents: 100000, feeBps: 1000, feeCents: 10000, netCents: 90000 });
  // 3,33% de R$ 99,99 = 332,97 centavos → 333.
  assert.deepEqual(lib.computeCreditSale({ grossCents: 9999, feeBps: 333 }), { grossCents: 9999, feeBps: 333, feeCents: 333, netCents: 9666 });
  // Sem taxa digitado: taxa recalculada e arredondada em bps.
  assert.deepEqual(lib.computeCreditSale({ grossCents: 30000, netCents: 27777 }), { grossCents: 30000, feeBps: 741, feeCents: 2223, netCents: 27777 });
  assert.equal(lib.computeCreditSale({ grossCents: 0, feeBps: 100 }), null);
  assert.equal(lib.computeCreditSale({ grossCents: 1000, netCents: 1001 }), null);
  assert.equal(lib.computeCreditSale({ grossCents: 1000, feeBps: 10001 }), null);
});

test("situação derivada: pendente, finalizado (com diferença) e cancelado", () => {
  assert.equal(lib.creditSaleStatus({ canceled: 0, receivedDate: "" }), "pending");
  assert.equal(lib.creditSaleStatus({ canceled: 0, receivedDate: "2026-09-01" }), "finished");
  assert.equal(lib.creditSaleStatus({ canceled: 1, receivedDate: "2026-09-01" }), "canceled");
  assert.equal(lib.creditSaleDifference({ receivedDate: "2026-09-01", receivedCents: 8900, netCents: 9000 }), -100);
  assert.equal(lib.creditSaleDifference({ receivedDate: "", receivedCents: 0, netCents: 9000 }), 0);
});

test("suggestCreditSalesForDeposit: valor exato, combinação de 2–3, nenhum e limite de 8", () => {
  const sale = (id, providerId, netCents, saleDate = "2026-09-01") => ({ id, providerId, netCents, saleDate });
  const pending = [sale("a", "p1", 50000), sale("b", "p1", 30000), sale("c", "p1", 20000, "2026-09-02"), sale("x", "p2", 80000)];
  assert.deepEqual(lib.suggestCreditSalesForDeposit(80000, pending, "p2"), ["x"]);
  assert.deepEqual(lib.suggestCreditSalesForDeposit(80000, pending, "p1"), ["a", "b"]); // financeira identificada: só os dela
  assert.deepEqual(lib.suggestCreditSalesForDeposit(80000, pending), ["x"]);
  assert.deepEqual(lib.suggestCreditSalesForDeposit(100000, pending, "p1"), ["a", "b", "c"]);
  assert.deepEqual(lib.suggestCreditSalesForDeposit(70000, pending), ["a", "c"]);
  assert.deepEqual(lib.suggestCreditSalesForDeposit(12345, pending, "p1"), []);
  // Só os 8 mais antigos entram na combinação.
  const many = Array.from({ length: 10 }, (_, i) => sale(`s${i}`, "p1", 1000 + i, `2026-08-${String(10 + i).padStart(2, "0")}`));
  assert.deepEqual(lib.suggestCreditSalesForDeposit(1000 + 1001, many, "p1"), ["s0", "s1"]);
  assert.deepEqual(lib.suggestCreditSalesForDeposit(1008 + 1009, many, "p1"), []);
});

test("o front (crComputeSale) faz a mesma conta da função pura", async () => {
  const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
  const start = html.indexOf("function crComputeSale(");
  assert.notEqual(start, -1);
  let depth = 0, end = html.indexOf("{", start);
  for (; end < html.length; end++) {
    if (html[end] === "{") depth++;
    if (html[end] === "}" && --depth === 0) break;
  }
  const front = new Function(`${html.slice(start, end + 1)}; return crComputeSale;`)();
  for (const input of [{ grossCents: 100000, feeBps: 1000 }, { grossCents: 9999, feeBps: 333 }, { grossCents: 30000, netCents: 27777 },
    { grossCents: 0, feeBps: 1 }, { grossCents: 500, netCents: 600 }, { grossCents: 123456, feeBps: 0 }]) {
    assert.deepEqual(front(input), lib.computeCreditSale(input), JSON.stringify(input));
  }
});

// ---------------------------------------------------------------------------
// Rotas reais
// ---------------------------------------------------------------------------

const RIOMAR = "criomar01";
const TACARUNA = "ctacaruna1";
const ADMIN = { id: "admin", role: "admin" };
const RIOMAR_LOGIN = { id: "fin-r", companyId: RIOMAR, permissions: ["finance:manage"] };
const NO_FINANCE = { id: "loja", permissions: ["outputs:view"] };

db.sqlite.prepare("INSERT INTO shared_state (state_key, value_json) VALUES ('companies_list', ?)").run(JSON.stringify([
  { id: RIOMAR, name: "RIOMAR" }, { id: TACARUNA, name: "TACARUNA" },
]));
db.insert("finance_accounts", { id: "acc-r", name: "ITAÚ RIOMAR", company_id: RIOMAR });
db.insert("finance_accounts", { id: "acc-t", name: "BB TACARUNA", company_id: TACARUNA });
const entry = (id, row) => db.insert("finance_bank_statement_entries", { id, import_id: "b", status: "pending", in_dre: 1, ...row });
entry("dep2", { finance_account_id: "acc-r", company_id: RIOMAR, entry_date: "2026-09-20", description: "TED CREDFACIL FINANCEIRA", amount_cents: 135000 });
entry("dep-diff", { finance_account_id: "acc-r", company_id: RIOMAR, entry_date: "2026-09-21", description: "TED CREDFACIL", amount_cents: 44000 });
entry("debito", { finance_account_id: "acc-r", company_id: RIOMAR, entry_date: "2026-09-20", description: "TARIFA", amount_cents: -1500 });
entry("dep-tac", { finance_account_id: "acc-t", company_id: TACARUNA, entry_date: "2026-09-20", description: "TED CREDFACIL", amount_cents: 90000 });
db.insert("finance_sales_recon_rows", { id: "pv1", import_id: "i", company_id: RIOMAR, sale_date: "2026-09-01", sale_ref: "V100", payment_method: "other", amount_cents: 100000 });

const json = (response) => response.json();
const post = (handler, user, path, body) => callRoute(handler, user, "POST", path, body);
const get = (handler, user, path) => callRoute(handler, user, "GET", path);
const sale = (proposal) => db.sqlite.prepare("SELECT * FROM finance_credit_sales WHERE proposal=?").get(proposal);
const bankRow = (id) => ({ ...db.sqlite.prepare("SELECT status, in_dre FROM finance_bank_statement_entries WHERE id=?").get(id) });

test("sem finance:manage recebe 403", async () => {
  for (const [handler, method, path] of [
    [providersRoute.GET, "GET", "/api/finance/credit-providers"],
    [providersRoute.POST, "POST", "/api/finance/credit-providers"],
    [providersRoute.PUT, "PUT", "/api/finance/credit-providers"],
    [salesRoute.GET, "GET", "/api/finance/credit-sales"],
    [salesRoute.POST, "POST", "/api/finance/credit-sales"],
    [batch.POST, "POST", "/api/finance/credit-sales/batch"],
    [bulk.POST, "POST", "/api/finance/credit-sales/bulk"],
    [link.GET, "GET", "/api/finance/credit-sales/link"],
    [link.POST, "POST", "/api/finance/credit-sales/link"],
  ]) {
    const response = await callRoute(handler, NO_FINANCE, method, path, method === "GET" ? undefined : {});
    assert.equal(response.status, 403, `${method} ${path}`);
  }
});

let credfacil = "";
let lojaFin = "";
test("financeiras: cadastro, nome repetido 409, escopo de loja e exclusão só sem crediário", async () => {
  const created = await post(providersRoute.POST, ADMIN, "/api/finance/credit-providers", { name: "CredFácil", defaultFeeBps: 1000, bankKeyword: "CREDFACIL" });
  assert.equal(created.status, 201);
  credfacil = (await json(created)).id;
  assert.equal((await post(providersRoute.POST, ADMIN, "/api/finance/credit-providers", { name: "CREDFÁCIL" })).status, 409);
  // Login de loja cadastra na própria loja, mesmo pedindo outra.
  lojaFin = (await json(await post(providersRoute.POST, RIOMAR_LOGIN, "/api/finance/credit-providers", { name: "FIN LOJA", companyId: TACARUNA, defaultFeeBps: 500 }))).id;
  const own = db.sqlite.prepare("SELECT company_id FROM finance_credit_providers WHERE id=?").get(lojaFin);
  assert.equal(own.company_id, RIOMAR);
  // Global só quem vê todas as lojas edita.
  assert.equal((await callRoute(providersRoute.PUT, RIOMAR_LOGIN, "PUT", "/api/finance/credit-providers", { id: credfacil, name: "OUTRO NOME" })).status, 403);
  const tacFin = (await json(await post(providersRoute.POST, ADMIN, "/api/finance/credit-providers", { name: "SÓ TACARUNA", companyId: TACARUNA }))).id;
  const list = await json(await get(providersRoute.GET, RIOMAR_LOGIN, "/api/finance/credit-providers"));
  assert.deepEqual(list.providers.map((row) => row.name).sort(), ["CREDFÁCIL", "FIN LOJA"]);
  assert.equal((await callRoute(providersRoute.DELETE, ADMIN, "DELETE", `/api/finance/credit-providers?id=${tacFin}`)).status, 200);
});

test("NOVO CREDIÁRIO: taxa padrão da financeira, sem taxa digitado, proposta repetida 409 e aviso do Ponttie", async () => {
  const base = { companyId: RIOMAR, providerId: credfacil, saleDate: "2026-09-01", grossCents: 100000 };
  const first = await post(salesRoute.POST, ADMIN, "/api/finance/credit-sales", { ...base, saleRef: "V100", proposal: "p-1" });
  assert.equal(first.status, 201);
  assert.equal(sale("P-1").net_cents, 90000);
  assert.equal(sale("P-1").fee_cents, 10000);
  assert.equal(sale("P-1").provider_name, "CREDFÁCIL");
  const dup = await post(salesRoute.POST, ADMIN, "/api/finance/credit-sales", { ...base, proposal: "P-1" });
  assert.equal(dup.status, 409);
  assert.equal((await json(dup)).error, "PROPOSTA JÁ CADASTRADA.");
  await post(salesRoute.POST, ADMIN, "/api/finance/credit-sales", { ...base, saleDate: "2026-09-02", grossCents: 50000, netCents: 45000, proposal: "P-2" });
  assert.equal(sale("P-2").fee_bps, 1000);
  // Login de loja: crediário de outra loja vira da própria loja.
  await post(salesRoute.POST, RIOMAR_LOGIN, "/api/finance/credit-sales", { ...base, companyId: TACARUNA, proposal: "P-LOJA", grossCents: 20000 });
  assert.equal(sale("P-LOJA").company_id, RIOMAR);
  // Financeira de outra loja não atende.
  const tacOnly = await post(salesRoute.POST, ADMIN, "/api/finance/credit-sales", { ...base, companyId: TACARUNA, providerId: lojaFin, proposal: "P-X" });
  assert.equal(tacOnly.status, 400);
  const lookup = await json(await get(salesRoute.GET, ADMIN, `/api/finance/credit-sales?lookupSaleRef=V100&companyId=${RIOMAR}`));
  assert.deepEqual(lookup.ponttie, { saleDate: "2026-09-01", amountCents: 100000 });
  assert.equal((await json(await get(salesRoute.GET, ADMIN, `/api/finance/credit-sales?lookupSaleRef=NADA&companyId=${RIOMAR}`))).ponttie, null);
});

test("CADASTRAR EM LOTE: cria e pula (proposta repetida no banco e no próprio lote)", async () => {
  const res = await post(batch.POST, ADMIN, "/api/finance/credit-sales/batch", {
    companyId: RIOMAR, providerId: credfacil,
    rows: [
      { saleDate: "2026-09-03", proposal: "L-1", grossCents: 50000 },
      { saleDate: "2026-09-03", proposal: "P-1", grossCents: 1000 },
      { saleDate: "2026-09-04", proposal: "L-1", grossCents: 2000 },
      { saleDate: "2026-09-04", proposal: "L-2", grossCents: 10000, feeBps: 0 },
      { companyId: TACARUNA, saleDate: "2026-09-05", proposal: "L-T", grossCents: 100000 },
      { saleDate: "", proposal: "L-3", grossCents: 1000 },
    ],
  });
  assert.equal(res.status, 201);
  const body = await json(res);
  assert.equal(body.created, 3);
  assert.deepEqual(body.skipped.map((s) => [s.line, s.reason]), [[2, "PROPOSTA JÁ CADASTRADA."], [3, "PROPOSTA JÁ CADASTRADA."], [6, "INFORME A DATA DA VENDA."]]);
  assert.equal(sale("L-2").net_cents, 10000);
  assert.equal(sale("L-T").company_id, TACARUNA);
});

test("CLASSIFICAR EXTRATO: sugestão de 2 crediários, vínculo, entrada vira credit_sale e desfazer devolve", async () => {
  const listed = await json(await get(link.GET, ADMIN, `/api/finance/credit-sales/link?financeAccountId=acc-r&month=2026-09`));
  assert.deepEqual(listed.entries.map((e) => e.id).sort(), ["dep-diff", "dep2"]); // débito fora
  const dep = listed.entries.find((e) => e.id === "dep2");
  assert.equal(dep.providerName, "CREDFÁCIL");
  // 1.350,00 = P-1 (900,00) + P-2 (450,00).
  assert.deepEqual(dep.suggestedIds.sort(), [sale("P-1").id, sale("P-2").id].sort());

  const ok = await post(link.POST, ADMIN, "/api/finance/credit-sales/link", { bankEntryId: "dep2", creditSaleIds: dep.suggestedIds });
  assert.equal(ok.status, 200);
  assert.equal((await json(ok)).differenceCents, 0);
  assert.deepEqual(bankRow("dep2"), { status: "credit_sale", in_dre: 0 });
  assert.equal(sale("P-1").received_date, "2026-09-20");
  assert.equal(sale("P-1").received_cents, 90000);
  assert.equal(sale("P-2").bank_entry_id, "dep2");
  // Sai de "a classificar"; filtro CREDIÁRIO na Conciliação Bancária não muda nada além disso.
  const after = await json(await get(link.GET, ADMIN, `/api/finance/credit-sales/link?financeAccountId=acc-r&month=2026-09`));
  assert.deepEqual(after.entries.map((e) => e.id), ["dep-diff"]);
  // Entrada já vinculada: 409; débito recusado; crediário já finalizado: 409.
  assert.equal((await post(link.POST, ADMIN, "/api/finance/credit-sales/link", { bankEntryId: "dep2", creditSaleIds: [sale("L-1").id] })).status, 409);
  assert.equal((await post(link.POST, ADMIN, "/api/finance/credit-sales/link", { bankEntryId: "debito", creditSaleIds: [sale("L-1").id] })).status, 400);
  assert.equal((await post(link.POST, ADMIN, "/api/finance/credit-sales/link", { bankEntryId: "dep-diff", creditSaleIds: [sale("P-1").id] })).status, 409);
  // A Conciliação Bancária não reclassifica uma entrada de crediário.
  assert.equal((await callRoute(bankEntry.PATCH, ADMIN, "PATCH", "/api/finance/bank-reconciliation/dep2", { categoryItemId: "x" }, { id: "dep2" })).status, 409);

  // Desfazer um dos dois: a entrada só volta quando nenhum aponta mais para ela.
  await post(bulk.POST, ADMIN, "/api/finance/credit-sales/bulk", { action: "pending", ids: [sale("P-1").id] });
  assert.equal(sale("P-1").received_date, "");
  assert.equal(bankRow("dep2").status, "credit_sale");
  await post(bulk.POST, ADMIN, "/api/finance/credit-sales/bulk", { action: "pending", ids: [sale("P-2").id] });
  assert.deepEqual(bankRow("dep2"), { status: "pending", in_dre: 1 });
});

test("vínculo com diferença: rateia o depósito, anota e desfazer limpa a anotação", async () => {
  // L-1 = 450,00 sem taxa; depósito de 440,00.
  const res = await json(await post(link.POST, ADMIN, "/api/finance/credit-sales/link", { bankEntryId: "dep-diff", creditSaleIds: [sale("L-1").id] }));
  assert.equal(res.differenceCents, -1000);
  assert.equal(sale("L-1").received_cents, 44000);
  assert.match(sale("L-1").notes, /^\[DEPÓSITO\] DEPÓSITO DE R\$ 440,00 EM 21\/09\/2026 .* DIFERENÇA -R\$ 10,00\.$/);
  const listed = await json(await get(salesRoute.GET, ADMIN, `/api/finance/credit-sales?status=difference`));
  assert.deepEqual(listed.creditSales.map((row) => row.proposal), ["L-1"]);
  await post(bulk.POST, ADMIN, "/api/finance/credit-sales/bulk", { action: "pending", ids: [sale("L-1").id] });
  assert.equal(sale("L-1").notes, "");
  assert.equal(bankRow("dep-diff").status, "pending");
});

test("ações em lote: finalizar sem extrato, alterar financeira/taxa, cancelar e excluir", async () => {
  const ids = [sale("P-1").id, sale("P-2").id];
  assert.equal((await post(bulk.POST, ADMIN, "/api/finance/credit-sales/bulk", { action: "finish", ids, fields: {} })).status, 400);
  const fin = await json(await post(bulk.POST, ADMIN, "/api/finance/credit-sales/bulk", { action: "finish", ids, fields: { date: "2026-09-25" } }));
  assert.equal(fin.applied, 2);
  assert.equal(sale("P-2").received_cents, 45000);
  assert.equal(sale("P-2").bank_entry_id, "");
  const again = await json(await post(bulk.POST, ADMIN, "/api/finance/credit-sales/bulk", { action: "finish", ids: [ids[0]], fields: { date: "2026-09-25" } }));
  assert.deepEqual(again.skipped.map((s) => s.reason), ["JÁ FINALIZADO"]);

  const other = (await json(await post(providersRoute.POST, ADMIN, "/api/finance/credit-providers", { name: "BOA VISTA", defaultFeeBps: 800 }))).id;
  await post(bulk.POST, ADMIN, "/api/finance/credit-sales/bulk", { action: "provider", ids: [sale("L-2").id], fields: { providerId: other } });
  assert.equal(sale("L-2").provider_name, "BOA VISTA");
  assert.equal(sale("L-2").net_cents, 9200);
  await post(bulk.POST, ADMIN, "/api/finance/credit-sales/bulk", { action: "provider", ids: [sale("L-2").id], fields: { providerId: other, feeBps: 1500 } });
  assert.equal(sale("L-2").fee_cents, 1500);

  await post(bulk.POST, ADMIN, "/api/finance/credit-sales/bulk", { action: "cancel", ids: [sale("L-2").id] });
  assert.equal(sale("L-2").canceled, 1);
  const summary = await json(await get(salesRoute.GET, ADMIN, `/api/finance/credit-sales?status=canceled`));
  assert.deepEqual(summary.creditSales.map((row) => row.status), ["canceled"]);

  const missing = await post(bulk.POST, ADMIN, "/api/finance/credit-sales/bulk", { action: "delete", ids: [sale("L-2").id, "nao-existe"] });
  assert.equal(missing.status, 404);
  await post(bulk.POST, ADMIN, "/api/finance/credit-sales/bulk", { action: "delete", ids: [sale("L-2").id] });
  assert.equal(sale("L-2"), undefined);
  // Financeira com crediário não sai: só inativa.
  assert.equal((await callRoute(providersRoute.DELETE, ADMIN, "DELETE", `/api/finance/credit-providers?id=${credfacil}`)).status, 409);
});

test("escopo de loja: lista, lote, extrato e vínculo só da própria loja", async () => {
  const list = await json(await get(salesRoute.GET, RIOMAR_LOGIN, `/api/finance/credit-sales?companyId=${TACARUNA}`));
  assert.ok(list.creditSales.length > 0);
  assert.ok(list.creditSales.every((row) => row.companyId === RIOMAR));
  assert.equal((await post(bulk.POST, RIOMAR_LOGIN, "/api/finance/credit-sales/bulk", { action: "cancel", ids: [sale("L-T").id] })).status, 403);
  const entries = await json(await get(link.GET, RIOMAR_LOGIN, `/api/finance/credit-sales/link?month=2026-09`));
  assert.ok(entries.entries.every((e) => e.companyId === RIOMAR));
  assert.ok(entries.pending.every((row) => row.companyId === RIOMAR));
  assert.equal((await post(link.POST, RIOMAR_LOGIN, "/api/finance/credit-sales/link", { bankEntryId: "dep-tac", creditSaleIds: [sale("P-LOJA").id] })).status, 403);
  assert.equal((await post(link.POST, RIOMAR_LOGIN, "/api/finance/credit-sales/link", { bankEntryId: "dep-diff", creditSaleIds: [sale("L-T").id] })).status, 403);
});

test("cards: total pendente, finalizado e taxas do mês, pendentes há mais de 30 dias", async () => {
  db.insert("finance_credit_sales", { id: "old", company_id: RIOMAR, provider_id: credfacil, provider_name: "CREDFÁCIL", sale_date: "2020-01-01", proposal: "OLD", gross_cents: 1000, fee_cents: 100, net_cents: 900 });
  const { summary } = await json(await get(salesRoute.GET, ADMIN, `/api/finance/credit-sales?companyId=${RIOMAR}&month=2026-09`));
  // Pendentes da RIOMAR: L-1 (450,00), P-LOJA (180,00), OLD (9,00).
  assert.equal(summary.pendingCount, 3);
  assert.equal(summary.pendingCents, 45000 + 18000 + 900);
  assert.equal(summary.pendingOver30, 3);
  assert.equal(summary.finishedMonthCents, 90000 + 45000);
  assert.equal(summary.feesMonthCents, 10000 + 5000 + 5000 + 2000);
});
