import assert from "node:assert/strict";
import test from "node:test";

// Cobertura da lógica PURA do Fluxo de Caixa e dos Recebíveis (Financeiro
// Fase 6). Mesma limitação já registrada em tests/finance-payables.test.mjs:
// as rotas que fazem SQL cru só rodam de verdade dentro do runtime do
// Cloudflare Workers, então aqui ficam só as funções sem I/O — acumulação
// dia a dia, tolerância de divergência e status calculado.

const cashFlow = await import("../app/lib/cash-flow.ts");
const receivables = await import("../app/lib/receivables-status.ts");

const NO_MOVEMENT = { entradas: [], saidasPayables: [], saidasPayroll: [] };

test("fluxo de caixa: acumula dia a dia (caixa final vira caixa inicial do dia seguinte)", () => {
  const series = cashFlow.buildCashFlowSeries({
    today: "2026-08-26",
    days: 3,
    caixaAtualCents: 100_000,
    entradas: [
      { date: "2026-08-26", amountCents: 50_000 },
      { date: "2026-08-28", amountCents: 10_000 },
    ],
    saidasPayables: [{ date: "2026-08-27", amountCents: 30_000 }],
    saidasPayroll: [{ date: "2026-08-27", amountCents: 20_000 }],
  });

  assert.equal(series.days.length, 3);
  assert.deepEqual(
    series.days.map((day) => [day.date, day.caixaInicialCents, day.entradasCents, day.saidasCents, day.caixaFinalCents]),
    [
      ["2026-08-26", 100_000, 50_000, 0, 150_000],
      ["2026-08-27", 150_000, 0, 50_000, 100_000],
      ["2026-08-28", 100_000, 10_000, 0, 110_000],
    ],
  );
  assert.equal(series.days[1].saidasPayableCents, 30_000);
  assert.equal(series.days[1].saidasPayrollCents, 20_000);
});

test("fluxo de caixa: dia sem nenhum movimento repete o saldo do dia anterior", () => {
  const series = cashFlow.buildCashFlowSeries({
    today: "2026-08-26",
    days: 4,
    caixaAtualCents: 25_000,
    ...NO_MOVEMENT,
  });
  assert.equal(series.days.length, 4);
  for (const day of series.days) {
    assert.equal(day.entradasCents, 0);
    assert.equal(day.saidasCents, 0);
    assert.equal(day.caixaInicialCents, 25_000);
    assert.equal(day.caixaFinalCents, 25_000);
  }
});

test("fluxo de caixa: caixa fica negativo quando as saídas passam do saldo", () => {
  const series = cashFlow.buildCashFlowSeries({
    today: "2026-08-26",
    days: 2,
    caixaAtualCents: 10_000,
    entradas: [],
    saidasPayables: [{ date: "2026-08-27", amountCents: 35_000 }],
    saidasPayroll: [],
  });
  assert.equal(series.days[0].caixaFinalCents, 10_000);
  assert.equal(series.days[1].caixaFinalCents, -25_000);
});

test("fluxo de caixa: série longa mantém a acumulação e cobre todos os dias", () => {
  const entradas = [];
  for (let index = 0; index < 90; index += 1) {
    entradas.push({ date: cashFlowDate("2026-08-26", index), amountCents: 1_000 });
  }
  const series = cashFlow.buildCashFlowSeries({
    today: "2026-08-26",
    days: 90,
    caixaAtualCents: 0,
    entradas,
    saidasPayables: [],
    saidasPayroll: [],
  });
  assert.equal(series.days.length, 90);
  assert.equal(series.days[0].date, "2026-08-26");
  assert.equal(series.days[89].date, "2026-11-23");
  assert.equal(series.days[89].caixaFinalCents, 90_000);
});

test("fluxo de caixa: movimento atrasado cai no primeiro dia, movimento além do horizonte é ignorado", () => {
  const series = cashFlow.buildCashFlowSeries({
    today: "2026-08-26",
    days: 3,
    caixaAtualCents: 0,
    entradas: [{ date: "2027-01-01", amountCents: 99_000 }],
    saidasPayables: [{ date: "2026-01-10", amountCents: 40_000 }],
    saidasPayroll: [],
  });
  assert.equal(series.days[0].saidasCents, 40_000);
  assert.equal(series.days[0].caixaFinalCents, -40_000);
  assert.equal(
    series.days.reduce((sum, day) => sum + day.entradasCents, 0),
    0,
  );
});

