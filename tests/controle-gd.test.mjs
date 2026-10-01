import assert from "node:assert/strict";
import test from "node:test";

const { classifyGdBalance, buildGdDailyScript, aggregateLast7Days, buildLastNDates } = await import(
  "../app/lib/controle-gd.ts"
);

test("classifyGdBalance: crítico quando saldo <= -R$800", () => {
  assert.equal(classifyGdBalance(-80000, 0), "critico");
  assert.equal(classifyGdBalance(-80001, 0), "critico");
});

test("classifyGdBalance: crítico quando movimento do mês <= -R$300, mesmo com saldo positivo", () => {
  assert.equal(classifyGdBalance(100000, -30000), "critico");
});

test("classifyGdBalance: logo acima dos limiares críticos não é mais crítico", () => {
  assert.equal(classifyGdBalance(-79999, -29999), "negativo");
});

test("classifyGdBalance: negativo quando saldo < 0 (e não é crítico)", () => {
  assert.equal(classifyGdBalance(-1, -100), "negativo");
});

test("classifyGdBalance: margem_curta quando 0 <= saldo < R$300", () => {
  assert.equal(classifyGdBalance(0, 0), "margem_curta");
  assert.equal(classifyGdBalance(29999, 0), "margem_curta");
});

test("classifyGdBalance: saudavel_queda quando saldo confortável mas mês negativo", () => {
  assert.equal(classifyGdBalance(30000, -1), "saudavel_queda");
});

test("classifyGdBalance: saudavel no caso ideal", () => {
  assert.equal(classifyGdBalance(100000, 5000), "saudavel");
});

test("classifyGdBalance: caso que divergia entre os dois critérios do app de referência fica definido", () => {
  // saldo=-R$600, movimento=+R$50 — nem <= -800 nem movimento <= -300, mas < 0 => negativo.
  assert.equal(classifyGdBalance(-60000, 5000), "negativo");
});

test("buildLastNDates gera N datas terminando (inclusive) em todayIso, da mais antiga pra mais nova", () => {
  const dates = buildLastNDates("2026-03-03", 7);
  assert.deepEqual(dates, [
    "2026-02-25",
    "2026-02-26",
    "2026-02-27",
    "2026-02-28",
    "2026-03-01",
    "2026-03-02",
    "2026-03-03",
  ]);
});

test("aggregateLast7Days inclui dias sem lançamento como 0/0 em vez de sumir", () => {
  const dates = buildLastNDates("2026-01-10", 3);
  const result = aggregateLast7Days(
    [{ adjustmentDate: "2026-01-10", amountCents: 5000 }],
    dates,
  );
  assert.deepEqual(result, [
    { date: "2026-01-08", positiveCents: 0, negativeCents: 0 },
    { date: "2026-01-09", positiveCents: 0, negativeCents: 0 },
    { date: "2026-01-10", positiveCents: 5000, negativeCents: 0 },
  ]);
});

test("aggregateLast7Days separa positivos e negativos no mesmo dia", () => {
  const dates = ["2026-01-10"];
  const result = aggregateLast7Days(
    [
      { adjustmentDate: "2026-01-10", amountCents: 5000 },
      { adjustmentDate: "2026-01-10", amountCents: -2000 },
    ],
    dates,
  );
  assert.deepEqual(result, [{ date: "2026-01-10", positiveCents: 5000, negativeCents: -2000 }]);
});

test("buildGdDailyScript inclui status e recomendação, com maior ajuste negativo só quando houver", () => {
  const script = buildGdDailyScript({
    storeName: "RIOMAR",
    dateLabel: "30/09/2026",
    balanceCents: -90000,
    monthMovementCents: -40000,
    worstNegativeAdjustmentCents: -15000,
    status: "critico",
  });
  assert.match(script, /CONTROLE GD · RIOMAR/);
  assert.match(script, /Status: CRÍTICO/);
  assert.match(script, /Maior ajuste negativo do mês: -R\$ 150,00/);
});

test("buildGdDailyScript omite a linha de maior ajuste negativo quando não há nenhum", () => {
  const script = buildGdDailyScript({
    storeName: "RIOMAR",
    dateLabel: "30/09/2026",
    balanceCents: 100000,
    monthMovementCents: 5000,
    worstNegativeAdjustmentCents: 0,
    status: "saudavel",
  });
  assert.doesNotMatch(script, /Maior ajuste negativo/);
});
