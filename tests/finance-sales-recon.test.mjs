import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Financeiro 6/9 — Conciliação de Vendas: lógica pura (app/lib/sales-recon.ts)
// e rotas reais sobre SQLite (import do Ponttie com 2 lojas + reimportação,
// lote, CARTÃO × BANCO, ATUALIZAR FATURAMENTO, escopo de loja e 403).

const db = await setupRouteDb([
  "shared_state", "finance_acquirers", "finance_card_machines", "finance_card_machine_events", "finance_card_sales",
  "finance_bank_statement_entries", "finance_sales_recon_imports", "finance_sales_recon_rows", "finance_store_revenue",
]);
const recon = await import("../app/lib/sales-recon.ts");
const { machineCompanyAt } = await import("../app/lib/card-machines.ts");
const { ASSISTANCE_COMPANY_ID: ASSIST } = await import("../app/lib/card-fees.ts");
const salesRoute = await import("../app/api/finance/sales-recon/route.ts");
const bulk = await import("../app/api/finance/sales-recon/bulk/route.ts");
const deposits = await import("../app/api/finance/sales-recon/deposits/route.ts");
const summary = await import("../app/api/finance/sales-recon/summary/route.ts");
const applyRevenue = await import("../app/api/finance/sales-recon/apply-revenue/route.ts");

// ---------------------------------------------------------------------------
// Lógica pura
// ---------------------------------------------------------------------------

test("normalizePaymentMethod: dinheiro, pix, débito, crédito/parcelado e resto", () => {
  const cases = [["Dinheiro", "cash"], ["ESPÉCIE", "cash"], ["Pix", "pix"], ["Cartão de Débito", "debit"], ["Crédito à vista", "credit"],
    ["PARCELADO 3X", "credit"], ["Cartão", "credit"], ["Vale-troca", "other"], ["", "other"]];
  for (const [text, expected] of cases) assert.equal(recon.normalizePaymentMethod(text), expected, text);
});

test("classifySaleKind: palavras-chave de serviço, OS só no tipo, nº de OS", () => {
  assert.equal(recon.classifySaleKind({ type: "Serviço", description: "x" }), "service");
  assert.equal(recon.classifySaleKind({ type: "OS", description: "PS5" }), "service");
  assert.equal(recon.classifySaleKind({ type: "Produto", description: "TROCA DE TELA IPHONE" }), "service");
  assert.equal(recon.classifySaleKind({ description: "Limpeza do console" }), "service");
  assert.equal(recon.classifySaleKind({ description: "Conserto controle" }), "service");
  assert.equal(recon.classifySaleKind({ description: "O.S. 123" }), "service");
  assert.equal(recon.classifySaleKind({ description: "KIT COM OS CONTROLES" }), "sale");
  assert.equal(recon.classifySaleKind({ type: "Produto", description: "PS5", serviceOrder: "77" }), "service");
  assert.equal(recon.classifySaleKind({ type: "Produto", description: "JOGO FIFA" }), "sale");
});

test("resolveRevenueCompany: serviço → assistência; venda → loja da maquineta na data; dinheiro → loja do Ponttie", () => {
  const machine = { companyId: "ctacaruna1", companyName: "TACARUNA" };
  const transfers = [{ eventDate: "2026-08-20", fromCompanyId: "criomar01", fromCompanyName: "RIOMAR" }];
  const at = (date) => machineCompanyAt(machine, transfers, date).companyId;
  const base = { paymentMethod: "credit", saleCompanyId: "cshopping1" };
  assert.equal(recon.resolveRevenueCompany({ ...base, kind: "service", machineCompanyId: at("2026-08-10") }), ASSIST);
  assert.equal(recon.resolveRevenueCompany({ ...base, kind: "sale", machineCompanyId: at("2026-08-10") }), "criomar01");
  assert.equal(recon.resolveRevenueCompany({ ...base, kind: "sale", machineCompanyId: at("2026-08-25") }), "ctacaruna1");
  assert.equal(recon.resolveRevenueCompany({ ...base, kind: "sale", paymentMethod: "cash", machineCompanyId: "criomar01" }), "cshopping1");
  assert.equal(recon.resolveRevenueCompany({ ...base, kind: "sale", machineCompanyId: "" }), "cshopping1");
});

