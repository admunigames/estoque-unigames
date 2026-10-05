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

// ---------------------------------------------------------------------------
// CAIXA SEMANAL (Financeiro 4/9): saldo informado toda segunda-feira × o que
// entrou/saiu na semana. Semana = segunda a domingo.
// ---------------------------------------------------------------------------

/** Segunda-feira da semana de uma data (AAAA-MM-DD). */
export function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = domingo
  return addDays(date, -((weekday + 6) % 7));
}

export function isMonday(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && mondayOf(date) === date;
}

export type WeeklyCashInput = {
  today: string;
  /** Segundas-feiras, em ordem crescente. */
  weeks: string[];
  /** Contas ativas do escopo (as que DEVEM ter saldo informado). */
  accounts: Array<{ accountId: string; accountName: string }>;
  /** Saldos informados (segunda-feira por conta). */
  balances: Array<{ accountId: string; weekDate: string; balanceCents: number }>;
  /** REALIZADO: recebíveis recebidos (data do recebimento). */
  realizedIn: DailyAmount[];
  /** REALIZADO: pagamentos confirmados + RH pago (data do pagamento). */
  realizedOut: DailyAmount[];
  /** Projeção diária a partir de hoje (buildCashFlowSeries). */
  projection: CashFlowDay[];
  /** Caixa Atual — ponto de partida quando a segunda atual não foi informada. */
  caixaAtualCents: number;
};

export type WeeklyCashRow = {
  weekDate: string;
  weekEnd: string;
  kind: "past" | "current" | "future";
  /** Soma dos saldos informados na segunda (null = nenhuma conta informada). */
  informedCents: number | null;
  missingAccounts: string[];
  entradasCents: number;
  saidasCents: number;
  /** Saldo de partida da semana (informado; Caixa Atual; ou previsto da anterior). */
  startCents: number | null;
  expectedNextCents: number | null;
  informedNextCents: number | null;
  missingNextAccounts: string[];
  /** Informado na próxima segunda − previsto (só com as duas segundas completas). */
  differenceCents: number | null;
};

/**
 * Quadro semana a semana.
 * - Semanas PASSADAS: entradas/saídas REALIZADAS na semana, a partir do saldo
 *   informado na segunda; a diferença para o saldo informado na segunda
 *   seguinte mostra o que mexeu no banco sem estar lançado.
 * - Semana ATUAL: se a segunda foi informada, parte dela e soma o realizado
 *   de segunda até ontem + a projeção de hoje até domingo; se não, parte do
 *   Caixa Atual e soma só a projeção de hoje até domingo.
 * - Semanas FUTURAS: partem do previsto da semana anterior e somam a projeção.
 * A projeção já traz os vencidos no dia de hoje (dia 0 da série).
 */
export function buildWeeklyCash(input: WeeklyCashInput): WeeklyCashRow[] {
  const currentMonday = mondayOf(input.today);
  const informed = new Map<string, Map<string, number>>();
  for (const balance of input.balances) {
    if (!informed.has(balance.weekDate)) informed.set(balance.weekDate, new Map());
    informed.get(balance.weekDate)!.set(balance.accountId, Number(balance.balanceCents || 0));
  }
  const informedOf = (weekDate: string) => {
    const byAccount = informed.get(weekDate) ?? new Map<string, number>();
    const missing = input.accounts.filter((a) => !byAccount.has(a.accountId)).map((a) => a.accountName);
    let total = 0;
    for (const value of byAccount.values()) total += value;
    return { total: byAccount.size ? total : null, missing };
  };
  const sumBetween = (rows: DailyAmount[], from: string, to: string) =>
    rows.reduce((sum, row) => (row.date >= from && row.date <= to ? sum + Number(row.amountCents || 0) : sum), 0);
  const projectionBetween = (from: string, to: string) =>
    input.projection.reduce(
      (acc, day) => (day.date >= from && day.date <= to
        ? { entradas: acc.entradas + day.entradasCents, saidas: acc.saidas + day.saidasCents }
        : acc),
      { entradas: 0, saidas: 0 },
    );

  const rows: WeeklyCashRow[] = [];
  let previousExpected: number | null = null;
  for (const weekDate of input.weeks) {
    const weekEnd = addDays(weekDate, 6);
    const kind: WeeklyCashRow["kind"] = weekDate < currentMonday ? "past" : weekDate === currentMonday ? "current" : "future";
    const now = informedOf(weekDate);
    const next = informedOf(addDays(weekDate, 7));
    let entradasCents = 0;
    let saidasCents = 0;
    let startCents: number | null = null;
    if (kind === "past") {
      entradasCents = sumBetween(input.realizedIn, weekDate, weekEnd);
      saidasCents = sumBetween(input.realizedOut, weekDate, weekEnd);
      startCents = now.total;
    } else if (kind === "current") {
      const projected = projectionBetween(input.today, weekEnd);
      if (now.total !== null) {
        const yesterday = addDays(input.today, -1);
        entradasCents = sumBetween(input.realizedIn, weekDate, yesterday) + projected.entradas;
        saidasCents = sumBetween(input.realizedOut, weekDate, yesterday) + projected.saidas;
        startCents = now.total;
      } else {
        entradasCents = projected.entradas;
        saidasCents = projected.saidas;
        startCents = Number(input.caixaAtualCents || 0);
      }
    } else {
      const projected = projectionBetween(weekDate, weekEnd);
      entradasCents = projected.entradas;
      saidasCents = projected.saidas;
      startCents = previousExpected;
    }
    const expectedNextCents: number | null = startCents === null ? null : startCents + entradasCents - saidasCents;
    const comparable = kind !== "future" && next.total !== null && !next.missing.length && !now.missing.length;
    rows.push({
      weekDate,
      weekEnd,
      kind,
      informedCents: now.total,
      missingAccounts: now.missing,
      entradasCents,
      saidasCents,
      startCents,
      expectedNextCents,
      informedNextCents: kind === "future" ? null : next.total,
      missingNextAccounts: kind === "future" ? [] : next.missing,
      differenceCents: comparable && expectedNextCents !== null ? (next.total as number) - expectedNextCents : null,
    });
    previousExpected = expectedNextCents;
  }
  return rows;
}
