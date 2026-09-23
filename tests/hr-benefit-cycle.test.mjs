import assert from "node:assert/strict";
import test from "node:test";

const {
  benefitCycle,
  cycleDates,
  cycleBenefitAmounts,
  formulaWorkingDaysInCycle,
  scheduleCoversCycle,
  workingDaysInCycle,
} = await import("../app/lib/hr-benefit-cycle.ts");

// Ciclo 2026-09 = 20/09/2026 (domingo) a 19/10/2026: 30 dias, 21 dias de
// segunda a sexta, 5 domingos (20/09, 27/09, 04/10, 11/10, 18/10).
// 12/10/2026 (feriado nacional) cai numa segunda-feira.

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

test("5x2 conta seg–sex do ciclo e desconta feriado em dia útil", () => {
  const cycle = benefitCycle("2026-09");
  assert.equal(formulaWorkingDaysInCycle(cycle, "5x2"), 21);
  // 12/10 (segunda) desconta; 04/10 (domingo) e 07/09 (fora do ciclo) não.
  assert.equal(formulaWorkingDaysInCycle(cycle, "5x2", ["2026-10-12", "2026-10-04", "2026-09-07"]), 20);
});

test("6x1 sem Escalas usa dias do ciclo × 6/7 menos feriados", () => {
  const cycle = benefitCycle("2026-09");
  const result = workingDaysInCycle(cycle, "6x1", ["2026-10-12"], null);
  assert.equal(result.source, "formula");
  assert.equal(result.workingDays, Math.round((30 * 6) / 7) - 1); // 26 - 1
});

test("6x1 com Escalas cobrindo o ciclo usa as folgas reais", () => {
  const cycle = benefitCycle("2026-09");
  const scheduleData = {
    assignedMonths: ["2026-09", "2026-10"],
    // Trabalha 2 dos 5 domingos -> 3 domingos de folga.
    sundayWorkDates: ["2026-09-27", "2026-10-11"],
    // Folgas seg–sáb lançadas; 2026-09-01 está fora do ciclo e é ignorada.
    weekdayOffDates: ["2026-09-23", "2026-10-01", "2026-10-15", "2026-09-01"],
  };
  const result = workingDaysInCycle(cycle, "6x1", [], scheduleData);
  assert.equal(result.source, "escalas");
  assert.equal(result.offDays, 6);
  assert.equal(result.workingDays, 24);
});

test("feriado que já é folga não é descontado duas vezes", () => {
  const cycle = benefitCycle("2026-09");
  const scheduleData = {
    assignedMonths: ["2026-09", "2026-10"],
    sundayWorkDates: [],
    weekdayOffDates: ["2026-10-12"],
  };
  // 5 domingos + 12/10 de folga = 6 folgas; feriado 12/10 já é folga.
  const onOff = workingDaysInCycle(cycle, "6x1", ["2026-10-12"], scheduleData);
  assert.equal(onOff.workingDays, 24);
  assert.equal(onOff.holidays, 0);
  // Feriado em dia trabalhado (13/10) desconta.
  const onWork = workingDaysInCycle(cycle, "6x1", ["2026-10-13"], scheduleData);
  assert.equal(onWork.workingDays, 23);
});

test("Escalas só com um dos dois meses do ciclo cai na fórmula", () => {
  const cycle = benefitCycle("2026-09");
  const partial = { assignedMonths: ["2026-09"], sundayWorkDates: [], weekdayOffDates: [] };
  assert.equal(scheduleCoversCycle(cycle, partial), false);
  assert.equal(workingDaysInCycle(cycle, "6x1", [], partial).source, "formula");
});

test("5x2 ignora dados do Escalas", () => {
  const cycle = benefitCycle("2026-09");
  const scheduleData = { assignedMonths: ["2026-09", "2026-10"], sundayWorkDates: [], weekdayOffDates: [] };
  const result = workingDaysInCycle(cycle, "5x2", [], scheduleData);
  assert.equal(result.source, "formula");
  assert.equal(result.workingDays, 21);
});

test("valores do ciclo = valor por dia × dias trabalhados", () => {
  assert.deepEqual(cycleBenefitAmounts(21, 2500, 1100), {
    foodCents: 52500,
    transportCents: 23100,
    totalCents: 75600,
  });
  assert.deepEqual(cycleBenefitAmounts(0, 2500, 1100), { foodCents: 0, transportCents: 0, totalCents: 0 });
  assert.deepEqual(cycleBenefitAmounts(20, -5, 0), { foodCents: 0, transportCents: 0, totalCents: 0 });
});