test("expectedDeposits: débito D+1, crédito D+30, parcelado por parcela, antecipado D+1", () => {
  const terms = { debitDays: 1, creditDays: 30, anticipated: false };
  assert.deepEqual(recon.expectedDeposits({ saleDate: "2026-08-10", modality: "debit", installments: 1, netCents: 9900, terms }),
    [{ date: "2026-08-11", netCents: 9900 }]);
  assert.deepEqual(recon.expectedDeposits({ saleDate: "2026-08-10", modality: "credit", installments: 1, netCents: 9700, terms }),
    [{ date: "2026-09-09", netCents: 9700 }]);
  assert.deepEqual(recon.expectedDeposits({ saleDate: "2026-08-10", modality: "credit", installments: 3, netCents: 10000, terms }),
    [{ date: "2026-09-09", netCents: 3333 }, { date: "2026-10-09", netCents: 3333 }, { date: "2026-11-08", netCents: 3334 }]);
  assert.deepEqual(recon.expectedDeposits({ saleDate: "2026-08-10", modality: "credit", installments: 3, netCents: 10000, terms: { ...terms, anticipated: true } }),
    [{ date: "2026-08-11", netCents: 10000 }]);
});

test("matchDepositsToSales: ok na tolerância, divergente, depósito sem venda, aguardando e não depositado", () => {
  const days = recon.matchDepositsToSales(
    [
      { saleId: "s1", acquirerId: "stone", date: "2026-08-11", netCents: 9900 },
      { saleId: "s2", acquirerId: "stone", date: "2026-08-11", netCents: 4950 },
      { saleId: "s3", acquirerId: "cielo", date: "2026-08-11", netCents: 19400 },
      { saleId: "s4", acquirerId: "cielo", date: "2026-08-05", netCents: 1000 },
      { saleId: "s5", acquirerId: "cielo", date: "2026-08-20", netCents: 1000 },
    ],
    [
      { entryId: "e1", acquirerId: "stone", date: "2026-08-11", amountCents: 14820 }, // R$ 0,30 a menos: tolerado
      { entryId: "e2", acquirerId: "cielo", date: "2026-08-11", amountCents: 19000 },
      { entryId: "e3", acquirerId: "stone", date: "2026-08-12", amountCents: 500 },
    ],
    "2026-08-15",
  );
  const status = Object.fromEntries(days.map((day) => [day.key, day.status]));
  assert.deepEqual(status, {
    "cielo|2026-08-05": "not_deposited",
    "cielo|2026-08-11": "divergent",
    "stone|2026-08-11": "ok",
    "stone|2026-08-12": "deposit_without_sale",
    "cielo|2026-08-20": "awaiting",
  });
  assert.equal(days.find((day) => day.key === "cielo|2026-08-11").differenceCents, -400);
});

test("depositMatchesKeyword: ignora acento, caixa, espaço e pontuação", () => {
  assert.equal(recon.depositMatchesKeyword("CIELO SA CREDITO", "Cielo S.A."), true);
  assert.equal(recon.depositMatchesKeyword("TED STONE PAGAMENTOS", "stone"), true);
  assert.equal(recon.depositMatchesKeyword("PIX RECEBIDO", "stone"), false);
  assert.equal(recon.depositMatchesKeyword("QUALQUER", ""), false);
});

test("allocateDeposit: proporcional ao líquido; sobra na maior venda", () => {
  const shares = recon.allocateDeposit(10001, [{ id: "a", netCents: 1000 }, { id: "b", netCents: 3000 }, { id: "c", netCents: 6000 }]);
  assert.deepEqual([...shares.entries()], [["a", 1000], ["b", 3000], ["c", 6001]]);
});

// ---------------------------------------------------------------------------
// Rotas reais
// ---------------------------------------------------------------------------

