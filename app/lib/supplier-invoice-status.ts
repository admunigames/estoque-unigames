// Lógica pura (sem I/O) do módulo "Notas Fiscais e Duplicatas de
// Fornecedores" — status calculado de cada duplicata, totais/saldo/
// divergência da NF e o status financeiro agregado da NF.
//
// Fica DE PROPÓSITO sem imports de outros módulos do projeto — mesma
// escolha já feita em app/lib/payables-recurrence.ts ("sem imports
// internos de propósito, pra poder ser testada diretamente [...] sem
// precisar do resolvedor de módulos do bundler"). Por isso a precedência
// de status calculado (igual a app/lib/finance-status.ts#computeDisplayStatus)
// e o parcelamento com arredondamento (igual a
// app/lib/payables-recurrence.ts#splitIntoInstallments/
// generateInstallmentDueDates) aparecem replicados aqui, não importados —
// se uma dessas regras mudar, replicar a mudança nos dois lugares.

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Mesmo fuso de app/lib/finance-status.ts#TIMEZONE — ver comentário lá. */
const TIMEZONE = "America/Recife";

function todayInTimezone(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(now);
}

function addMonthsToDate(dateText: string, months: number): string {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return date.toISOString().slice(0, 10);
}

/** Igual a app/lib/payables-recurrence.ts#generateInstallmentDueDates. */
function generateInstallmentDueDates(firstDueDate: string, installmentTotal: number): string[] {
  const dates: string[] = [firstDueDate];
  for (let i = 1; i < installmentTotal; i += 1) {
    dates.push(addMonthsToDate(firstDueDate, i));
  }
  return dates;
}

/** Igual a app/lib/payables-recurrence.ts#splitIntoInstallments. */
function splitIntoInstallments(totalAmountCents: number, installmentTotal: number): number[] {
  const base = Math.floor(totalAmountCents / installmentTotal);
  const amounts = new Array(installmentTotal).fill(base);
  const remainder = totalAmountCents - base * installmentTotal;
  amounts[amounts.length - 1] += remainder;
  return amounts;
}

type StoredStatus = "open" | "scheduled" | "partially_paid" | "paid" | "canceled";
type DisplayStatus =
  | "upcoming"
  | "due_today"
  | "overdue"
  | "partially_paid"
  | "paid"
  | "scheduled"
  | "canceled";

/** Igual a app/lib/finance-status.ts#computeStoredStatus. */
function computeStoredStatus(params: {
  originalAmountCents: number;
  paidAmountCents: number;
  canceled: boolean | number;
  hasPendingSchedule: boolean;
}): StoredStatus {
  if (params.canceled) return "canceled";
  if (params.paidAmountCents >= params.originalAmountCents && params.originalAmountCents > 0) {
    return "paid";
  }
  if (params.paidAmountCents > 0) return "partially_paid";
  if (params.hasPendingSchedule) return "scheduled";
  return "open";
}

/** Igual a app/lib/finance-status.ts#computeDisplayStatus. */
function computeDisplayStatus(params: { storedStatus: StoredStatus; dueDate: string; today: string }): DisplayStatus {
  const { storedStatus, dueDate, today } = params;
  if (storedStatus === "canceled") return "canceled";
  if (storedStatus === "paid") return "paid";
  const hasOpenBalance = storedStatus === "open" || storedStatus === "partially_paid" || storedStatus === "scheduled";
  if (hasOpenBalance) {
    if (dueDate < today) return "overdue";
    if (dueDate === today) return "due_today";
  }
  if (storedStatus === "partially_paid") return "partially_paid";
  if (storedStatus === "scheduled") return "scheduled";
  return "upcoming";
}

// "Tolerância só de arredondamento de centavo": como os valores já são
// inteiros em centavos (sem casas decimais adicionais), a única forma de a
// soma das duplicatas divergir do total por "arredondamento" é não bater
// nem um centavo — ou seja, a tolerância aceitável é zero. Mantido como
// constante nomeada (em vez de comparar "=== 0" espalhado) para deixar a
// regra explícita e fácil de ajustar no futuro caso o requisito mude.
export const ROUNDING_TOLERANCE_CENTS = 0;

export type InstallmentStatus =
  | "a_vencer"
  | "vencendo_hoje"
  | "vencida"
  | "parcialmente_paga"
  | "paga"
  | "agendada"
  | "cancelada";

export const INSTALLMENT_STATUS_LABELS: Record<InstallmentStatus, string> = {
  a_vencer: "A VENCER",
  vencendo_hoje: "VENCENDO HOJE",
  vencida: "VENCIDA",
  parcialmente_paga: "PARCIALMENTE PAGA",
  paga: "PAGA",
  agendada: "AGENDADA",
  cancelada: "CANCELADA",
};

