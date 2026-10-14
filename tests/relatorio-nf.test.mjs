import assert from "node:assert/strict";
import test from "node:test";

const { computeNfStorePct, computeNfTotals } = await import("../app/lib/relatorio-nf.ts");

test("computeNfStorePct retorna 0 quando não há vendas (sem divisão por zero)", () => {
  assert.equal(computeNfStorePct(0, 0), 0);
  assert.equal(computeNfStorePct(0, 3), 0);
});

test("computeNfStorePct calcula % de emissão normal", () => {
  assert.equal(computeNfStorePct(10, 8), 80);
  assert.equal(computeNfStorePct(3, 3), 100);
});

test("computeNfTotals soma vendas/emitidas/valores de várias lojas", () => {
  const totals = computeNfTotals([
    { storeId: "a", storeName: "A", salesCount: 10, invoicesIssuedCount: 8, salesAmountCents: 100000, invoicesIssuedAmountCents: 80000 },
    { storeId: "b", storeName: "B", salesCount: 5, invoicesIssuedCount: 5, salesAmountCents: 50000, invoicesIssuedAmountCents: 50000 },
  ]);
  assert.equal(totals.totalSalesCount, 15);
  assert.equal(totals.totalInvoicesIssuedCount, 13);
  assert.equal(totals.totalSalesAmountCents, 150000);
  assert.equal(totals.totalInvoicesIssuedAmountCents, 130000);
  assert.equal(totals.pendingCount, 2);
  assert.equal(totals.pendingAmountCents, 20000);
});

test("computeNfTotals nunca deixa pendente negativo (emitida > venda por erro de digitação)", () => {
  const totals = computeNfTotals([
    { storeId: "a", storeName: "A", salesCount: 5, invoicesIssuedCount: 7, salesAmountCents: 50000, invoicesIssuedAmountCents: 70000 },
  ]);
  assert.equal(totals.pendingCount, 0);
  assert.equal(totals.pendingAmountCents, 0);
});

test("computeNfTotals com lista vazia retorna tudo zerado", () => {
  const totals = computeNfTotals([]);
  assert.equal(totals.totalSalesCount, 0);
  assert.equal(totals.pctIssued, 0);
});

// Rota real: Assistência e Depósito não vendem — ficam fora da lista, dos
// totais e do histórico, e o lançamento para elas é recusado. Lançamento
// antigo dessas empresas continua no banco.
const { callRoute, setupRouteDb } = await import("./helpers/route-db.mjs");
const db = await setupRouteDb(["shared_state", "commercial_nf_report_entries"]);
const route = await import("../app/api/relatorio-nf/route.ts");
db.insert("shared_state", {
  state_key: "companies_list",
  value_json: JSON.stringify([
    { id: "loja", name: "RIOMAR" },
    { id: "assist", name: "ASSISTÊNCIA" },
    { id: "dep", name: "DEPÓSITO" },
  ]),
});
db.insert("commercial_nf_report_entries", {
  id: "antigo", report_date: "2026-10-13", store_id: "assist", store_name: "ASSISTÊNCIA",
  sales_count: 50, invoices_issued_count: 0, sales_amount_cents: 999999, invoices_issued_amount_cents: 0,
});
const NF = { id: "nf", permissions: ["relatorio_nf:manage"] };
const nfCall = (method, body, query = "") => callRoute(route[method], NF, method, `/api/relatorio-nf${query}`, body);
const nfEntry = (storeId, storeName) => ({ storeId, storeName, salesCount: 10, invoicesIssuedCount: 8, salesAmountCents: 1000, invoicesIssuedAmountCents: 800 });

test("Relatório NF: Assistência/Depósito recusadas no lançamento e fora da lista, totais e histórico", async () => {
  assert.equal((await nfCall("POST", { date: "2026-10-13", entries: [nfEntry("assist", "ASSISTÊNCIA")] })).status, 400);
  assert.equal((await nfCall("POST", { date: "2026-10-13", entries: [nfEntry("dep", "DEPÓSITO")] })).status, 400);
  assert.equal((await nfCall("POST", { date: "2026-10-13", entries: [nfEntry("loja", "RIOMAR")] })).status, 200);

  const day = await (await nfCall("GET", undefined, "?date=2026-10-13")).json();
  assert.deepEqual(day.companies.map((company) => company.id), ["loja"]);
  assert.deepEqual(day.entries.map((entry) => entry.storeId), ["loja"]);
  assert.equal(day.totals.totalSalesCount, 10);
  assert.equal(day.totals.totalSalesAmountCents, 1000);

  const history = await (await nfCall("GET", undefined, "?view=history")).json();
  assert.equal(history.rows[0].totalSalesCount, 10);
  // Nada apagado: o lançamento antigo da Assistência continua no banco.
  const kept = await db.prepare("SELECT sales_count AS salesCount FROM commercial_nf_report_entries WHERE store_id=?1").bind("assist").first();
  assert.equal(kept.salesCount, 50);
});
