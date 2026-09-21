import assert from "node:assert/strict";
import test from "node:test";

const { BIRTH_DATE_PATTERN, resolveBirthdayStatus } = await import("../app/lib/hr-birthdays.ts");

test("BIRTH_DATE_PATTERN aceita só AAAA-MM-DD válido", () => {
  assert.equal(BIRTH_DATE_PATTERN.test("1990-05-20"), true);
  assert.equal(BIRTH_DATE_PATTERN.test("1990-13-20"), false);
  assert.equal(BIRTH_DATE_PATTERN.test("1990-05-32"), false);
  assert.equal(BIRTH_DATE_PATTERN.test(""), false);
  assert.equal(BIRTH_DATE_PATTERN.test("20/05/1990"), false);
});

test("resolveBirthdayStatus retorna vazio quando não há data cadastrada", () => {
  const today = { year: 2026, month: 6, day: 15 };
  assert.equal(resolveBirthdayStatus("", 0, today), "");
});

test("resolveBirthdayStatus: aniversário do mês corrente ainda não chegou = faltando", () => {
  const today = { year: 2026, month: 6, day: 15 };
  assert.equal(resolveBirthdayStatus("1990-06-20", 0, today), "faltando");
});

test("resolveBirthdayStatus: HOJE é o aniversário conta como faltando (regra confirmada com o usuário)", () => {
  const today = { year: 2026, month: 6, day: 15 };
  assert.equal(resolveBirthdayStatus("1990-06-15", 0, today), "faltando");
});

test("resolveBirthdayStatus: aniversário do mês corrente já passou = passou", () => {
  const today = { year: 2026, month: 6, day: 15 };
  assert.equal(resolveBirthdayStatus("1990-06-10", 0, today), "passou");
});

test("resolveBirthdayStatus: aniversário de mês anterior ao corrente = passou", () => {
  const today = { year: 2026, month: 6, day: 15 };
  assert.equal(resolveBirthdayStatus("1990-03-01", 0, today), "passou");
});

test("resolveBirthdayStatus: aniversário de mês futuro = faltando", () => {
  const today = { year: 2026, month: 6, day: 15 };
  assert.equal(resolveBirthdayStatus("1990-12-25", 0, today), "faltando");
});

test("resolveBirthdayStatus: marcado 'Feito' no ano corrente prevalece sobre a comparação de data", () => {
  const today = { year: 2026, month: 6, day: 10 };
  assert.equal(resolveBirthdayStatus("1990-06-20", 2026, today), "feito");
});

test("resolveBirthdayStatus: 'Feito' de um ano anterior não vale mais no ano seguinte (sem reset manual)", () => {
  const today = { year: 2027, month: 6, day: 5 };
  assert.equal(resolveBirthdayStatus("1990-06-20", 2026, today), "faltando");
});