const RIOMAR = "criomar01";
const TACARUNA = "ctacaruna1";
const FABRICA = "cfabrica01";
const ADMIN = { id: "admin", role: "admin" };
const RIOMAR_LOGIN = { id: "fin-r", companyId: RIOMAR, permissions: ["finance:manage"] };
const NO_FINANCE = { id: "loja", permissions: ["outputs:view"] };

db.sqlite.prepare("INSERT INTO shared_state (state_key, value_json) VALUES ('companies_list', ?)").run(JSON.stringify([
  { id: RIOMAR, name: "RIOMAR" }, { id: TACARUNA, name: "TACARUNA" }, { id: FABRICA, name: "FÁBRICA" }, { id: ASSIST, name: "ASSISTÊNCIA" },
]));
db.insert("finance_acquirers", { id: "stone", name: "STONE", debit_days: 1, credit_days: 30, anticipated: 0, bank_keyword: "STONE" });
db.insert("finance_acquirers", { id: "cielo", name: "CIELO", debit_days: 1, credit_days: 30, anticipated: 1, bank_keyword: "Cielo" });
db.insert("finance_card_machines", { id: "m-riomar", acquirer_id: "stone", acquirer_name: "STONE", model: "S920", terminal: "111", company_id: RIOMAR, company_name: "RIOMAR", status: "active" });
db.insert("finance_card_machines", { id: "m-tac", acquirer_id: "cielo", acquirer_name: "CIELO", model: "LIO", terminal: "222", company_id: TACARUNA, company_name: "TACARUNA", status: "active" });
const cardSale = (id, row) => db.insert("finance_card_sales", { id, import_id: "i", acquirer_id: "stone", acquirer_name: "STONE", installments: 1, ...row });
cardSale("cs1", { company_id: RIOMAR, machine_id: "m-riomar", sale_date: "2026-08-10", modality: "debit", gross_cents: 10000, expected_fee_cents: 100, net_cents: 9900 });
cardSale("cs2", { company_id: TACARUNA, machine_id: "m-tac", acquirer_id: "cielo", acquirer_name: "CIELO", sale_date: "2026-08-10", modality: "credit", gross_cents: 20000, expected_fee_cents: 600, net_cents: 19400 });
const entry = (id, row) => db.insert("finance_bank_statement_entries", { id, import_id: "b", finance_account_id: "acc", company_id: RIOMAR, ...row });
entry("e1", { entry_date: "2026-08-11", description: "TED STONE PAGAMENTOS SA", amount_cents: 9900 });
entry("e2", { entry_date: "2026-08-11", description: "CIELO S.A. CREDITO", amount_cents: 19000 });
entry("e3", { entry_date: "2026-08-13", description: "PIX RECEBIDO MARIA", amount_cents: 5000 });
db.insert("finance_store_revenue", { id: "rev-riomar", store_id: RIOMAR, month: "2026-08", amount_cents: 1, sales_amount_cents: 1, services_amount_cents: 0, created_by: "seed" });
db.insert("finance_store_revenue", { id: "rev-fabrica", store_id: FABRICA, month: "2026-08", amount_cents: 777, sales_amount_cents: 777, services_amount_cents: 0, created_by: "seed" });

const json = (response) => response.json();
const post = (handler, user, path, body) => callRoute(handler, user, "POST", path, body);
const get = (handler, user, path) => callRoute(handler, user, "GET", path);
const rows = () => db.sqlite.prepare("SELECT * FROM finance_sales_recon_rows ORDER BY sale_ref, payment_method").all();

