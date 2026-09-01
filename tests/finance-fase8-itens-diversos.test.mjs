import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Financeiro Fase 8 — Itens Diversos: Controle de Reposição, Recargas de
// Celulares e Declaração de Shopping. Lógica pura do alerta de aluguel
// percentual + registro dos três módulos.

const mall = await import("../app/lib/mall-declarations.ts");

test("addThreeMonths soma 3 meses de calendário preservando fim de mês", () => {
  assert.equal(mall.addThreeMonths("2026-01-31"), "2026-04-30");
  assert.equal(mall.addThreeMonths("2026-09-01"), "2026-12-01");
  assert.equal(mall.addThreeMonths("2026-11-30"), "2027-02-28");
  assert.equal(mall.addThreeMonths(""), "");
});

test("deriveMallDeclaration: ponto de virada = mínimo / percentual", () => {
  // 7% e aluguel mínimo R$ 7.000,00 -> ponto de virada R$ 100.000,00.
  const d = mall.deriveMallDeclaration({
    realRevenueCents: 8_000_000,
    declaredCents: 5_000_000,
    avgDeclaredCents: 4_000_000,
    contractPercentBps: 700,
    minimumRentCents: 700_000,
  });
  assert.equal(d.breakpointCents, 10_000_000);
});

test("deriveMallDeclaration: alerta usa o FATURAMENTO REAL, mesmo com declarado abaixo", () => {
  const d = mall.deriveMallDeclaration({
    realRevenueCents: 12_000_000, // acima do ponto de virada (10M)
    declaredCents: 8_000_000, // abaixo do ponto de virada
    avgDeclaredCents: 8_000_000,
    contractPercentBps: 700,
    minimumRentCents: 700_000,
  });
  assert.equal(d.alertLevel, "real");
  assert.match(d.alertMessage, /FATURAMENTO REAL/);
});

test("deriveMallDeclaration: alerta forte quando o próprio declarado passa do ponto", () => {
  const d = mall.deriveMallDeclaration({
    realRevenueCents: 12_000_000,
    declaredCents: 11_000_000,
    avgDeclaredCents: 8_000_000,
    contractPercentBps: 700,
    minimumRentCents: 700_000,
  });
  assert.equal(d.alertLevel, "declared");
  assert.equal(d.declaredVsAverageCents, 3_000_000);
});

test("deriveMallDeclaration: sem percentual/mínimo não há ponto de virada nem alerta", () => {
  const d = mall.deriveMallDeclaration({
    realRevenueCents: 99_999_999,
    declaredCents: 99_999_999,
    avgDeclaredCents: 0,
    contractPercentBps: 0,
    minimumRentCents: 0,
  });
  assert.equal(d.breakpointCents, 0);
  assert.equal(d.alertLevel, "none");
});

test("Financeiro Fase 8: os três módulos estão registrados", async () => {
  const [html, workerSource, schema, migration, replRoute, rechargeRoute, mallRoute] = await Promise.all([
    readFile(new URL("../public/estoque.html", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0043_finance_fase8_itens_diversos.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/replacement-control/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/phone-recharges/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/finance/mall-declarations/route.ts", import.meta.url), "utf8"),
  ]);

  for (const [nav, page, route] of [
    ["navFinanceiroReposicao", "financeiroReposicao", "/financeiro/controle-reposicao"],
    ["navFinanceiroRecargas", "financeiroRecargas", "/financeiro/recargas-celular"],
    ["navFinanceiroDeclaracaoShopping", "financeiroDeclaracaoShopping", "/financeiro/declaracao-shopping"],
  ]) {
    assert.match(html, new RegExp(`id="${nav}" data-page="${page}" data-permission="finance"`));
    assert.ok(html.includes(`href="${route}"`), `${route} no nav`);
    assert.ok(workerSource.includes(`"${route}"`), `${route} no worker APP_ROUTE_PATHS`);
    assert.equal(html.split(`if(name === '${page}')`).length - 1, 2);
  }
  assert.match(html, /id="pageFinanceiroReposicao" class="page wrap"/);
  assert.match(html, /id="pageFinanceiroRecargas" class="page wrap"/);
  assert.match(html, /id="pageFinanceiroDeclaracaoShopping" class="page wrap"/);

  // Migration cria as 5 tabelas da fase.
  for (const table of [
    "finance_replacement_entries",
    "finance_phone_recharges",
    "finance_phone_recharge_events",
    "finance_mall_declarations",
    "finance_mall_declaration_attachments",
  ]) {
    assert.match(schema, new RegExp(`"${table}"`));
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  }

  // Reaproveitamento: reposição vira despesa pelo endpoint /expenses; não
  // duplica lógica de despesa.
  assert.match(html, /financeApiRequest\('\/expenses'/);
  assert.match(replRoute, /canManageFinance/);
  assert.match(rechargeRoute, /addThreeMonths/);
  assert.match(mallRoute, /deriveMallDeclaration/);

  // Lembrete de recarga: push ao Financeiro pelo cron, sem módulo paralelo.
  assert.match(workerSource, /dispatchDuePhoneRechargeNotifications/);
  assert.match(workerSource, /finance_phone_recharges/);
});