test("fluxo de caixa: horizontes são recortes da MESMA série, não recálculos", () => {
  const series = cashFlow.buildCashFlowSeries({
    today: "2026-08-26",
    days: 90,
    caixaAtualCents: 500_000,
    entradas: [{ date: "2026-09-10", amountCents: 100_000 }],
    saidasPayables: [{ date: "2026-10-05", amountCents: 800_000 }],
    saidasPayroll: [],
  });
  const summaries = cashFlow.summarizeHorizons(series);
  assert.deepEqual(
    summaries.map((row) => row.days),
    [7, 15, 30, 60, 90],
  );
  assert.equal(summaries[0].caixaFinalCents, 500_000);
  assert.equal(summaries[2].caixaFinalCents, 600_000); // 30 dias: só a entrada
  assert.equal(summaries[3].caixaFinalCents, -200_000); // 60 dias: já pegou a saída
  assert.equal(summaries[3].firstNegativeDate, "2026-10-05");
  assert.equal(summaries[0].firstNegativeDate, "");
});

test("fluxo de caixa: impostos e taxas de cartão ficam zerados (Fase 7)", () => {
  const series = cashFlow.buildCashFlowSeries({
    today: "2026-08-26",
    days: 2,
    caixaAtualCents: 0,
    ...NO_MOVEMENT,
  });
  for (const day of series.days) assert.equal(day.saidasImpostosTaxasCents, 0);
});

test("meses do horizonte: cobre as duas pontas e vira o ano", () => {
  assert.deepEqual(cashFlow.monthsInRange("2026-08-26", "2026-11-23"), [
    "2026-08",
    "2026-09",
    "2026-10",
    "2026-11",
  ]);
  // Mesmo mês nas duas pontas devolve um mês só.
  assert.deepEqual(cashFlow.monthsInRange("2026-08-01", "2026-08-31"), ["2026-08"]);
  assert.deepEqual(cashFlow.monthsInRange("2026-12-05", "2027-02-10"), [
    "2026-12",
    "2027-01",
    "2027-02",
  ]);
});

test("folha sem data de pagamento: dia fixo do mês seguinte à competência", () => {
  assert.equal(cashFlow.payrollFallbackPaymentDate("2026-08", 5), "2026-09-05");
  assert.equal(cashFlow.payrollFallbackPaymentDate("2026-12", 5), "2027-01-05");
});

test("folha sem data de pagamento: mês curto cai no último dia do mês", () => {
  assert.equal(cashFlow.payrollFallbackPaymentDate("2026-01", 31), "2026-02-28");
  assert.equal(cashFlow.payrollFallbackPaymentDate("2028-01", 31), "2028-02-29");
  assert.equal(cashFlow.payrollFallbackPaymentDate("2026-03", 31), "2026-04-30");
});

test("recebíveis: diferença só existe depois do recebimento", () => {
  assert.equal(receivables.receivableDifferenceCents(10_000, null), null);
  assert.equal(receivables.receivableDifferenceCents(10_000, 10_000), 0);
  assert.equal(receivables.receivableDifferenceCents(10_000, 9_500), -500);
});

test("recebíveis: tolerância combinada dispara pelo que for atingido primeiro", () => {
  const tolerance = { toleranceBps: 200, toleranceFixedCents: 2000 };
  // Valor alto: 2% de 1.000.000 = 20.000, mas o fixo (2.000) estoura antes.
  assert.equal(
    receivables.isReceivableDivergent({
      expectedAmountCents: 1_000_000,
      receivedAmountCents: 1_000_000 - 2_500,
      tolerance,
    }),
    true,
  );
  // Valor baixo: 2% de 10.000 = 200; diferença de 300 estoura o percentual
  // mesmo estando abaixo do fixo.
  assert.equal(
    receivables.isReceivableDivergent({ expectedAmountCents: 10_000, receivedAmountCents: 10_300, tolerance }),
    true,
  );
  // Dentro dos dois limites.
  assert.equal(
    receivables.isReceivableDivergent({ expectedAmountCents: 10_000, receivedAmountCents: 10_100, tolerance }),
    false,
  );
});

