import assert from "node:assert/strict";
import test from "node:test";

// Cobre a lógica pura (sem banco) do módulo "Notas Fiscais e Duplicatas de
// Fornecedores" — mesmo padrão/limitação já documentado em
// tests/finance-payables.test.mjs: rotas com SQL cru só rodam de verdade no
// runtime do Cloudflare Workers, então aqui só a lógica de status/totais/
// arredondamento/parcelamento é validada.

const invoiceStatus = await import("../app/lib/supplier-invoice-status.ts");

test("exemplo do requisito: NF de R$30.000 em 3 parcelas de R$10.000, uma paga", () => {
  const totalAmountCents = 30_000_00;
  const installments = [
    { originalAmountCents: 10_000_00, paidAmountCents: 10_000_00, dueDate: "2026-07-10", canceled: false, hasPendingSchedule: false },
    { originalAmountCents: 10_000_00, paidAmountCents: 0, dueDate: "2026-09-10", canceled: false, hasPendingSchedule: false },
    { originalAmountCents: 10_000_00, paidAmountCents: 0, dueDate: "2026-10-10", canceled: false, hasPendingSchedule: false },
  ];

  const totals = invoiceStatus.computeInstallmentTotals(totalAmountCents, installments);
  assert.equal(totals.totalDistributedCents, 30_000_00);
  assert.equal(totals.totalPaidCents, 10_000_00);
  assert.equal(totals.openBalanceCents, 20_000_00);
  assert.equal(totals.undistributedDifferenceCents, 0);

  const financialStatus = invoiceStatus.computeInvoiceFinancialStatus({
    totalAmountCents,
    canceled: false,
    sentToFinance: true,
    reviewed: true,
    installments: installments.map((installment) => ({ ...installment, paymentMethod: "pix", boletoCode: "" })),
    today: "2026-08-25",
  });
  assert.equal(financialStatus, "parcialmente_pago");
});

test("status calculado de duplicata: paga, parcialmente paga, vencida, a vencer, agendada", () => {
  const today = "2026-08-25";
  assert.equal(
    invoiceStatus.computeInstallmentStatus(
      { originalAmountCents: 1000, paidAmountCents: 1000, dueDate: "2026-08-01", canceled: false, hasPendingSchedule: false },
      today,
    ),
    "paga",
  );
  assert.equal(
    invoiceStatus.computeInstallmentStatus(
      { originalAmountCents: 1000, paidAmountCents: 400, dueDate: "2026-08-01", canceled: false, hasPendingSchedule: false },
      today,
    ),
    "vencida",
    "vencida tem prioridade mesmo com pagamento parcial, mesma regra de accounts_payable",
  );
  assert.equal(
    invoiceStatus.computeInstallmentStatus(
      { originalAmountCents: 1000, paidAmountCents: 0, dueDate: "2026-09-01", canceled: false, hasPendingSchedule: false },
      today,
    ),
    "a_vencer",
  );
  assert.equal(
    invoiceStatus.computeInstallmentStatus(
      { originalAmountCents: 1000, paidAmountCents: 0, dueDate: "2026-08-25", canceled: false, hasPendingSchedule: false },
      today,
    ),
    "vencendo_hoje",
  );
  assert.equal(
    invoiceStatus.computeInstallmentStatus(
      { originalAmountCents: 1000, paidAmountCents: 0, dueDate: "2026-09-01", canceled: false, hasPendingSchedule: true },
      today,
    ),
    "agendada",
  );
  assert.equal(
    invoiceStatus.computeInstallmentStatus(
      { originalAmountCents: 1000, paidAmountCents: 0, dueDate: "2026-08-01", canceled: true, hasPendingSchedule: false },
      today,
    ),
    "cancelada",
  );
});

test("planInstallments: arredondamento cai na última parcela, numeração 1/N", () => {
  const plan = invoiceStatus.planInstallments({
    totalAmountCents: 1000,
    installmentTotal: 3,
    firstDueDate: "2026-08-10",
  });
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((installment) => installment.amountCents), [333, 333, 334]);
  assert.deepEqual(
    plan.map((installment) => `${installment.installmentNumber}/${installment.installmentTotal}`),
    ["1/3", "2/3", "3/3"],
  );
  assert.equal(
    plan.reduce((sum, installment) => sum + installment.amountCents, 0),
    1000,
  );
  assert.deepEqual(plan.map((installment) => installment.dueDate), ["2026-08-10", "2026-09-10", "2026-10-10"]);
});

test("planInstallments: aceita datas customizadas por parcela", () => {
  const plan = invoiceStatus.planInstallments({
    totalAmountCents: 900,
    installmentTotal: 3,
    firstDueDate: "2026-08-10",
    customDueDates: ["2026-08-05", "2026-08-20", "2026-09-15"],
  });
  assert.deepEqual(plan.map((installment) => installment.dueDate), ["2026-08-05", "2026-08-20", "2026-09-15"]);
  assert.deepEqual(plan.map((installment) => installment.amountCents), [300, 300, 300]);
});

