import assert from "node:assert/strict";
import test from "node:test";

const {
  computeSellerMetrics,
  isSellerRole,
  monthClock,
  nextTarget,
  progressPercent,
  progressTier,
  realizedFromEntries,
} = await import("../app/lib/commercial.ts");

const emptyRealized = realizedFromEntries([]);

function realized({ revenue = 0, items = 0, warranty = 0 } = {}) {
  return {
    faturamento: { loja: revenue, online: 0, total: revenue },
    itens: { loja: items, online: 0, total: items },
    garantia: { loja: warranty, online: 0, total: warranty },
  };
}

const goal = { targetRevenueCents: 10_000_000, targetItems: 100, targetWarrantyCents: 500_000 };
const clock = monthClock("2026-09", "2026-09-21");

test("isSellerRole: comparação normalizada do CARGO (texto livre)", () => {
  assert.equal(isSellerRole("Vendedor"), true);
  assert.equal(isSellerRole("VENDEDOR(A)"), true);
  assert.equal(isSellerRole("vendedora"), true);
  assert.equal(isSellerRole("  Vendedor Externo "), true);
  assert.equal(isSellerRole("VENDÉDOR"), true);
  assert.equal(isSellerRole("Gerente"), false);
  assert.equal(isSellerRole(""), false);
});

test("realizedFromEntries: lançamento acumulado mais recente vale, por canal/tipo", () => {
  const result = realizedFromEntries([
    { channel: "loja", kind: "faturamento", value: 100_00, entryDate: "2026-09-05", createdAt: "a" },
    { channel: "loja", kind: "faturamento", value: 300_00, entryDate: "2026-09-10", createdAt: "a" },
    { channel: "loja", kind: "faturamento", value: 250_00, entryDate: "2026-09-08", createdAt: "z" },
    { channel: "online", kind: "faturamento", value: 50_00, entryDate: "2026-09-10", createdAt: "a" },
    { channel: "online", kind: "faturamento", value: 70_00, entryDate: "2026-09-10", createdAt: "b" },
    { channel: "loja", kind: "itens", value: 7, entryDate: "2026-09-01", createdAt: "a" },
    { channel: "xpto", kind: "itens", value: 999, entryDate: "2026-09-30", createdAt: "a" },
  ]);
  assert.deepEqual(result.faturamento, { loja: 300_00, online: 70_00, total: 370_00 });
  assert.deepEqual(result.itens, { loja: 7, online: 0, total: 7 });
  assert.deepEqual(result.garantia, { loja: 0, online: 0, total: 0 });
});

test("progressPercent/progressTier: vermelho < 80 ≤ amarelo < 100 ≤ verde", () => {
  assert.equal(progressPercent(0, 0), null);
  assert.equal(progressTier(null), "none");
  assert.equal(progressTier(progressPercent(79_99, 100_00)), "red");
  assert.equal(progressPercent(79_99, 100_00), 79.9);
  assert.equal(progressTier(80), "yellow");
  assert.equal(progressTier(99.9), "yellow");
  assert.equal(progressTier(100), "green");
  assert.equal(progressTier(135), "green");
});

test("comissão de faturamento: 0 abaixo de 80%, 0,4% de 80% a 99,9%, 0,6% a partir de 100%", () => {
  const below = computeSellerMetrics(goal, realized({ revenue: 7_999_999 }), clock).commission;
  assert.equal(below.revenueRate, 0);
  assert.equal(below.revenueCommissionCents, 0);

  const low = computeSellerMetrics(goal, realized({ revenue: 8_000_000 }), clock).commission;
  assert.equal(low.revenueRate, 0.004);
  assert.equal(low.revenueCommissionCents, 32_000); // R$ 320,00 sobre R$ 80.000

  const almost = computeSellerMetrics(goal, realized({ revenue: 9_999_999 }), clock).commission;
  assert.equal(almost.revenueRate, 0.004);

  const high = computeSellerMetrics(goal, realized({ revenue: 10_000_000 }), clock).commission;
  assert.equal(high.revenueRate, 0.006);
  assert.equal(high.revenueCommissionCents, 60_000); // R$ 600,00 sobre R$ 100.000
});

test("premiação por itens NÃO cumulativa: R$ 500 em 110%, R$ 1.500 em 120%", () => {
  assert.equal(computeSellerMetrics(goal, realized({ items: 109 }), clock).commission.itemsPremiumCents, 0);
  assert.equal(computeSellerMetrics(goal, realized({ items: 110 }), clock).commission.itemsPremiumCents, 50_000);
  assert.equal(computeSellerMetrics(goal, realized({ items: 119 }), clock).commission.itemsPremiumCents, 50_000);
  assert.equal(computeSellerMetrics(goal, realized({ items: 120 }), clock).commission.itemsPremiumCents, 150_000);
  assert.equal(computeSellerMetrics(goal, realized({ items: 400 }), clock).commission.itemsPremiumCents, 150_000);
});

