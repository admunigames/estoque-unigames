import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Financeiro Fase 7 — Cartões de Crédito Corporativos. Lógica pura +
// verificação da regra de segurança (nenhum campo de senha/CVV) e do
// registro do módulo.

const cards = await import("../app/lib/corporate-cards.ts");

test("SEGURANÇA: hasForbiddenCardKey pega senha/CVV em qualquer grafia", () => {
  assert.equal(cards.hasForbiddenCardKey({ name: "X", last4: "1234" }), false);
  assert.equal(cards.hasForbiddenCardKey({ cvv: "123" }), true);
  assert.equal(cards.hasForbiddenCardKey({ CVC: "1" }), true);
  assert.equal(cards.hasForbiddenCardKey({ "código de segurança": "1" }), true);
  assert.equal(cards.hasForbiddenCardKey({ senha: "abc" }), true);
  assert.equal(cards.hasForbiddenCardKey({ Password: "abc" }), true);
});

test("validateCorporateCardDraft: nome, 4 dígitos e dias 1-31", () => {
  assert.equal(
    cards.validateCorporateCardDraft({ name: "Nu", last4: "1234", bestPurchaseDay: 0, closingDay: 10, dueDay: 17 }),
    null,
  );
  assert.match(
    cards.validateCorporateCardDraft({ name: "Nu", last4: "12", bestPurchaseDay: 0, closingDay: 10, dueDay: 17 }) ?? "",
    /4 NÚMEROS/,
  );
  assert.match(
    cards.validateCorporateCardDraft({ name: "Nu", last4: "1234", bestPurchaseDay: 0, closingDay: 40, dueDay: 17 }) ?? "",
    /FECHAMENTO/,
  );
});

test("parseInstallmentLabel entende 2/6, 02 / 06, 2 de 6", () => {
  assert.deepEqual(cards.parseInstallmentLabel("2/6"), { current: 2, total: 6, label: "2/6" });
  assert.deepEqual(cards.parseInstallmentLabel("PARCELA 02 / 06"), { current: 2, total: 6, label: "2/6" });
  assert.deepEqual(cards.parseInstallmentLabel("3 de 3"), { current: 3, total: 3, label: "3/3" });
  assert.deepEqual(cards.parseInstallmentLabel("à vista"), { current: 1, total: 1, label: "" });
});

test("invoiceCycleDates: próximo fechamento e vencimento", () => {
  // Hoje 10/08, fecha dia 20, vence dia 5 -> fecha 2026-08-20, vence 2026-09-05.
  const a = cards.invoiceCycleDates("2026-08-10", 20, 5);
  assert.equal(a.closingDate, "2026-08-20");
  assert.equal(a.dueDate, "2026-09-05");
  // Hoje 25/08 (já passou o fechamento) -> próximo fechamento em setembro.
  const b = cards.invoiceCycleDates("2026-08-25", 20, 5);
  assert.equal(b.closingDate, "2026-09-20");
  assert.equal(b.previousClosing, "2026-08-20");
});

test("computeCardSummary: utilizado = fatura em aberto + parcelas futuras", () => {
  const summary = cards.computeCardSummary({
    limitCents: 500_000,
    closingDay: 20,
    dueDay: 5,
    today: "2026-08-10",
    entries: [
      { entryDate: "2026-08-05", amountCents: 30_000, installmentCurrent: 1, installmentTotal: 1 },
      { entryDate: "2026-08-08", amountCents: 10_000, installmentCurrent: 1, installmentTotal: 4 },
      { entryDate: "2026-07-01", amountCents: 99_999, installmentCurrent: 1, installmentTotal: 1 },
    ],
  });
  assert.equal(summary.currentInvoiceCents, 40_000); // as duas de agosto, dentro do ciclo
  assert.equal(summary.futureInstallmentsCents, 30_000); // 10.000 * (4-1)
  assert.equal(summary.usedCents, 70_000);
  assert.equal(summary.availableCents, 430_000);
});

test("Financeiro Fase 7: módulo Cartões Corporativos registrado, sem campo de senha/CVV", async () => {
  const [html, workerSource, schema, migration, cardRoute] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0041_finance_corporate_cards.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/corporate-cards/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(
    html,
    /id="navFinanceiroCartoesCorp" data-page="financeiroCartoesCorp" data-permission="finance"[^>]*href="\/financeiro\/cartoes-corporativos"/,
  );
  assert.match(html, /id="pageFinanceiroCartoesCorp" class="page wrap"/);
  assert.match(html, /financeiroCartoesCorp:'\/financeiro\/cartoes-corporativos'/);
  assert.match(workerSource, /"\/financeiro\/cartoes-corporativos"/);
  assert.equal(html.split("if(name === 'financeiroCartoesCorp') loadCartoesCorpPage();").length - 1, 2);

  // SEGURANÇA: o formulário do cartão e o schema não têm campo de senha/CVV.
  assert.doesNotMatch(schema, /finance_corporate_cards[\s\S]{0,900}?(cvv|cvc|"?senha"?|security_code|password)/i);
  assert.match(cardRoute, /hasForbiddenCardKey/);
  assert.doesNotMatch(html, /id="corpCard(Cvv|Cvc|Senha|Password)"/i);
  assert.match(migration, /CREATE TABLE "finance_corporate_cards"/);
  assert.match(migration, /CREATE TABLE "finance_card_invoice_entries"/);

  // "Adicionar como Despesa" reaproveita o endpoint /expenses existente.
  assert.match(html, /financeApiRequest\('\/expenses'/);

  // pdf.js entra sob demanda (não como <script> estático) e do mesmo CDN
  // já usado para o Excel.
  assert.match(html, /cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js/);
  assert.doesNotMatch(html, /<script[^>]+src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js/);
});
