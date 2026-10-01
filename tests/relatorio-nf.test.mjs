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