test("canMarkReadyForPayment: exige ao menos 1 duplicata, soma exata e vencimento em todas", () => {
  const totalAmountCents = 1000;
  assert.equal(invoiceStatus.canMarkReadyForPayment(totalAmountCents, []).ok, false);

  const missingSum = invoiceStatus.canMarkReadyForPayment(totalAmountCents, [
    { originalAmountCents: 400, paidAmountCents: 0, canceled: false, dueDate: "2026-08-10" },
  ]);
  assert.equal(missingSum.ok, false);

  const invalidDueDate = invoiceStatus.canMarkReadyForPayment(totalAmountCents, [
    { originalAmountCents: 1000, paidAmountCents: 0, canceled: false, dueDate: "" },
  ]);
  assert.equal(invalidDueDate.ok, false);

  const ok = invoiceStatus.canMarkReadyForPayment(totalAmountCents, [
    { originalAmountCents: 400, paidAmountCents: 0, canceled: false, dueDate: "2026-08-10" },
    { originalAmountCents: 600, paidAmountCents: 0, canceled: false, dueDate: "2026-09-10" },
  ]);
  assert.equal(ok.ok, true);
});

test("canMarkReadyForPayment: duplicata cancelada não conta nem pra soma nem pra exigência de vencimento", () => {
  const result = invoiceStatus.canMarkReadyForPayment(1000, [
    { originalAmountCents: 1000, paidAmountCents: 0, canceled: false, dueDate: "2026-08-10" },
    { originalAmountCents: 500, paidAmountCents: 0, canceled: true, dueDate: "" },
  ]);
  assert.equal(result.ok, true);
});

test("computeInvoiceFinancialStatus: precedência cancelado > aguardando_envio > aguardando_conferencia", () => {
  const base = {
    totalAmountCents: 1000,
    installments: [],
    today: "2026-08-25",
  };
  assert.equal(
    invoiceStatus.computeInvoiceFinancialStatus({ ...base, canceled: true, sentToFinance: false, reviewed: false }),
    "cancelado",
  );
  assert.equal(
    invoiceStatus.computeInvoiceFinancialStatus({ ...base, canceled: false, sentToFinance: false, reviewed: false }),
    "aguardando_envio",
  );
  assert.equal(
    invoiceStatus.computeInvoiceFinancialStatus({ ...base, canceled: false, sentToFinance: true, reviewed: false }),
    "aguardando_conferencia",
  );
  assert.equal(
    invoiceStatus.computeInvoiceFinancialStatus({ ...base, canceled: false, sentToFinance: true, reviewed: true }),
    "aguardando_duplicatas",
  );
});

test("computeInvoiceFinancialStatus: divergência de soma bloqueia pronto_pagamento", () => {
  const status = invoiceStatus.computeInvoiceFinancialStatus({
    totalAmountCents: 1000,
    canceled: false,
    sentToFinance: true,
    reviewed: true,
    installments: [
      { originalAmountCents: 400, paidAmountCents: 0, dueDate: "2026-09-01", canceled: false, hasPendingSchedule: false, paymentMethod: "pix", boletoCode: "" },
    ],
    today: "2026-08-25",
  });
  assert.equal(status, "com_divergencia");
});

test("computeInvoiceFinancialStatus: boleto sem código de barras bloqueia pronto_pagamento", () => {
  const status = invoiceStatus.computeInvoiceFinancialStatus({
    totalAmountCents: 1000,
    canceled: false,
    sentToFinance: true,
    reviewed: true,
    installments: [
      { originalAmountCents: 1000, paidAmountCents: 0, dueDate: "2026-09-01", canceled: false, hasPendingSchedule: false, paymentMethod: "boleto", boletoCode: "" },
    ],
    today: "2026-08-25",
  });
  assert.equal(status, "aguardando_boletos");
});

test("computeInvoiceFinancialStatus: tudo certo vira pronto_pagamento, tudo pago vira pago, vencida vira vencido", () => {
  const readyInstallments = [
    { originalAmountCents: 1000, paidAmountCents: 0, dueDate: "2026-09-01", canceled: false, hasPendingSchedule: false, paymentMethod: "pix", boletoCode: "" },
  ];
  assert.equal(
    invoiceStatus.computeInvoiceFinancialStatus({
      totalAmountCents: 1000,
      canceled: false,
      sentToFinance: true,
      reviewed: true,
      installments: readyInstallments,
      today: "2026-08-25",
    }),
    "pronto_pagamento",
  );

  assert.equal(
    invoiceStatus.computeInvoiceFinancialStatus({
      totalAmountCents: 1000,
      canceled: false,
      sentToFinance: true,
      reviewed: true,
      installments: [{ ...readyInstallments[0], paidAmountCents: 1000 }],
      today: "2026-08-25",
    }),
    "pago",
  );

  assert.equal(
    invoiceStatus.computeInvoiceFinancialStatus({
      totalAmountCents: 1000,
      canceled: false,
      sentToFinance: true,
      reviewed: true,
      installments: [{ ...readyInstallments[0], dueDate: "2026-01-01" }],
      today: "2026-08-25",
    }),
    "vencido",
  );
});
