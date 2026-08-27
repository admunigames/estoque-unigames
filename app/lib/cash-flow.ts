// Lógica pura (sem I/O) do Fluxo de Caixa — Financeiro Fase 6.
//
// Mesma convenção de app/lib/payables-recurrence.ts: sem NENHUM I/O, pra
// poder ser testado direto (ver tests/finance-cash-flow.test.mjs). O único
// import é o de app/lib/finance-status.ts (também puro, e já importado com
// extensão explícita pra funcionar tanto no bundler quanto no
// `node --experimental-strip-types` dos testes) — addDays estava duplicado
// byte a byte aqui antes, e aritmética de data é exatamente o tipo de coisa
// que não pode ter duas implementações que possam divergir.
// O handler HTTP (app/api/finance/cash-flow/route.ts) faz TODA a busca no
// banco e entrega aqui apenas os totais já agregados por dia.
//
// Fórmula (confirmada com o usuário):
//   Caixa Inicial + Entradas − Saídas = Caixa Final
// calculada DIA A DIA (nunca semanal, inclusive nos horizontes de 60/90
// dias). O Caixa Final de um dia é o Caixa Inicial do dia seguinte; o Caixa
// Inicial do primeiro dia é o "Caixa Atual" (soma dos saldos manuais
// informados por conta em finance_account_balances).

import { addDays } from "./finance-status.ts";

/** Horizontes oferecidos na tela. A série é sempre construída no MAIOR deles. */
export const CASH_FLOW_HORIZONS = [7, 15, 30, 60, 90] as const;
export type CashFlowHorizon = (typeof CASH_FLOW_HORIZONS)[number];
export const MAX_CASH_FLOW_DAYS = 90;

export function isCashFlowHorizon(value: number): value is CashFlowHorizon {
  return (CASH_FLOW_HORIZONS as readonly number[]).includes(value);
}

export type CashFlowSettings = {
  receivablesToleranceBps: number;
  receivablesToleranceFixedCents: number;
  payrollDefaultPaymentDay: number;
};

/**
 * Padrões usados quando não existe linha em finance_cash_flow_settings nem
 * para a loja nem para o escopo global (''). Nenhuma linha é criada
 * automaticamente — a configuração só passa a existir quando o usuário salva.
 */
export const DEFAULT_CASH_FLOW_SETTINGS: CashFlowSettings = {
  receivablesToleranceBps: 200, // 2%
  receivablesToleranceFixedCents: 2000, // R$ 20,00
  payrollDefaultPaymentDay: 5, // dia 5 do mês seguinte à competência
};

/** Um total já agregado por data (YYYY-MM-DD). */
export type DailyAmount = { date: string; amountCents: number };

export type CashFlowDay = {
  date: string;
  caixaInicialCents: number;
  entradasCents: number;
  saidasCents: number;
  caixaFinalCents: number;
  /** Detalhamento das saídas, pra tela poder explicar a composição do dia. */
  saidasPayableCents: number;
  saidasPayrollCents: number;
  /**
   * Impostos e taxas de cartão ainda NÃO existem como módulo no projeto
   * (chegam na Fase 7). Fica sempre 0 aqui e a UI avisa que a fórmula está
   * incompleta nesse ponto — decisão de não travar o módulo por causa disso.
   */
  saidasImpostosTaxasCents: number;
};

export type CashFlowSeries = {
  today: string;
  days: CashFlowDay[];
  caixaAtualCents: number;
};

/**
 * Meses de competência (AAAA-MM) cobertos por um intervalo de datas,
 * inclusive nas duas pontas — normalmente 3 ou 4 meses civis pro horizonte de
 * 90 dias. Usado pra saber quais competências de RH precisam ser projetadas
 * (inclusive as que ainda não têm lançamento salvo nenhum).
 */
