import assert from "node:assert/strict";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Financeiro 5/9 — Maquinetas (rotas reais sobre SQLite): taxa por
// maquineta (tabela, copiar em lote, encerrar vigência), arquivo de vendas
// com várias lojas + maquineta desconhecida + transferência, reimportação,
// escopo de loja, conferência/revisão em lote, total de taxas e repasse
// casando pela maquineta. 403 sem finance:manage.

const db = await setupRouteDb([
  "shared_state", "finance_acquirers", "finance_card_machines", "finance_card_machine_events",
  "finance_card_fees", "finance_card_sales_imports", "finance_card_sales",
]);

const machinesBulk = await import("../app/api/finance/card-machines/bulk/route.ts");
const machinesRoute = await import("../app/api/finance/card-machines/route.ts");
const feesRoute = await import("../app/api/finance/card-fees/route.ts");
const feesTable = await import("../app/api/finance/card-fees/table/route.ts");
const feesBulk = await import("../app/api/finance/card-fees/bulk/route.ts");
const feesTotals = await import("../app/api/finance/card-fees/totals/route.ts");
const sales = await import("../app/api/finance/card-sales/route.ts");
const salesBulk = await import("../app/api/finance/card-sales/bulk/route.ts");
const conference = await import("../app/api/finance/card-sales/conference/route.ts");
const { ASSISTANCE_COMPANY_ID } = await import("../app/lib/card-fees.ts");

const RIOMAR = "criomar01";
const TACARUNA = "ctacaruna1";
const ADMIN = { id: "admin", role: "admin" };
const STORE_LOGIN = { id: "fin-r", companyId: RIOMAR, permissions: ["finance:manage"] };
const NO_FINANCE = { id: "loja", permissions: ["outputs:view"] };

db.sqlite
  .prepare("INSERT INTO shared_state (state_key, value_json) VALUES ('companies_list', ?)")
  .run(JSON.stringify([
    { id: RIOMAR, name: "RIOMAR" },
    { id: TACARUNA, name: "TACARUNA" },
    { id: ASSISTANCE_COMPANY_ID, name: "ASSISTÊNCIA" },
  ]));
db.insert("finance_acquirers", { id: "stone", name: "STONE" });
const machine = (id, row) =>
  db.insert("finance_card_machines", { id, acquirer_id: "stone", acquirer_name: "STONE", model: "S920", status: "active", ...row });
machine("m-riomar", { terminal: "00012345", serial: "SR1", company_id: RIOMAR, company_name: "RIOMAR" });
machine("m-tacaruna", { terminal: "777", serial: "ST2", company_id: TACARUNA, company_name: "TACARUNA" });
// Hoje na ASSISTÊNCIA, mas até 31/08 estava na TACARUNA.
machine("m-assist", { terminal: "888", serial: "SA3", company_id: ASSISTANCE_COMPANY_ID, company_name: "ASSISTÊNCIA" });
db.insert("finance_card_machine_events", {
  id: "ev1", machine_id: "m-assist", kind: "transfer", event_date: "2026-09-01",
  from_company_id: TACARUNA, from_company_name: "TACARUNA", to_company_id: ASSISTANCE_COMPANY_ID,
});
// Taxa padrão da adquirente: crédito à vista 3%.
db.insert("finance_card_fees", { id: "f-adq", acquirer_id: "stone", acquirer_name: "STONE", modality: "credit", installments: 1, fee_bps: 300, valid_from: "2026-01-01" });

const json = (response) => response.json();
const post = (handler, user, path, body) => callRoute(handler, user, "POST", path, body);
const get = (handler, user, path) => callRoute(handler, user, "GET", path);
const fees = () => db.sqlite.prepare("SELECT * FROM finance_card_fees ORDER BY machine_id, valid_from").all();

test("sem finance:manage recebe 403 nas rotas novas", async () => {
  for (const [handler, method, path] of [
    [machinesBulk.POST, "POST", "/api/finance/card-machines/bulk"],
    [feesTable.POST, "POST", "/api/finance/card-fees/table"],
    [feesBulk.POST, "POST", "/api/finance/card-fees/bulk"],
    [feesTotals.GET, "GET", "/api/finance/card-fees/totals?from=2026-08"],
    [salesBulk.POST, "POST", "/api/finance/card-sales/bulk"],
    [conference.GET, "GET", "/api/finance/card-sales/conference?from=2026-08-01&to=2026-08-31"],
    [sales.POST, "POST", "/api/finance/card-sales"],
  ]) {
    const response = await callRoute(handler, NO_FINANCE, method, path, method === "POST" ? {} : undefined);
    assert.equal(response.status, 403, path);
  }
});