const FILE_A = [ // coluna de loja: "Loja Riomar" casa com RIOMAR
  { line: 2, saleDate: "2026-08-10", saleRef: "V1", store: "Loja Riomar", description: "CONTROLE PS5", type: "Produto", payment: "Dinheiro", amountCents: 3000 },
  { line: 3, saleDate: "2026-08-12", saleRef: "V2", store: "Loja Riomar", description: "JOGO", type: "Produto", payment: "PIX", amountCents: 5000 },
  { line: 4, saleDate: "2026-08-10", saleRef: "V3", store: "Loja Riomar", description: "HEADSET", type: "Produto", payment: "Cartão de Débito", amountCents: 10000, terminal: "111" },
  // Serviço pago na maquineta da TACARUNA: vai para a ASSISTÊNCIA.
  { line: 5, saleDate: "2026-08-10", saleRef: "OS9", store: "Loja Riomar", description: "TROCA DE TELA", type: "Serviço", payment: "Crédito", amountCents: 20000 },
];
const FILE_B = [ // sem coluna de loja: LOJA DO ARQUIVO = TACARUNA
  { line: 2, saleDate: "2026-08-15", saleRef: "T1", description: "PS5", type: "Produto", payment: "Crédito 2x", installments: 2, amountCents: 7000 },
  { line: 3, saleDate: "2026-08-16", saleRef: "T2", description: "CABO", type: "Produto", payment: "Dinheiro", amountCents: 1500 },
];

test("sem finance:manage recebe 403", async () => {
  for (const [handler, method, path] of [
    [salesRoute.GET, "GET", "/api/finance/sales-recon?month=2026-08"],
    [salesRoute.POST, "POST", "/api/finance/sales-recon"],
    [bulk.POST, "POST", "/api/finance/sales-recon/bulk"],
    [deposits.GET, "GET", "/api/finance/sales-recon/deposits?month=2026-08"],
    [deposits.POST, "POST", "/api/finance/sales-recon/deposits"],
    [summary.GET, "GET", "/api/finance/sales-recon/summary?month=2026-08"],
    [applyRevenue.POST, "POST", "/api/finance/sales-recon/apply-revenue"],
  ]) {
    const response = await callRoute(handler, NO_FINANCE, method, path, method === "POST" ? {} : undefined);
    assert.equal(response.status, 403, path);
  }
});

test("import Ponttie: 2 lojas, prévia no servidor, casamento e reimportação pula", async () => {
  const preview = await json(await post(salesRoute.POST, ADMIN, "/api/finance/sales-recon", { referenceMonth: "2026-08", dryRun: true, rows: FILE_A }));
  assert.equal(preview.toInsert, 4);
  assert.equal(rows().length, 0);
  const noStore = await json(await post(salesRoute.POST, ADMIN, "/api/finance/sales-recon", { referenceMonth: "2026-08", dryRun: true, rows: FILE_B }));
  assert.deepEqual([...new Set(noStore.skipped.map((s) => s.reason))], ["INFORME A LOJA DO ARQUIVO"]);

  const a = await json(await post(salesRoute.POST, ADMIN, "/api/finance/sales-recon", { referenceMonth: "2026-08", sourceName: "a.csv", rows: FILE_A }));
  assert.equal(a.inserted, 4);
  assert.equal(a.serviceCount, 1);
  const b = await json(await post(salesRoute.POST, ADMIN, "/api/finance/sales-recon", { referenceMonth: "2026-08", companyId: TACARUNA, rows: FILE_B }));
  assert.equal(b.inserted, 2);

  const byRef = Object.fromEntries(rows().map((row) => [row.sale_ref, row]));
  assert.equal(byRef.V1.company_id, RIOMAR);
  assert.equal(byRef.V1.revenue_company_id, RIOMAR); // dinheiro → loja do Ponttie
  assert.equal(byRef.V2.status, "matched"); // PIX casou com o crédito de 13/08 (±1 dia)
  assert.equal(byRef.V2.bank_entry_id, "e3");
  assert.equal(byRef.V3.status, "matched");
  assert.equal(byRef.V3.card_sale_id, "cs1");
  assert.equal(byRef.V3.revenue_company_id, RIOMAR);
  assert.equal(byRef.OS9.kind, "service");
  assert.equal(byRef.OS9.card_sale_id, "cs2"); // achou na maquineta de OUTRA loja
  assert.equal(byRef.OS9.machine_id, "m-tac");
  assert.equal(byRef.OS9.revenue_company_id, ASSIST);
  assert.equal(byRef.T1.status, "not_found");
  assert.equal(byRef.T1.company_id, TACARUNA);

  const again = await json(await post(salesRoute.POST, ADMIN, "/api/finance/sales-recon", { referenceMonth: "2026-08", rows: FILE_A }));
  assert.equal(again.inserted, 0);
  assert.deepEqual([...new Set(again.skipped.map((s) => s.reason))], ["JÁ IMPORTADA"]);
});