// Mesma precedência de app/lib/finance-status.ts#computeDisplayStatus,
// só traduzida pro vocabulário de duplicata pedido no requisito (que usa
// "vencida"/"a vencer" em vez de "overdue"/"upcoming" etc.) — não duplica a
// lógica, só remapeia o rótulo.
const DISPLAY_TO_INSTALLMENT_STATUS: Record<DisplayStatus, InstallmentStatus> = {
  upcoming: "a_vencer",
  due_today: "vencendo_hoje",
  overdue: "vencida",
  partially_paid: "parcialmente_paga",
  paid: "paga",
  scheduled: "agendada",
  canceled: "cancelada",
};

export type InstallmentForStatus = {
  originalAmountCents: number;
  paidAmountCents: number;
  dueDate: string;
  // boolean ou 0/1 — o banco guarda booleano como integer (mesmo padrão do
  // resto do projeto, ver nota no topo de db/schema.ts), então as funções
  // aqui aceitam os dois pra poder receber a linha do banco direto, sem
  // exigir um mapeamento manual em toda call site.
  canceled: boolean | number;
  hasPendingSchedule: boolean;
};

/** Status calculado da duplicata — nunca persistido (ver nota em db/schema.ts). */
export function computeInstallmentStatus(
  installment: InstallmentForStatus,
  today: string = todayInTimezone(),
): InstallmentStatus {
  const storedStatus = computeStoredStatus({
    originalAmountCents: installment.originalAmountCents,
    paidAmountCents: installment.paidAmountCents,
    canceled: installment.canceled,
    hasPendingSchedule: installment.hasPendingSchedule,
  });
  const displayStatus = computeDisplayStatus({
    storedStatus,
    dueDate: installment.dueDate,
    today,
  });
  return DISPLAY_TO_INSTALLMENT_STATUS[displayStatus];
}

export type InstallmentTotals = {
  totalDistributedCents: number;
  totalPaidCents: number;
  openBalanceCents: number;
  // total da NF - total distribuído nas duplicatas (positivo = falta
  // distribuir, negativo = duplicatas somam mais que a NF, zero = ok).
  undistributedDifferenceCents: number;
};

/**
 * Total distribuído, total pago, saldo em aberto e diferença não
 * distribuída de uma NF — duplicatas canceladas nunca entram na soma
 * (mesmo critério de accounts_payable.status='canceled' em
 * recalcPayableEntrySql).
 */
export function computeInstallmentTotals(
  invoiceTotalAmountCents: number,
  installments: { originalAmountCents: number; paidAmountCents: number; canceled: boolean | number }[],
): InstallmentTotals {
  const active = installments.filter((installment) => !installment.canceled);
  const totalDistributedCents = active.reduce((sum, installment) => sum + installment.originalAmountCents, 0);
  const totalPaidCents = active.reduce((sum, installment) => sum + installment.paidAmountCents, 0);
  return {
    totalDistributedCents,
    totalPaidCents,
    openBalanceCents: totalDistributedCents - totalPaidCents,
    undistributedDifferenceCents: invoiceTotalAmountCents - totalDistributedCents,
  };
}

/**
 * Gera o plano de parcelas de uma NF: quantidade, 1º vencimento, e
 * vencimentos mensais sucessivos (ou datas customizadas, se informadas —
 * uma por parcela). Mesma regra de arredondamento (diferença inteira jogada
 * na última parcela) e mesma numeração N/total de
 * payables-recurrence.ts#splitIntoInstallments/generateInstallmentDueDates.
 */
export function planInstallments(params: {
  totalAmountCents: number;
  installmentTotal: number;
  firstDueDate: string;
  customDueDates?: string[];
}): { dueDate: string; amountCents: number; installmentNumber: number; installmentTotal: number }[] {
  const { totalAmountCents, installmentTotal } = params;
  const dueDates =
    params.customDueDates && params.customDueDates.length === installmentTotal
      ? params.customDueDates
      : generateInstallmentDueDates(params.firstDueDate, installmentTotal);
  const amounts = splitIntoInstallments(totalAmountCents, installmentTotal);
  return dueDates.map((dueDate, index) => ({
    dueDate,
    amountCents: amounts[index],
    installmentNumber: index + 1,
    installmentTotal,
  }));
}

/**
 * Regra exata do requisito: a NF só pode ir para "pronto_pagamento" com
 * pelo menos 1 duplicata, soma das duplicatas == valor total da NF
 * (tolerância só de arredondamento de centavo, ver ROUNDING_TOLERANCE_CENTS),
 * todas com vencimento válido, e sem divergência pendente.
 */