test("garantia estendida: 4% fixo sobre o realizado, mesmo sem meta", () => {
  const withGoal = computeSellerMetrics(goal, realized({ warranty: 123_45 }), clock).commission;
  assert.equal(withGoal.warrantyCommissionCents, 494); // 4% de R$ 123,45 = R$ 4,938
  const noGoal = computeSellerMetrics(null, realized({ warranty: 100_000 }), clock).commission;
  assert.equal(noGoal.warrantyCommissionCents, 4_000);
  assert.equal(noGoal.totalCents, 4_000);
});

test("total estimado soma as três regras", () => {
  const metrics = computeSellerMetrics(goal, realized({ revenue: 12_000_000, items: 121, warranty: 200_000 }), clock);
  assert.equal(metrics.commission.revenueCommissionCents, 72_000);
  assert.equal(metrics.commission.itemsPremiumCents, 150_000);
  assert.equal(metrics.commission.warrantyCommissionCents, 8_000);
  assert.equal(metrics.commission.totalCents, 230_000);
});

test("sem meta cadastrada: nada de faixa nem premiação", () => {
  const metrics = computeSellerMetrics(null, realized({ revenue: 99_999_999, items: 999 }), clock);
  assert.equal(metrics.revenue.percent, null);
  assert.equal(metrics.revenue.next, null);
  assert.equal(metrics.commission.revenueCommissionCents, 0);
  assert.equal(metrics.commission.itemsPremiumCents, 0);
  assert.equal(emptyRealized.faturamento.total, 0);
});

test("monthClock: dias restantes contam hoje; mês passado = 0; futuro = mês inteiro", () => {
  assert.deepEqual(monthClock("2026-09", "2026-09-21"), {
    month: "2026-09", today: "2026-09-21", daysInMonth: 30, daysRemaining: 10, status: "current",
  });
  assert.equal(monthClock("2026-09", "2026-09-30").daysRemaining, 1);
  assert.equal(monthClock("2026-08", "2026-09-21").daysRemaining, 0);
  assert.equal(monthClock("2026-08", "2026-09-21").status, "past");
  assert.equal(monthClock("2026-10", "2026-09-21").daysRemaining, 31);
  assert.equal(monthClock("2028-02", "2026-09-21").daysInMonth, 29);
});

test("nextTarget: próximo alvo, quanto falta e média diária (diferença ÷ dias restantes)", () => {
  const thresholds = [80, 100, 110, 120];
  // Meta R$ 100.000, realizado R$ 74.000, 10 dias restantes → Alvo 1 (R$ 80.000)
  const next = nextTarget(7_400_000, 10_000_000, thresholds, clock);
  assert.deepEqual(next, { index: 1, percent: 80, value: 8_000_000, missing: 600_000, perDay: 60_000 });
  // Já passou do Alvo 2 → próximo é o Alvo 3 (110%)
  assert.equal(nextTarget(10_500_000, 10_000_000, thresholds, clock).index, 3);
  // Todos batidos
  assert.equal(nextTarget(12_000_000, 10_000_000, thresholds, clock), null);
  // Mês encerrado: sem média diária
  assert.equal(nextTarget(0, 10_000_000, thresholds, monthClock("2026-08", "2026-09-21")).perDay, null);
  // Itens: média diária arredonda pra cima
  assert.equal(nextTarget(75, 100, thresholds, monthClock("2026-09", "2026-09-28")).perDay, 2);
});

test("marcos atingidos para a barra de 4 alvos", () => {
  assert.equal(computeSellerMetrics(goal, realized({ revenue: 7_999_999 }), clock).revenue.reachedTargets, 0);
  assert.equal(computeSellerMetrics(goal, realized({ revenue: 8_000_000 }), clock).revenue.reachedTargets, 1);
  assert.equal(computeSellerMetrics(goal, realized({ revenue: 10_000_000 }), clock).revenue.reachedTargets, 2);
  assert.equal(computeSellerMetrics(goal, realized({ revenue: 11_000_000 }), clock).revenue.reachedTargets, 3);
  assert.equal(computeSellerMetrics(goal, realized({ revenue: 12_000_000 }), clock).revenue.reachedTargets, 4);
  // Garantia: só a própria meta (100%)
  assert.equal(computeSellerMetrics(goal, realized({ warranty: 500_000 }), clock).warranty.reachedTargets, 1);
});
