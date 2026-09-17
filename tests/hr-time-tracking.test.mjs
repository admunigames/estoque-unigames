import assert from "node:assert/strict";
import test from "node:test";

const {
  parsePunches,
  formatPunches,
  validatePunches,
  computeWorkedMinutes,
  computeDailyBalance,
  formatHoursFromMinutes,
  aggregateMonthlyBalance,
} = await import("../app/lib/hr-time-tracking.ts");

test("parsePunches/formatPunches: ida e volta preservando ordem", () => {
  assert.deepEqual(parsePunches("08:00,12:00,13:00,17:30"), ["08:00", "12:00", "13:00", "17:30"]);
  assert.equal(formatPunches(["08:00", "17:00"]), "08:00,17:00");
  assert.deepEqual(parsePunches(""), []);
});

test("validatePunches: exige pares em ordem crescente", () => {
  assert.equal(validatePunches(["08:00"]).ok, false);
  assert.equal(validatePunches(["08:00", "12:00", "13:00"]).ok, false);
  assert.match(validatePunches(["08:00", "25:00"]).error, /HORÁRIO INVÁLIDO/);
  assert.match(validatePunches(["12:00", "08:00"]).error, /ORDEM CRESCENTE/);
  assert.match(validatePunches(["08:00", "08:00"]).error, /ORDEM CRESCENTE/);
  const ok = validatePunches(["08:00", "12:00", "13:00", "17:30"]);
  assert.equal(ok.ok, true);
});

test("computeWorkedMinutes: soma só os intervalos ímpares (trabalhados), ignora intervalo", () => {
  // 08:00–12:00 (240min trabalhados) + 13:00–17:30 (270min) = 510min, sem contar o almoço 12:00–13:00
  const { minutesList } = validatePunches(["08:00", "12:00", "13:00", "17:30"]);
  assert.equal(computeWorkedMinutes(minutesList), 510);
});

test("computeWorkedMinutes: 2 marcações (sem intervalo) soma tudo", () => {
  const { minutesList } = validatePunches(["08:00", "17:00"]);
  assert.equal(computeWorkedMinutes(minutesList), 540);
});

test("computeWorkedMinutes: 6 marcações (dois intervalos) soma só os trabalhados", () => {
  // 08:00–10:00 (120) + 10:15–12:00 (105) + 13:00–17:00 (240) = 465
  const { minutesList } = validatePunches(["08:00", "10:00", "10:15", "12:00", "13:00", "17:00"]);
  assert.equal(computeWorkedMinutes(minutesList), 465);
});

test("computeDailyBalance: saldo positivo (hora extra) e negativo (falta)", () => {
  const { minutesList } = validatePunches(["08:00", "12:00", "13:00", "18:00"]); // 540min trabalhados
  assert.deepEqual(computeDailyBalance(minutesList, 480), { workedMinutes: 540, targetMinutes: 480, balanceMinutes: 60 });
  assert.deepEqual(computeDailyBalance(minutesList, 600), { workedMinutes: 540, targetMinutes: 600, balanceMinutes: -60 });
});

test("formatHoursFromMinutes: formata horas e minutos com sinal", () => {
  assert.equal(formatHoursFromMinutes(90), "1h30");
  assert.equal(formatHoursFromMinutes(-45), "-0h45");
  assert.equal(formatHoursFromMinutes(0), "0h00");
});

test("aggregateMonthlyBalance: acumula banco de horas mês a mês descontando o pago", () => {
  const entries = [
    { yearMonth: "2026-08", workedMinutes: 480 * 20 + 60, targetMinutes: 480 * 20, balanceMinutes: 60 },
    { yearMonth: "2026-09", workedMinutes: 480 * 20 - 30, targetMinutes: 480 * 20, balanceMinutes: -30 },
  ];
  const months = aggregateMonthlyBalance(entries, { "2026-08": 30 });
  assert.equal(months.length, 2);
  assert.equal(months[0].yearMonth, "2026-08");
  assert.equal(months[0].overtimeMinutes, 60);
  assert.equal(months[0].paidMinutes, 30);
  assert.equal(months[0].cumulativeBalanceMinutes, 30); // 60 de extra - 30 pagos
  assert.equal(months[1].yearMonth, "2026-09");
  assert.equal(months[1].deficitMinutes, 30);
  assert.equal(months[1].cumulativeBalanceMinutes, 0); // 30 acumulado - 30 de falta em setembro
});

test("aggregateMonthlyBalance: mês sem lançamento mas com pagamento aparece zerado", () => {
  const months = aggregateMonthlyBalance([], { "2026-09": 60 });
  assert.equal(months.length, 1);
  assert.equal(months[0].cumulativeBalanceMinutes, -60);
});
