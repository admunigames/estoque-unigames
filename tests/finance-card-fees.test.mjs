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

test("computeCardReconStatus: pending → ok → attention conforme o cruzamento da taxa (itens 5 e 6)", () => {
  assert.equal(
    fees.computeCardReconStatus({ feeMissing: true, grossCents: 10000, expectedFeeCents: 0, receivedCents: null }),
    "attention",
  );
  assert.equal(
    fees.computeCardReconStatus({ feeMissing: false, grossCents: 10000, expectedFeeCents: 200, receivedCents: null }),
    "pending",
  );
  assert.equal(
    fees.computeCardReconStatus({ feeMissing: false, grossCents: 10000, expectedFeeCents: 200, receivedCents: 9800 }),
    "ok",
  );
  assert.equal(
    fees.computeCardReconStatus({ feeMissing: false, grossCents: 10000, expectedFeeCents: 200, receivedCents: 9799 }),
    "ok",
  );
  assert.equal(
    fees.computeCardReconStatus({ feeMissing: false, grossCents: 10000, expectedFeeCents: 200, receivedCents: 9650 }),
    "attention",
  );
  assert.equal(
    fees.computeCardReconStatus({
      feeMissing: true, grossCents: 10000, expectedFeeCents: 0, receivedCents: null, reviewedAt: "2026-09-03",
    }),
    "reviewed",
  );
});

test("actualFeeBps: taxa efetiva cobrada pela adquirente em basis points", () => {
  assert.equal(fees.actualFeeBps(10000, null), null);
  assert.equal(fees.actualFeeBps(10000, 9800), 200);
  assert.equal(fees.actualFeeBps(10000, 9650), 350);
  assert.equal(fees.actualFeeBps(0, 0), null);
});

test("resolveCardFee: taxa da maquineta ganha da adquirente; sem cobertura cai na adquirente (5/9)", () => {
  const base = { acquirerId: "cielo", brand: "", modality: "credit", installments: 1, anticipationBps: 0, validFrom: "2026-01-01", validTo: "" };
  const table = [
    { id: "adq", ...base, feeBps: 300 },
    { id: "adq-loja-b", ...base, companyId: "clojabb", feeBps: 280 },
    { id: "maq", ...base, machineId: "m1", feeBps: 199 },
    { id: "maq-antiga", ...base, machineId: "m1", feeBps: 250, validFrom: "2025-01-01", validTo: "2025-12-31" },
    { id: "maq-visa", ...base, machineId: "m1", brand: "Visa", feeBps: 150 },
  ];
  const sale = { acquirerId: "cielo", brand: "Elo", modality: "credit", installments: 1, date: "2026-08-01" };
  assert.equal(fees.resolveCardFee(table, { ...sale, machineId: "m1" })?.id, "maq");
  assert.equal(fees.resolveCardFee(table, { ...sale, machineId: "m1", brand: "visa" })?.id, "maq-visa");
  // Vigência vale no nível da maquineta: em 2025 vale a versão antiga.
  assert.equal(fees.resolveCardFee(table, { ...sale, machineId: "m1", date: "2025-06-01" })?.id, "maq-antiga");
  // Maquineta sem taxa própria / parcela sem taxa própria → adquirente.
  assert.equal(fees.resolveCardFee(table, { ...sale, machineId: "m2" })?.id, "adq");
  assert.equal(fees.resolveCardFee(table, { ...sale, machineId: "m1", installments: 3 }), null);
  // Taxa de adquirente por unidade só vale para vendas daquela unidade.
  assert.equal(fees.resolveCardFee(table, { ...sale, companyId: "clojabb" })?.id, "adq-loja-b");
  assert.equal(fees.resolveCardFee(table, { ...sale, companyId: "clojaaa" })?.id, "adq");
});

