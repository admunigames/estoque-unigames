import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Financeiro Fase 7 — Taxas de Cartão. Lógica pura em app/lib/card-fees.ts +
// verificações de registro do módulo no HTML/worker/schema/migration e da
// religação dos Recebíveis ao cadastro de adquirentes.

const fees = await import("../app/lib/card-fees.ts");

test("resolveCardFee: adquirente e modalidade têm que bater; parcelas só para crédito", () => {
  const base = { brand: "", modality: "credit", installments: 1, feeBps: 200, anticipationBps: 0, validFrom: "", validTo: "" };
  const table = [
    { id: "a", acquirerId: "cielo", ...base },
    { id: "b", acquirerId: "cielo", ...base, modality: "debit", feeBps: 100 },
    { id: "c", acquirerId: "cielo", ...base, installments: 3, feeBps: 350 },
    { id: "d", acquirerId: "rede", ...base, feeBps: 999 },
  ];
  assert.equal(fees.resolveCardFee(table, { acquirerId: "cielo", brand: "", modality: "credit", installments: 1, date: "2026-08-01" })?.id, "a");
  assert.equal(fees.resolveCardFee(table, { acquirerId: "cielo", brand: "", modality: "debit", installments: 1, date: "2026-08-01" })?.id, "b");
  assert.equal(fees.resolveCardFee(table, { acquirerId: "cielo", brand: "", modality: "credit", installments: 3, date: "2026-08-01" })?.id, "c");
  assert.equal(fees.resolveCardFee(table, { acquirerId: "stone", brand: "", modality: "credit", installments: 1, date: "2026-08-01" }), null);
});

test("resolveCardFee: bandeira específica ganha da curinga e vigência é respeitada", () => {
  const table = [
    { id: "wild", acquirerId: "cielo", brand: "", modality: "credit", installments: 1, feeBps: 200, anticipationBps: 0, validFrom: "2026-01-01", validTo: "" },
    { id: "visa", acquirerId: "cielo", brand: "Visa", modality: "credit", installments: 1, feeBps: 150, anticipationBps: 0, validFrom: "2026-01-01", validTo: "" },
    { id: "old", acquirerId: "cielo", brand: "Visa", modality: "credit", installments: 1, feeBps: 300, anticipationBps: 0, validFrom: "2025-01-01", validTo: "2025-12-31" },
  ];
  assert.equal(fees.resolveCardFee(table, { acquirerId: "cielo", brand: "visa", modality: "credit", installments: 1, date: "2026-08-01" })?.id, "visa");
  assert.equal(fees.resolveCardFee(table, { acquirerId: "cielo", brand: "Elo", modality: "credit", installments: 1, date: "2026-08-01" })?.id, "wild");
  // Antes da vigência da taxa nova: cai na curinga (a 'old' já expirou).
  assert.equal(fees.resolveCardFee(table, { acquirerId: "cielo", brand: "visa", modality: "credit", installments: 1, date: "2024-06-01" }), null);
});

test("computeSaleFinance: taxa + antecipação em bps sobre o bruto", () => {
  assert.deepEqual(fees.computeSaleFinance({ grossCents: 100_00, feeBps: 200, anticipationBps: 100 }), {
    expectedFeeCents: 300,
    netCents: 9700,
  });
  assert.deepEqual(fees.computeSaleFinance({ grossCents: 100_00, feeBps: 0 }), { expectedFeeCents: 0, netCents: 10000 });
});

test("computeDivergenceCents: null até o repasse; recebido − líquido depois", () => {
  assert.equal(fees.computeDivergenceCents(9700, null), null);
  assert.equal(fees.computeDivergenceCents(9700, 9700), 0);
  assert.equal(fees.computeDivergenceCents(9700, 9650), -50);
});

test("summarizeMonthlyFees: agrega por adquirente+bandeira, custo real usa repasse quando existe", () => {
  const { rows, totals } = fees.summarizeMonthlyFees([
    { acquirerName: "Cielo", brand: "Visa", grossCents: 10000, expectedFeeCents: 200, netCents: 9800, receivedCents: 9750 },
    { acquirerName: "Cielo", brand: "Visa", grossCents: 5000, expectedFeeCents: 100, netCents: 4900, receivedCents: null },
    { acquirerName: "Rede", brand: "Master", grossCents: 20000, expectedFeeCents: 600, netCents: 19400, receivedCents: 19400 },
  ]);
  const cielo = rows.find((r) => r.acquirerName === "Cielo");
  assert.equal(cielo.salesCount, 2);
  assert.equal(cielo.grossCents, 15000);
  // custo real: (10000-9750) da conciliada + 100 (taxa prevista) da pendente.
  assert.equal(cielo.actualCostCents, 250 + 100);
  assert.equal(cielo.divergenceCents, 9750 - 9800);
  assert.equal(totals.grossCents, 35000);
  assert.equal(totals.salesCount, 3);
});

test("Financeiro Fase 7: Taxas de Cartão registrado + religação dos Recebíveis", async () => {
  const [html, workerSource, schema, migration, receivablesShared, receivablesRoute] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0040_finance_card_fees.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/receivables/shared.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/receivables/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(
    html,
    /id="navFinanceiroTaxasCartao" data-page="financeiroTaxasCartao" data-permission="finance"[^>]*href="\/financeiro\/taxas-cartao"/,
  );
  assert.match(html, /id="pageFinanceiroTaxasCartao" class="page wrap"/);
  assert.match(html, /financeiroTaxasCartao:'\/financeiro\/taxas-cartao'/);
  assert.match(html, /financeiroTaxasCartao:'finance'/);
  assert.match(workerSource, /"\/financeiro\/taxas-cartao"/);
  assert.equal(html.split("if(name === 'financeiroTaxasCartao') loadTaxasCartaoPage();").length - 1, 2);

  // Importação reaproveita o leitor de planilha já existente (nada de CDN novo).
  assert.match(html, /extractRowsFromFile\(file\)/);
  assert.doesNotMatch(html, /cdn\.jsdelivr|unpkg\.com/i);

  // Schema/migration das 3 tabelas + coluna acquirer_id nos Recebíveis.
  assert.match(schema, /export const financeCardFees = pgTable\(\s*"finance_card_fees"/);
  assert.match(schema, /export const financeCardSales = pgTable\(\s*"finance_card_sales"/);
  assert.match(schema, /export const financeCardSalesImports = pgTable\(\s*"finance_card_sales_imports"/);
  assert.match(migration, /CREATE TABLE "finance_card_fees"/);
  assert.match(migration, /ALTER TABLE "accounts_receivable" ADD COLUMN "acquirer_id"/);
  assert.match(migration, /UPDATE "accounts_receivable"[\s\S]*finance_acquirers/);

  // Recebíveis agora resolvem a operadora pelo cadastro de adquirentes,
  // mantendo operator_text como snapshot.
  assert.match(receivablesShared, /export async function resolveReceivableOperator/);
  assert.match(receivablesShared, /finance_acquirers/);
  assert.match(receivablesRoute, /resolveReceivableOperator/);
  assert.match(html, /id="receivableAcquirer"/);
});