test("tabela da maquineta + nova versão encerra a anterior na véspera + copiar em lote + encerrar vigência", async () => {
  let response = await post(feesTable.POST, ADMIN, "/api/finance/card-fees/table", {
    machineId: "m-riomar", validFrom: "2026-01-01",
    rows: [{ modality: "debit", feeBps: 100 }, { modality: "credit", installments: 1, feeBps: 250 }],
  });
  assert.equal(response.status, 201);
  response = await post(feesTable.POST, ADMIN, "/api/finance/card-fees/table", {
    machineId: "m-riomar", validFrom: "2026-08-01", rows: [{ modality: "credit", installments: 1, feeBps: 200 }],
  });
  assert.equal(response.status, 201);
  const riomar = fees().filter((f) => f.machine_id === "m-riomar" && f.modality === "credit");
  assert.deepEqual(riomar.map((f) => [f.fee_bps, f.valid_from, f.valid_to]), [[250, "2026-01-01", "2026-07-31"], [200, "2026-08-01", ""]]);

  // Coluna TAXAS: própria × da adquirente.
  const list = await json(await get(machinesRoute.GET, ADMIN, "/api/finance/card-machines"));
  assert.equal(list.machines.find((m) => m.id === "m-riomar").feeSource, "machine");
  assert.equal(list.machines.find((m) => m.id === "m-tacaruna").feeSource, "acquirer");

  // Copiar a tabela VIGENTE da m-riomar para m-tacaruna (+ a própria, pulada).
  const copy = await json(await post(machinesBulk.POST, ADMIN, "/api/finance/card-machines/bulk", {
    action: "copy_fees", ids: ["m-tacaruna", "m-riomar"], fields: { sourceMachineId: "m-riomar" },
  }));
  assert.equal(copy.applied, 1);
  assert.equal(copy.skipped[0].reason, "É A PRÓPRIA MAQUINETA-MODELO");
  const copied = fees().filter((f) => f.machine_id === "m-tacaruna");
  assert.deepEqual(copied.map((f) => [f.modality, f.fee_bps, f.company_id]).sort(), [["credit", 200, TACARUNA], ["debit", 100, TACARUNA]]);

  // Encerrar vigência em lote (a taxa da m-tacaruna de débito).
  const debit = copied.find((f) => f.modality === "debit");
  const closed = await json(await post(feesBulk.POST, ADMIN, "/api/finance/card-fees/bulk", {
    action: "close", ids: [debit.id], fields: { validTo: "2026-12-31" },
  }));
  assert.equal(closed.applied, 1);
  assert.equal(fees().find((f) => f.id === debit.id).valid_to, "2026-12-31");
  assert.equal((await post(feesBulk.POST, ADMIN, "/api/finance/card-fees/bulk", { action: "delete", ids: ["nao-existe"] })).status, 404);
  // Login com loja não mexe em taxa global nem de outra loja.
  assert.equal((await post(feesBulk.POST, STORE_LOGIN, "/api/finance/card-fees/bulk", { action: "delete", ids: [debit.id] })).status, 403);

  // Inativar / reativar.
  const inactive = await json(await post(machinesBulk.POST, ADMIN, "/api/finance/card-machines/bulk", { action: "inactivate", ids: ["m-tacaruna"] }));
  assert.equal(inactive.applied, 1);
  const again = await json(await post(machinesBulk.POST, ADMIN, "/api/finance/card-machines/bulk", { action: "inactivate", ids: ["m-tacaruna"] }));
  assert.equal(again.skipped[0].reason, "NÃO ESTÁ ATIVA");
  await post(machinesBulk.POST, ADMIN, "/api/finance/card-machines/bulk", { action: "reactivate", ids: ["m-tacaruna"] });

  // Taxa avulsa (NOVA TAXA) com maquineta de outra adquirente é recusada.
  db.insert("finance_acquirers", { id: "cielo", name: "CIELO" });
  const wrong = await post(feesRoute.POST, ADMIN, "/api/finance/card-fees", { acquirerId: "cielo", machineId: "m-riomar", modality: "pix", feeBps: 50 });
  assert.equal(wrong.status, 400);
});