test("recebíveis: status calculado cobre pendente, atrasado, recebido e divergente", () => {
  const tolerance = { toleranceBps: 200, toleranceFixedCents: 2000 };
  const base = { expectedAmountCents: 10_000, tolerance, today: "2026-08-26", canceled: false };
  assert.equal(
    receivables.computeReceivableDisplayStatus({ ...base, expectedDate: "2026-08-30", receivedAmountCents: null }),
    "pending",
  );
  assert.equal(
    receivables.computeReceivableDisplayStatus({ ...base, expectedDate: "2026-08-26", receivedAmountCents: null }),
    "pending",
  );
  assert.equal(
    receivables.computeReceivableDisplayStatus({ ...base, expectedDate: "2026-08-20", receivedAmountCents: null }),
    "overdue",
  );
  assert.equal(
    receivables.computeReceivableDisplayStatus({ ...base, expectedDate: "2026-08-20", receivedAmountCents: 10_000 }),
    "received_ok",
  );
  assert.equal(
    receivables.computeReceivableDisplayStatus({ ...base, expectedDate: "2026-08-20", receivedAmountCents: 5_000 }),
    "received_divergent",
  );
  // Recebido 0 é "recebido" (estorno total), não "pendente".
  assert.equal(
    receivables.computeReceivableDisplayStatus({ ...base, expectedDate: "2026-08-30", receivedAmountCents: 0 }),
    "received_divergent",
  );
  assert.equal(
    receivables.computeReceivableDisplayStatus({
      ...base,
      canceled: true,
      expectedDate: "2020-01-01",
      receivedAmountCents: null,
    }),
    "canceled",
  );
});