test("login com loja só importa e mexe na própria loja", async () => {
  const result = await json(await post(salesRoute.POST, RIOMAR_LOGIN, "/api/finance/sales-recon", {
    referenceMonth: "2026-08", dryRun: true,
    rows: [{ line: 2, saleDate: "2026-08-20", saleRef: "X", store: "TACARUNA", payment: "Dinheiro", amountCents: 100 }],
  }));
  assert.deepEqual(result.skipped, [{ line: 2, reason: "VENDA DE OUTRA LOJA" }]);
  const t1 = rows().find((row) => row.sale_ref === "T1").id;
  assert.equal((await post(bulk.POST, RIOMAR_LOGIN, "/api/finance/sales-recon/bulk", { action: "ignore", ids: [t1] })).status, 403);
  const list = await json(await get(salesRoute.GET, RIOMAR_LOGIN, "/api/finance/sales-recon?month=2026-08"));
  assert.ok(list.rows.every((row) => row.companyId === RIOMAR));
});

test("lote: serviço manual, ignorar, excluir, definir maquineta e conciliar de novo", async () => {
  const id = (ref) => rows().find((row) => row.sale_ref === ref).id;
  await post(bulk.POST, ADMIN, "/api/finance/sales-recon/bulk", { action: "service", ids: [id("V1")] });
  let v1 = rows().find((row) => row.sale_ref === "V1");
  assert.equal(v1.kind, "service");
  assert.equal(v1.kind_source, "manual");
  assert.equal(v1.revenue_company_id, ASSIST);
  await post(bulk.POST, ADMIN, "/api/finance/sales-recon/bulk", { action: "sale", ids: [id("V1")] });
  v1 = rows().find((row) => row.sale_ref === "V1");
  assert.equal(v1.revenue_company_id, RIOMAR);

  // Maquineta definida à mão: a venda passa a entrar na loja da maquineta.
  await post(bulk.POST, ADMIN, "/api/finance/sales-recon/bulk", { action: "machine", ids: [id("T1")], fields: { machineId: "m-riomar" } });
  assert.equal(rows().find((row) => row.sale_ref === "T1").revenue_company_id, RIOMAR);
  assert.equal((await post(bulk.POST, ADMIN, "/api/finance/sales-recon/bulk", { action: "machine", ids: [id("T1")], fields: { machineId: "nao" } })).status, 400);

  await post(bulk.POST, ADMIN, "/api/finance/sales-recon/bulk", { action: "ignore", ids: [id("T1")] });
  assert.equal(rows().find((row) => row.sale_ref === "T1").status, "ignored");

  // Conciliar de novo mantém o que já casou (libera e casa outra vez).
  await post(bulk.POST, ADMIN, "/api/finance/sales-recon/bulk", { action: "rematch", ids: [id("V3"), id("V2")] });
  assert.equal(rows().find((row) => row.sale_ref === "V3").card_sale_id, "cs1");
  assert.equal(rows().find((row) => row.sale_ref === "V2").bank_entry_id, "e3");

  await post(bulk.POST, ADMIN, "/api/finance/sales-recon/bulk", { action: "delete", ids: [id("T2")] });
  assert.equal(rows().some((row) => row.sale_ref === "T2"), false);
  assert.equal((await post(bulk.POST, ADMIN, "/api/finance/sales-recon/bulk", { action: "ignore", ids: ["sumiu"] })).status, 404);
});