export function monthsInRange(fromDate: string, toDate: string): string[] {
  const months: string[] = [];
  let [year, month] = fromDate.slice(0, 7).split("-").map(Number);
  const last = toDate.slice(0, 7);
  for (let guard = 0; guard < 60; guard += 1) {
    const current = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
    months.push(current);
    if (current >= last) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/** Soma, por data, uma lista de agregados (várias fontes podem cair no mesmo dia). */
export function sumByDate(entries: DailyAmount[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (!entry || !entry.date) continue;
    totals.set(entry.date, (totals.get(entry.date) ?? 0) + Number(entry.amountCents || 0));
  }
  return totals;
}

/**
 * Data prevista de saída de caixa de um lançamento de RH (Folha, Benefício ou
 * Comissão) que não tem payment_date preenchido: o dia fixo configurado
 * (payrollDefaultPaymentDay), aplicado sobre o mês SEGUINTE ao da competência
 * — decisão confirmada com o usuário.
 *
 * Meses mais curtos que o dia configurado caem no último dia do mês (ex.: dia
 * 31 configurado + fevereiro = 28/29), exatamente como addMonthsToDate já
 * trata em app/lib/payables-recurrence.ts.
 */
export function payrollFallbackPaymentDate(competenceMonth: string, paymentDay: number): string {
  const [year, month] = competenceMonth.split("-").map(Number);
  // month é 1-based; Date.UTC(year, month, 0) já é o último dia do mês
  // SEGUINTE ao da competência (month 1-based = índice do mês seguinte).
  const lastDayOfNextMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const safeDay = Math.min(Math.max(1, Math.trunc(paymentDay) || 1), lastDayOfNextMonth);
  const target = new Date(Date.UTC(year, month, safeDay));
  return target.toISOString().slice(0, 10);
}

export type BuildCashFlowSeriesInput = {
  /** Primeiro dia da série (normalmente "hoje" no fuso do projeto). */
  today: string;
  /** Quantidade de dias da série, incluindo o primeiro. */
  days: number;
  /** Caixa Atual: soma dos saldos manuais das contas no escopo. */
  caixaAtualCents: number;
  /** Entradas já agregadas por dia (recebíveis previstos e recebidos). */
  entradas: DailyAmount[];
  /** Saídas de accounts_payable/accounts_payable_payments agregadas por dia. */
  saidasPayables: DailyAmount[];
  /** Saídas de RH (folha + benefícios + comissões) agregadas por dia. */
  saidasPayroll: DailyAmount[];
};

/**
 * Monta a série diária completa. Dias sem nenhum movimento aparecem na série
 * com entradas/saídas zeradas (a série é densa de propósito: a UI recorta os
 * sub-horizontes e desenha o gráfico direto, sem precisar preencher buracos).
 *
 * Movimentos com data ANTERIOR ao primeiro dia da série (ex.: uma conta já
 * vencida e ainda não paga) são somados no PRIMEIRO dia — decisão
 * conservadora: ignorá-los esconderia dinheiro que vai sair; espalhá-los pelo
 * futuro seria inventar uma data de pagamento que ninguém informou.
 * Movimentos depois do último dia da série ficam de fora.
 */
export function buildCashFlowSeries(input: BuildCashFlowSeriesInput): CashFlowSeries {
  const totalDays = Math.max(1, Math.trunc(input.days) || 1);
  const firstDate = input.today;
  const lastDate = addDays(firstDate, totalDays - 1);

  function bucketDate(date: string): string | null {
    if (!date) return null;
    if (date < firstDate) return firstDate;
    if (date > lastDate) return null;
    return date;
  }

  function bucketize(entries: DailyAmount[]): Map<string, number> {
    const mapped: DailyAmount[] = [];
    for (const entry of entries) {
      const date = bucketDate(entry?.date ?? "");
      if (!date) continue;
      mapped.push({ date, amountCents: Number(entry.amountCents || 0) });
    }
    return sumByDate(mapped);
  }

  const entradasByDate = bucketize(input.entradas);
  const payablesByDate = bucketize(input.saidasPayables);
  const payrollByDate = bucketize(input.saidasPayroll);

  const days: CashFlowDay[] = [];
  let running = Number(input.caixaAtualCents || 0);
  for (let index = 0; index < totalDays; index += 1) {
    const date = addDays(firstDate, index);
    const entradasCents = entradasByDate.get(date) ?? 0;
    const saidasPayableCents = payablesByDate.get(date) ?? 0;
    const saidasPayrollCents = payrollByDate.get(date) ?? 0;
    const saidasImpostosTaxasCents = 0; // Fase 7 — ver comentário em CashFlowDay
    const saidasCents = saidasPayableCents + saidasPayrollCents + saidasImpostosTaxasCents;
    const caixaInicialCents = running;
    const caixaFinalCents = caixaInicialCents + entradasCents - saidasCents;
    days.push({
      date,
      caixaInicialCents,
      entradasCents,
      saidasCents,
      caixaFinalCents,
      saidasPayableCents,
      saidasPayrollCents,
      saidasImpostosTaxasCents,
    });
    running = caixaFinalCents;
  }

  return { today: firstDate, days, caixaAtualCents: Number(input.caixaAtualCents || 0) };
}

export type HorizonSummary = {
  days: number;
  endDate: string;
  entradasCents: number;
  saidasCents: number;
  caixaFinalCents: number;
  /** Primeiro dia da janela em que o caixa projetado fica negativo ('' = nenhum). */
  firstNegativeDate: string;
};

/**
 * Resumo de cada horizonte a partir da MESMA série de 90 dias — a série nunca
 * é recalculada por horizonte, só recortada (requisito da Fase 6).
 */
export function summarizeHorizons(
  series: CashFlowSeries,
  horizons: readonly number[] = CASH_FLOW_HORIZONS,
): HorizonSummary[] {
  return horizons.map((horizon) => {
    const window = series.days.slice(0, horizon);
    const last = window[window.length - 1];
    const negative = window.find((day) => day.caixaFinalCents < 0);
    return {
      days: horizon,
      endDate: last ? last.date : series.today,
      entradasCents: window.reduce((sum, day) => sum + day.entradasCents, 0),
      saidasCents: window.reduce((sum, day) => sum + day.saidasCents, 0),
      caixaFinalCents: last ? last.caixaFinalCents : series.caixaAtualCents,
      firstNegativeDate: negative ? negative.date : "",
    };
  });
}
