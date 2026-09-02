import assert from "node:assert/strict";
import test from "node:test";

const { workingDaysInMonth, daysInMonth } = await import("../app/lib/working-days.ts");
const { parseBenefitItems } = await import("../app/lib/hr-benefits.ts");

test("5x2: conta segunda a sexta do mês", () => {
  // Setembro/2026: 30 dias, começa numa terça. 22 dias úteis.
  assert.equal(workingDaysInMonth("2026-09", "5x2"), 22);
});

test("5x2: desconta feriado que cai em dia útil, ignora o de fim de semana", () => {
  // 2026-09-07 (independência) é uma segunda-feira; 2026-09-05 é sábado.
  assert.equal(workingDaysInMonth("2026-09", "5x2", ["2026-09-07", "2026-09-05"]), 21);
});

test("6x1: total de dias do mês × 6/7 arredondado, menos feriados", () => {
  assert.equal(daysInMonth("2026-09"), 30);
  assert.equal(workingDaysInMonth("2026-09", "6x1"), Math.round((30 * 6) / 7)); // 26
  assert.equal(workingDaysInMonth("2026-09", "6x1", ["2026-09-07"]), 25);
});

test("ignora feriados fora da competência e datas repetidas", () => {
  assert.equal(
    workingDaysInMonth("2026-09", "5x2", ["2026-08-15", "2026-09-07", "2026-09-07"]),
    21,
  );
});

test("mês inválido devolve 0", () => {
  assert.equal(workingDaysInMonth("2026-13", "5x2"), 0);
});

test("benefício por dia: amount = valor/dia × dias úteis", () => {
  const { items, error } = parseBenefitItems(
    [{ type: "alimentacao", amountMode: "per_day", perDayRateCents: 2500 }],
    undefined,
    { workingDays: 22 },
  );
  assert.equal(error, "");
  assert.equal(items[0].amountCents, 55000);
  assert.equal(items[0].workingDays, 22);
  assert.equal(items[0].perDayRateCents, 2500);
});

test("benefício por dia sem dias úteis calculados falha", () => {
  const { error } = parseBenefitItems(
    [{ type: "alimentacao", amountMode: "per_day", perDayRateCents: 2500 }],
    undefined,
    { workingDays: 0 },
  );
  assert.match(error, /DIAS ÚTEIS/);
});
