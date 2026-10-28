import assert from "node:assert/strict";
import test from "node:test";

const {
  benefitCycle,
  cycleDates,
  cycleBenefitAmounts,
  countedDaysInCycle,
  parseBenefitRules,
} = await import("../app/lib/hr-benefit-cycle.ts");

// Ciclo 2026-09 = 20/09/2026 (domingo) a 19/10/2026: 30 dias, 21 dias de
// segunda a sexta, 4 sábados e 5 domingos (20/09, 27/09, 04/10, 11/10, 18/10).

test("competência AAAA-MM vai do dia 20 ao dia 19 do mês seguinte", () => {
  const cycle = benefitCycle("2026-09");
  assert.equal(cycle.start, "2026-09-20");
  assert.equal(cycle.end, "2026-10-19");
  assert.deepEqual(cycle.months, ["2026-09", "2026-10"]);
  assert.equal(cycleDates(cycle).length, 30);
});

test("ciclo de dezembro atravessa o ano", () => {
  const cycle = benefitCycle("2026-12");
  assert.equal(cycle.start, "2026-12-20");
  assert.equal(cycle.end, "2027-01-19");
  assert.deepEqual(cycle.months, ["2026-12", "2027-01"]);
  assert.equal(cycleDates(cycle).length, 31);
});

test("competência inválida devolve null", () => {
  assert.equal(benefitCycle("2026-13"), null);
  assert.equal(benefitCycle(""), null);
});

test("dias exatos: 5x2 = seg–sex, 6x1 = seg–sáb (feriado não sai sozinho)", () => {
  const cycle = benefitCycle("2026-09");
  assert.equal(countedDaysInCycle(cycle, "5x2"), 21);
  assert.equal(countedDaysInCycle(cycle, "6x1"), 25);
});

test("regras: padrões 245/500 de alimentação e R$ 9/dia de transporte", () => {
  assert.deepEqual(parseBenefitRules("{}"), {
    "5x2": { foodCents: 24500, transportPerDayCents: 900 },
    "6x1": { foodCents: 50000, transportPerDayCents: 900 },
  });
  const saved = parseBenefitRules(JSON.stringify({ "5x2": { foodCents: 30000, transportPerDayCents: -1 } }));
  assert.equal(saved["5x2"].foodCents, 30000);
  assert.equal(saved["5x2"].transportPerDayCents, 900);
  assert.equal(parseBenefitRules("lixo")["6x1"].foodCents, 50000);
});

test("valores do ciclo = alimentação cheia ± ajuste + dias × transporte/dia", () => {
  const rule = { foodCents: 24500, transportPerDayCents: 900 };
  assert.deepEqual(cycleBenefitAmounts(rule, 21), { foodCents: 24500, transportCents: 18900, totalCents: 43400 });
  assert.deepEqual(cycleBenefitAmounts(rule, 19, -2000), { foodCents: 22500, transportCents: 17100, totalCents: 39600 });
  assert.deepEqual(cycleBenefitAmounts(rule, -3, -99999), { foodCents: 0, transportCents: 0, totalCents: 0 });
});