const FILE_ROWS = [
  // RIOMAR, crédito com taxa no arquivo divergente (cadastrada 2%, cobrou 2,6%).
  { line: 2, saleDate: "2026-08-10", terminal: "12345", modality: "credit", installments: 1, nsu: "N1", grossCents: 10000, feeCents: 260 },
  // TACARUNA, débito só com líquido: 1% = ok.
  { line: 3, saleDate: "2026-08-10", terminal: "000777", modality: "debit", nsu: "N2", grossCents: 20000, netCents: 19800 },
  // Maquineta hoje na ASSISTÊNCIA, venda de AGOSTO → TACARUNA (data da venda).
  { line: 4, saleDate: "2026-08-20", serial: "sa3", modality: "credit", nsu: "N3", grossCents: 5000 },
  // Mesma maquineta em SETEMBRO → ASSISTÊNCIA.
  { line: 5, saleDate: "2026-09-02", terminal: "888", modality: "credit", nsu: "N4", grossCents: 3000, feeCents: 90 },
  // Maquineta não cadastrada.
  { line: 6, saleDate: "2026-08-11", terminal: "4242", acquirerName: "STONE", modality: "credit", nsu: "N5", grossCents: 7000 },
];

test("arquivo de vendas: unidade pela maquineta na data, conferência e maquineta não cadastrada", async () => {
  const preview = await json(await post(sales.POST, ADMIN, "/api/finance/card-sales", {
    kind: "sales", referenceMonth: "2026-08", dryRun: true, rows: FILE_ROWS,
  }));
  assert.equal(preview.dryRun, true);
  const byLine = new Map(preview.rows.map((row) => [row.line, row]));
  assert.equal(byLine.get(2).companyId, RIOMAR);
  assert.equal(byLine.get(2).expectedFeeCents, 200); // taxa da maquineta (vigente em agosto)
  assert.equal(byLine.get(2).chargedFeeCents, 260);
  assert.equal(byLine.get(2).feeCheck, "divergent");
  assert.equal(byLine.get(2).reconStatus, "attention");
  assert.equal(byLine.get(3).companyId, TACARUNA);
  assert.equal(byLine.get(3).feeCheck, "ok");
  assert.equal(byLine.get(3).reconStatus, "ok");
  assert.equal(byLine.get(4).companyId, TACARUNA);
  assert.equal(byLine.get(4).expectedFeeCents, 150); // sem taxa própria → adquirente 3%
  assert.equal(byLine.get(5).companyId, ASSISTANCE_COMPANY_ID);
  assert.equal(byLine.get(6).rejected, "MAQUINETA NÃO CADASTRADA (SEM UNIDADE PADRÃO)");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM finance_card_sales").get().n, 0);

  // Com UNIDADE PADRÃO, a linha sem maquineta vai para ela.
  const result = await json(await post(sales.POST, ADMIN, "/api/finance/card-sales", {
    kind: "sales", referenceMonth: "2026-08", companyId: RIOMAR, sourceName: "stone.csv", fileHash: "h1", rows: FILE_ROWS,
  }));
  assert.equal(result.inserted, 5);
  assert.equal(result.divergentCount, 1);
  assert.equal(result.noMachineCount, 1);
  const stored = db.sqlite.prepare("SELECT nsu, company_id, machine_id, terminal_ref, charged_fee_cents, fee_check FROM finance_card_sales ORDER BY nsu").all();
  assert.deepEqual(stored.map((row) => [row.nsu, row.company_id, row.machine_id]), [
    ["N1", RIOMAR, "m-riomar"], ["N2", TACARUNA, "m-tacaruna"], ["N3", TACARUNA, "m-assist"],
    ["N4", ASSISTANCE_COMPANY_ID, "m-assist"], ["N5", RIOMAR, ""],
  ]);
  assert.equal(stored[0].terminal_ref, "12345");
  assert.equal(stored[1].charged_fee_cents, 200);
  // Um cabeçalho de importação por unidade do arquivo.
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM finance_card_sales_imports").get().n, 3);

  // Reimportação: tudo JÁ IMPORTADA.
  const again = await json(await post(sales.POST, ADMIN, "/api/finance/card-sales", {
    kind: "sales", referenceMonth: "2026-08", companyId: RIOMAR, fileHash: "h2", rows: FILE_ROWS,
  }));
  assert.equal(again.inserted, 0);
  assert.deepEqual([...new Set(again.skipped.map((s) => s.reason))], ["JÁ IMPORTADA"]);
});