test("cartão × banco: esperado × depositado por adquirente, conciliar e revisar", async () => {
  let data = await json(await get(deposits.GET, ADMIN, "/api/finance/sales-recon/deposits?month=2026-08"));
  const day = (key) => data.days.find((d) => d.key === key);
  assert.equal(day("stone|2026-08-11").status, "ok");
  assert.equal(day("cielo|2026-08-11").status, "divergent"); // antecipada: D+1
  assert.equal(day("cielo|2026-08-11").differenceCents, -400);
  assert.equal(data.days.some((d) => d.entries.some((e) => e.entryId === "e3")), false); // PIX não é de adquirente

  const applied = await json(await post(deposits.POST, ADMIN, "/api/finance/sales-recon/deposits", { action: "apply", month: "2026-08" }));
  assert.equal(applied.salesUpdated, 2);
  const sale = (id) => db.sqlite.prepare("SELECT received_amount_cents AS r, settled_at AS s FROM finance_card_sales WHERE id=?").get(id);
  assert.equal(sale("cs1").r, 9900);
  assert.equal(sale("cs2").r, 19000);
  assert.ok(sale("cs1").s);
  const entryOf = (id) => db.sqlite.prepare("SELECT sales_recon_status AS s, acquirer_id AS a FROM finance_bank_statement_entries WHERE id=?").get(id);
  assert.deepEqual({ ...entryOf("e1") }, { s: "ok", a: "stone" });
  assert.deepEqual({ ...entryOf("e2") }, { s: "divergent", a: "cielo" });

  const reviewed = await json(await post(deposits.POST, ADMIN, "/api/finance/sales-recon/deposits", {
    action: "review", month: "2026-08", ids: ["cielo|2026-08-11"], fields: { note: "Taxa de antecipação" },
  }));
  assert.equal(reviewed.applied, 1);
  data = await json(await get(deposits.GET, ADMIN, "/api/finance/sales-recon/deposits?month=2026-08"));
  assert.equal(day("cielo|2026-08-11").status, "reviewed");
  assert.equal(day("cielo|2026-08-11").note, "Taxa de antecipação");
});

test("resumo + ATUALIZAR FATURAMENTO: vendas/serviços por unidade e loja sem dados intocada", async () => {
  const data = await json(await get(summary.GET, ADMIN, "/api/finance/sales-recon/summary?month=2026-08"));
  const unit = (id) => data.units.find((u) => u.companyId === id);
  // RIOMAR: V1 3000 + V2 5000 + V3 10000 + T1 ignorada (fora).
  assert.deepEqual([unit(RIOMAR).salesCents, unit(RIOMAR).servicesCents], [18000, 0]);
  assert.equal(unit(RIOMAR).currentSalesCents, 1);
  assert.deepEqual([unit(ASSIST).salesCents, unit(ASSIST).servicesCents], [0, 20000]);
  assert.equal(unit(ASSIST).byMethod.credit, 20000);
  assert.equal(data.cards.ignored.count, 1);
  assert.equal(data.units.at(-1).companyId, ASSIST); // assistência por último

  const applied = await json(await post(applyRevenue.POST, ADMIN, "/api/finance/sales-recon/apply-revenue", { month: "2026-08" }));
  assert.equal(applied.applied, 2);
  const revenue = (store) => db.sqlite.prepare("SELECT * FROM finance_store_revenue WHERE store_id=? AND month='2026-08'").get(store);
  assert.deepEqual([revenue(RIOMAR).sales_amount_cents, revenue(RIOMAR).services_amount_cents, revenue(RIOMAR).amount_cents], [18000, 0, 18000]);
  assert.equal(revenue(RIOMAR).updated_by, "admin");
  assert.deepEqual([revenue(ASSIST).sales_amount_cents, revenue(ASSIST).services_amount_cents, revenue(ASSIST).amount_cents], [0, 20000, 20000]);
  assert.equal(revenue(FABRICA).amount_cents, 777); // sem vendas no Ponttie: intocada
  assert.equal(revenue(TACARUNA), undefined);

  // Login com loja: só a própria loja (sem ASSISTÊNCIA).
  const own = await json(await get(summary.GET, RIOMAR_LOGIN, "/api/finance/sales-recon/summary?month=2026-08"));
  assert.deepEqual(own.units.map((u) => u.companyId), [RIOMAR]);
  const ownApply = await json(await post(applyRevenue.POST, RIOMAR_LOGIN, "/api/finance/sales-recon/apply-revenue", { month: "2026-08" }));
  assert.deepEqual(ownApply.units.map((u) => u.companyId), [RIOMAR]);
});
