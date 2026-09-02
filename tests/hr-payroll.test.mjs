import assert from "node:assert/strict";
import test from "node:test";

const { computePayrollBreakdown, legacyNetCents } = await import("../app/lib/hr-payroll.ts");

const baseValues = {
  baseSalaryCents: 200000,
  bonusCents: 10000,
  overtimeCents: 5000,
  additionsCents: 0,
  deductionsCents: 30000,
  otherCents: 0,
};

test("Folha Paga = salário líquido + comissão líquida + benefícios via Pix", () => {
  const b = computePayrollBreakdown(baseValues, {
    commissionNetCents: 40000,
    commissionGrossCents: 50000,
    benefitsNetCents: 25000,
    benefitsGrossCents: 30000,
    benefitsPixNetCents: 15000,
    employerChargesBps: 0,
  });
  // salário líquido = 200000+10000+5000+0+0 - 30000 = 185000
  assert.equal(b.netSalaryCents, 185000);
  assert.equal(b.folhaPagaCents, 185000 + 40000 + 15000);
});

test("Custo Total usa valores brutos e soma encargos patronais sobre o salário base", () => {
  const b = computePayrollBreakdown(baseValues, {
    commissionNetCents: 40000,
    commissionGrossCents: 50000,
    benefitsNetCents: 25000,
    benefitsGrossCents: 30000,
    benefitsPixNetCents: 15000,
    employerChargesBps: 3000, // 30%
  });
  // encargos = 30% de 200000 = 60000
  assert.equal(b.employerChargesCents, 60000);
  // salário bruto (sem tirar o desconto) = 215000
  // custo total = 215000 + 50000 (comissão bruta) + 30000 (benefício bruto) + 60000
  assert.equal(b.custoTotalCents, 215000 + 50000 + 30000 + 60000);
});

test("Custo Total ignora o desconto do salário (item 7 — sempre bruto)", () => {
  const semDesc = computePayrollBreakdown({ ...baseValues, deductionsCents: 0 }, {
    commissionNetCents: 0, commissionGrossCents: 0, benefitsNetCents: 0,
    benefitsGrossCents: 0, benefitsPixNetCents: 0, employerChargesBps: 0,
  });
  const comDesc = computePayrollBreakdown(baseValues, {
    commissionNetCents: 0, commissionGrossCents: 0, benefitsNetCents: 0,
    benefitsGrossCents: 0, benefitsPixNetCents: 0, employerChargesBps: 0,
  });
  assert.equal(semDesc.custoTotalCents, comDesc.custoTotalCents);
});

test("legacyNetCents mantém a fórmula histórica (líquido com comissão e benefício líquidos)", () => {
  const inputs = {
    commissionNetCents: 40000, commissionGrossCents: 50000, benefitsNetCents: 25000,
    benefitsGrossCents: 30000, benefitsPixNetCents: 15000, employerChargesBps: 3000,
  };
  assert.equal(legacyNetCents(baseValues, inputs), 215000 + 40000 + 25000 - 30000);
});

// ---------------------------------------------------------------------------
// Parcelamento de desconto do Comissionamento (item 2)
// ---------------------------------------------------------------------------

const {
  addMonthsToCompetence,
  competencesForInstallments,
  normalizeInstallmentTotal,
  MAX_INSTALLMENTS,
} = await import("../app/lib/commission-installments.ts");

test("addMonthsToCompetence vira o ano corretamente", () => {
  assert.equal(addMonthsToCompetence("2026-01", 0), "2026-01");
  assert.equal(addMonthsToCompetence("2026-11", 3), "2027-02");
  assert.equal(addMonthsToCompetence("2026-03", 12), "2027-03");
});

test("competencesForInstallments repete o valor cheio nas competências seguintes", () => {
  // 3x a partir de 2026-03 → março, abril, maio (mesmo valor em cada uma)
  assert.deepEqual(competencesForInstallments("2026-03", 3), ["2026-03", "2026-04", "2026-05"]);
});

test("competencesForInstallments com total 1 devolve só a âncora", () => {
  assert.deepEqual(competencesForInstallments("2026-03", 1), ["2026-03"]);
});

test("competencesForInstallments respeita a trava de segurança", () => {
  assert.equal(competencesForInstallments("2026-03", 999).length, MAX_INSTALLMENTS);
});

test("normalizeInstallmentTotal só parcela desconto e exige >= 2", () => {
  assert.equal(normalizeInstallmentTotal("desconto", 3), 3);
  assert.equal(normalizeInstallmentTotal("desconto", 1), 1);
  assert.equal(normalizeInstallmentTotal("desconto", 0), 1);
  assert.equal(normalizeInstallmentTotal("desconto", "abc"), 1);
  assert.equal(normalizeInstallmentTotal("bonus", 3), 1);
  assert.equal(normalizeInstallmentTotal("ajuste", 5), 1);
  assert.equal(normalizeInstallmentTotal("desconto", 999), MAX_INSTALLMENTS);
});