test("conferência na importação: taxa cobrada do arquivo × cadastrada pela tolerância", () => {
  assert.equal(fees.resolveChargedFeeCents({ grossCents: 10000, feeCents: 250 }), 250);
  assert.equal(fees.resolveChargedFeeCents({ grossCents: 10000, feeBps: 199 }), 199);
  // Arquivo só com líquido: bruto − líquido.
  assert.equal(fees.resolveChargedFeeCents({ grossCents: 10000, netCents: 9700 }), 300);
  assert.equal(fees.resolveChargedFeeCents({ grossCents: 10000 }), null);
  assert.equal(fees.resolveChargedFeeCents({ grossCents: 10000, netCents: 12000 }), null);

  const check = (charged, expected = 200, gross = 10000, feeMissing = false) =>
    fees.computeFeeCheck({ grossCents: gross, expectedFeeCents: expected, chargedFeeCents: charged, feeMissing });
  assert.equal(check(null), "");
  assert.equal(check(210), "ok"); // R$ 0,10 de diferença: dentro da tolerância
  assert.equal(check(260), "divergent"); // R$ 0,60 e 0,60 p.p.: fora
  assert.equal(check(260, 200, 100000), "ok"); // em R$ 1.000, 0,06 p.p. é tolerado
  assert.equal(check(500, 0, 10000, true), ""); // sem taxa cadastrada vai como SEM TAXA
});

test("summarizeCardFeeTotals: LOJAS × ASSISTÊNCIA, por unidade, maquineta e adquirente/bandeira", () => {
  const sale = (row) => ({ machineId: "m1", machineLabel: "STONE S920 1", acquirerName: "STONE", brand: "VISA", feeMissing: false, chargedFeeCents: null, ...row });
  const result = fees.summarizeCardFeeTotals([
    sale({ companyId: "criomar01", companyName: "RIOMAR", grossCents: 10000, expectedFeeCents: 200, chargedFeeCents: 260 }),
    sale({ companyId: "ctacaruna1", companyName: "TACARUNA", grossCents: 20000, expectedFeeCents: 400, machineId: "m2", machineLabel: "STONE 2" }),
    sale({ companyId: fees.ASSISTANCE_COMPANY_ID, companyName: "ASSISTÊNCIA", grossCents: 5000, expectedFeeCents: 100, chargedFeeCents: 90, brand: "ELO" }),
  ]);
  assert.equal(result.totals.grossCents, 35000);
  assert.equal(result.totals.feeCents, 260 + 400 + 90); // cobrada quando houver, senão a cadastrada
  assert.equal(result.totals.overchargedCents, 60);
  assert.equal(result.totals.differenceCents, 60 - 10);
  assert.equal(result.totals.fromFilePct, Math.round((350 / 750) * 100));
  assert.equal(result.totals.feeBps, Math.round((750 / 35000) * 10000));
  assert.deepEqual(result.split.map((r) => [r.label, r.grossCents, r.feeCents]), [["LOJAS", 30000, 660], ["ASSISTÊNCIA", 5000, 90]]);
  assert.deepEqual(result.byCompany.map((r) => r.label), ["TACARUNA", "RIOMAR", "ASSISTÊNCIA"]);
  assert.equal(result.byMachine.find((r) => r.key === "m1").salesCount, 2);
  assert.deepEqual(result.byAcquirerBrand.map((r) => r.label).sort(), ["STONE · ELO", "STONE · VISA"]);
});

test("Financeiro Fase 7: Taxas de Cartão (hoje dentro de Maquinetas) + religação dos Recebíveis", async () => {
  const [html, workerSource, schema, migration, receivablesShared, receivablesRoute] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0040_finance_card_fees.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/receivables/shared.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/receivables/route.ts", import.meta.url), "utf8"),
  ]);

  // Financeiro 5/9: a tela virou abas de Maquinetas; o link antigo continua
  // servido pelo worker e cai em Maquinetas > TAXAS.
  assert.doesNotMatch(html, /id="navFinanceiroTaxasCartao"/);
  assert.doesNotMatch(html, /id="pageFinanceiroTaxasCartao"/);
  assert.doesNotMatch(html, /financeiroTaxasCartao/);
  assert.match(html, /'\/financeiro\/taxas-cartao':'financeiroMaquinetas'/);
  assert.match(workerSource, /"\/financeiro\/taxas-cartao"/);

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