test("login com loja só importa venda de maquineta da própria loja", async () => {
  const result = await json(await post(sales.POST, STORE_LOGIN, "/api/finance/card-sales", {
    kind: "sales", referenceMonth: "2026-08", rows: [
      { line: 2, saleDate: "2026-08-15", terminal: "12345", modality: "debit", nsu: "L1", grossCents: 1000 },
      { line: 3, saleDate: "2026-08-15", terminal: "777", modality: "debit", nsu: "L2", grossCents: 1000 },
    ],
  }));
  assert.equal(result.inserted, 1);
  assert.deepEqual(result.skipped, [{ line: 3, reason: "VENDA DE OUTRA UNIDADE" }]);
});

test("conferência + revisão/exclusão em lote", async () => {
  let data = await json(await get(conference.GET, ADMIN, "/api/finance/card-sales/conference?from=2026-08-01&to=2026-09-30"));
  const divergent = data.rows.filter((row) => row.feeCheck === "divergent");
  assert.equal(divergent.length, 1);
  assert.equal(divergent[0].differenceCents, 60);
  assert.equal(data.totals.overchargedCents, 60);
  assert.equal(data.summary[0].acquirerName, "STONE");

  // Login de loja não revisa venda de outra loja.
  const tacarunaSale = db.sqlite.prepare("SELECT id FROM finance_card_sales WHERE nsu='N2'").get().id;
  assert.equal((await post(salesBulk.POST, STORE_LOGIN, "/api/finance/card-sales/bulk", { action: "review", ids: [tacarunaSale] })).status, 403);

  const reviewed = await json(await post(salesBulk.POST, ADMIN, "/api/finance/card-sales/bulk", {
    action: "review", ids: [divergent[0].id], fields: { note: "Taxa promocional" },
  }));
  assert.equal(reviewed.applied, 1);
  data = await json(await get(conference.GET, ADMIN, "/api/finance/card-sales/conference?from=2026-08-01&to=2026-09-30&status=divergent"));
  assert.equal(data.rows.length, 0);
  data = await json(await get(conference.GET, ADMIN, "/api/finance/card-sales/conference?from=2026-08-01&to=2026-09-30&status=reviewed"));
  assert.equal(data.rows[0].reviewedNote, "Taxa promocional");

  const extra = db.sqlite.prepare("SELECT id FROM finance_card_sales WHERE nsu='L1'").get().id;
  const deleted = await json(await post(salesBulk.POST, ADMIN, "/api/finance/card-sales/bulk", { action: "delete", ids: [extra] }));
  assert.equal(deleted.applied, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM finance_card_sales WHERE nsu='L1'").get().n, 0);
});

test("total de taxas: LOJAS × ASSISTÊNCIA e escopo de loja", async () => {
  const data = await json(await get(feesTotals.GET, ADMIN, "/api/finance/card-fees/totals?from=2026-08&to=2026-09"));
  // N1 cobrou 260, N2 cobrou 200, N3 cadastrada 150, N4 cobrou 90, N5 cadastrada 210.
  assert.equal(data.totals.grossCents, 10000 + 20000 + 5000 + 3000 + 7000);
  assert.equal(data.totals.feeCents, 260 + 200 + 150 + 90 + 210);
  assert.deepEqual(data.split.map((row) => [row.label, row.feeCents]), [["LOJAS", 260 + 200 + 150 + 210], ["ASSISTÊNCIA", 90]]);
  assert.ok(data.byMachine.some((row) => row.key === "m-assist" && row.salesCount === 2));

  const own = await json(await get(feesTotals.GET, STORE_LOGIN, "/api/finance/card-fees/totals?from=2026-08&to=2026-09"));
  assert.deepEqual(own.byCompany.map((row) => row.label), ["RIOMAR"]);
});

test("repasse casa pela maquineta quando a linha traz o terminal", async () => {
  const result = await json(await post(sales.POST, ADMIN, "/api/finance/card-sales", {
    kind: "settlement", referenceMonth: "2026-08", companyId: RIOMAR, fileHash: "rep1",
    rows: [{ terminal: "777", saleDate: "2026-08-10", grossCents: 20000, receivedCents: 19800 }],
  }));
  // A venda N2 é da TACARUNA, mas a maquineta identifica: casa mesmo com a unidade RIOMAR escolhida.
  assert.equal(result.matched, 1);
  assert.equal(db.sqlite.prepare("SELECT received_amount_cents AS r FROM finance_card_sales WHERE nsu='N2'").get().r, 19800);
});