export function canMarkReadyForPayment(
  invoiceTotalAmountCents: number,
  installments: { originalAmountCents: number; paidAmountCents: number; canceled: boolean | number; dueDate: string }[],
): { ok: true } | { ok: false; reason: string } {
  const active = installments.filter((installment) => !installment.canceled);
  if (active.length === 0) {
    return { ok: false, reason: "A NF PRECISA DE PELO MENOS UMA DUPLICATA CADASTRADA." };
  }
  if (active.some((installment) => !DATE_PATTERN.test(installment.dueDate))) {
    return { ok: false, reason: "TODAS AS DUPLICATAS PRECISAM TER UM VENCIMENTO VÁLIDO." };
  }
  const totals = computeInstallmentTotals(invoiceTotalAmountCents, installments);
  if (Math.abs(totals.undistributedDifferenceCents) > ROUNDING_TOLERANCE_CENTS) {
    return {
      ok: false,
      reason: "A SOMA DAS DUPLICATAS PRECISA SER IGUAL AO VALOR TOTAL DA NF.",
    };
  }
  return { ok: true };
}

export type InvoiceFinancialStatus =
  | "aguardando_envio"
  | "aguardando_conferencia"
  | "aguardando_duplicatas"
  | "aguardando_boletos"
  | "pronto_pagamento"
  | "parcialmente_pago"
  | "pago"
  | "vencido"
  | "com_divergencia"
  | "cancelado";

export const INVOICE_FINANCIAL_STATUS_LABELS: Record<InvoiceFinancialStatus, string> = {
  aguardando_envio: "AGUARDANDO ENVIO",
  aguardando_conferencia: "AGUARDANDO CONFERÊNCIA",
  aguardando_duplicatas: "AGUARDANDO DUPLICATAS",
  aguardando_boletos: "AGUARDANDO BOLETOS",
  pronto_pagamento: "PRONTO PARA PAGAMENTO",
  parcialmente_pago: "PARCIALMENTE PAGO",
  pago: "PAGO",
  vencido: "VENCIDO",
  com_divergencia: "COM DIVERGÊNCIA",
  cancelado: "CANCELADO",
};

export type InstallmentSnapshot = InstallmentForStatus & {
  paymentMethod: string;
  boletoCode: string;
};

/**
 * Status financeiro agregado da NF — sempre recalculado nas escritas
 * relevantes (nunca aceito do cliente). Precedência, da mais forte pra
 * mais fraca:
 *   1. cancelado (a NF foi cancelada)
 *   2. aguardando_envio (ainda em Compras, não enviada ao Financeiro)
 *   3. aguardando_conferencia (enviada, mas ninguém "conferiu" ainda —
 *      inclui o caso de ter sido devolvida pra correção e reenviada)
 *   4. aguardando_duplicatas (conferida, mas nenhuma duplicata cadastrada)
 *   5. com_divergencia (duplicatas não somam o valor total da NF)
 *   6. aguardando_boletos (alguma duplicata em boleto sem código informado)
 *   7. pago (todas as duplicatas ativas estão pagas)
 *   8. vencido (alguma duplicata ativa está vencida com saldo em aberto)
 *   9. parcialmente_pago (há pagamento parcial, mas nem tudo vencido/pago)
 *   10. pronto_pagamento (nenhuma das condições acima — pronta pra pagar)
 */
export function computeInvoiceFinancialStatus(params: {
  totalAmountCents: number;
  canceled: boolean | number;
  sentToFinance: boolean;
  reviewed: boolean;
  installments: InstallmentSnapshot[];
  today?: string;
}): InvoiceFinancialStatus {
  if (params.canceled) return "cancelado";
  if (!params.sentToFinance) return "aguardando_envio";
  if (!params.reviewed) return "aguardando_conferencia";

  const active = params.installments.filter((installment) => !installment.canceled);
  if (active.length === 0) return "aguardando_duplicatas";

  const totals = computeInstallmentTotals(params.totalAmountCents, params.installments);
  if (Math.abs(totals.undistributedDifferenceCents) > ROUNDING_TOLERANCE_CENTS) {
    return "com_divergencia";
  }

  const missingBoleto = active.some(
    (installment) => installment.paymentMethod === "boleto" && !installment.boletoCode,
  );
  if (missingBoleto) return "aguardando_boletos";

  const today = params.today ?? todayInTimezone();
  const statuses = active.map((installment) => computeInstallmentStatus(installment, today));
  if (statuses.every((status) => status === "paga")) return "pago";
  if (statuses.some((status) => status === "vencida")) return "vencido";
  if (active.some((installment) => installment.paidAmountCents > 0)) return "parcialmente_pago";
  return "pronto_pagamento";
}