function cashFlowDate(start, offset) {
  const [year, month, day] = start.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Item 4 — cadastro simplificado de Recebíveis (Unidade, Adquirente,
// Competência, Valor). expected_date deixa de ser pedido e passa a ser
// derivado do último dia da competência — é o que o Fluxo de Caixa usa para
// datar a entrada (item 3: Recebíveis já alimenta a projeção).
// ---------------------------------------------------------------------------

test("expectedDateFromCompetence: último dia da competência", () => {
  assert.equal(receivables.expectedDateFromCompetence("2026-02"), "2026-02-28");
  assert.equal(receivables.expectedDateFromCompetence("2028-02"), "2028-02-29");
  assert.equal(receivables.expectedDateFromCompetence("2026-09"), "2026-09-30");
  assert.equal(receivables.expectedDateFromCompetence("2026-12"), "2026-12-31");
});

test("recebível simplificado entra no fluxo de caixa na data derivada da competência", () => {
  // Sem "data prevista" no cadastro, a entrada é datada pelo fim da
  // competência e precisa aparecer como entrada naquele dia da projeção.
  const entradaDate = receivables.expectedDateFromCompetence("2026-09");
  const series = cashFlow.buildCashFlowSeries({
    today: "2026-09-01",
    days: 30,
    caixaAtualCents: 0,
    entradas: [{ date: entradaDate, amountCents: 500_00 }],
    saidasPayables: [],
    saidasPayroll: [],
  });
  const day = series.days.find((d) => d.date === entradaDate);
  assert.equal(day.entradasCents, 500_00);
  assert.equal(series.days[series.days.length - 1].caixaFinalCents, 500_00);
});

// ---------------------------------------------------------------------------
// CAIXA SEMANAL (Financeiro 4/9)
// ---------------------------------------------------------------------------
test("mondayOf/isMonday: semana de segunda a domingo", () => {
  assert.equal(cashFlow.mondayOf("2026-10-04"), "2026-09-28"); // domingo
  assert.equal(cashFlow.mondayOf("2026-10-05"), "2026-10-05");
  assert.equal(cashFlow.mondayOf("2026-10-07"), "2026-10-05");
  assert.equal(cashFlow.isMonday("2026-10-05"), true);
  assert.equal(cashFlow.isMonday("2026-10-06"), false);
  assert.equal(cashFlow.isMonday("05/10/2026"), false);
});

test("buildWeeklyCash: passada usa realizado e mostra a diferença; atual e futura usam a projeção", () => {
  const accounts = [{ accountId: "a", accountName: "BANCO A" }, { accountId: "b", accountName: "CAIXA" }];
  const projection = cashFlow.buildCashFlowSeries({
    today: "2026-10-07", // quarta
    days: 20,
    caixaAtualCents: 0,
    entradas: [{ date: "2026-10-08", amountCents: 1_000 }, { date: "2026-10-13", amountCents: 5_000 }],
    saidasPayables: [{ date: "2026-10-01", amountCents: 300 } /* vencido → hoje */, { date: "2026-10-14", amountCents: 2_000 }],
    saidasPayroll: [],
  }).days;
  const rows = cashFlow.buildWeeklyCash({
    today: "2026-10-07",
    weeks: ["2026-09-28", "2026-10-05", "2026-10-12"],
    accounts,
    balances: [
      { accountId: "a", weekDate: "2026-09-28", balanceCents: 10_000 },
      { accountId: "b", weekDate: "2026-09-28", balanceCents: 500 },
      { accountId: "a", weekDate: "2026-10-05", balanceCents: 9_000 },
      { accountId: "b", weekDate: "2026-10-05", balanceCents: 700 },
    ],
    realizedIn: [{ date: "2026-09-30", amountCents: 2_000 }, { date: "2026-10-06", amountCents: 100 }],
    realizedOut: [{ date: "2026-10-02", amountCents: 3_000 }, { date: "2026-10-06", amountCents: 50 }],
    projection,
    caixaAtualCents: 99_999,
  });
  const [past, current, future] = rows;
  assert.equal(past.kind, "past");
  assert.equal(past.informedCents, 10_500);
  assert.equal(past.entradasCents, 2_000);
  assert.equal(past.saidasCents, 3_000);
  assert.equal(past.expectedNextCents, 9_500);
  assert.equal(past.informedNextCents, 9_700);
  assert.equal(past.differenceCents, 200); // mexeu no banco sem estar lançado

  assert.equal(current.kind, "current");
  assert.equal(current.startCents, 9_700); // segunda informada, não o Caixa Atual
  // realizado seg–ter (100 / 50) + projeção qua–dom (1.000 / 300 vencido)
  assert.equal(current.entradasCents, 1_100);
  assert.equal(current.saidasCents, 350);
  assert.equal(current.expectedNextCents, 10_450);
  assert.equal(current.differenceCents, null);

  assert.equal(future.kind, "future");
  assert.equal(future.startCents, 10_450);
  assert.equal(future.entradasCents, 5_000);
  assert.equal(future.saidasCents, 2_000);
  assert.equal(future.expectedNextCents, 13_450);
  assert.equal(future.informedNextCents, null);
});

test("buildWeeklyCash: conta sem saldo informado é sinalizada e não gera diferença; segunda atual vazia parte do Caixa Atual", () => {
  const rows = cashFlow.buildWeeklyCash({
    today: "2026-10-05",
    weeks: ["2026-09-28", "2026-10-05"],
    accounts: [{ accountId: "a", accountName: "BANCO A" }, { accountId: "b", accountName: "CAIXA" }],
    balances: [
      { accountId: "a", weekDate: "2026-09-28", balanceCents: 1_000 },
      { accountId: "a", weekDate: "2026-10-05", balanceCents: 1_000 },
      { accountId: "b", weekDate: "2026-10-05", balanceCents: 1_000 },
    ],
    realizedIn: [],
    realizedOut: [],
    projection: [],
    caixaAtualCents: 7_777,
  });
  assert.deepEqual(rows[0].missingAccounts, ["CAIXA"]);
  assert.equal(rows[0].differenceCents, null);
  const empty = cashFlow.buildWeeklyCash({
    today: "2026-10-07", weeks: ["2026-10-05"], accounts: [{ accountId: "a", accountName: "BANCO A" }],
    balances: [], realizedIn: [], realizedOut: [], projection: [], caixaAtualCents: 7_777,
  });
  assert.equal(empty[0].informedCents, null);
  assert.deepEqual(empty[0].missingAccounts, ["BANCO A"]);
  assert.equal(empty[0].startCents, 7_777);
});
