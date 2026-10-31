// Ciclo de benefícios (RH Financeiro) — lógica pura, sem banco.
//
// Regras confirmadas com o usuário (28/10/2026):
//  - A competência AAAA-MM cobre do dia 20 desse mês ao dia 19 do mês
//    seguinte (ex.: 2026-09 = 20/09/2026 a 19/10/2026) — não o mês civil.
//  - Alimentação = valor cheio da escala; transporte = valor por dia × dias
//    exatos do ciclo (5x2: seg–sex; 6x1: seg–sáb). Ver countedDaysInCycle.

import type { WorkSchedule } from "./working-days";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const BENEFIT_CYCLE_START_DAY = 20;
export const BENEFIT_CYCLE_END_DAY = 19;

export type BenefitCycle = {
  month: string;
  /** Primeiro dia do ciclo (AAAA-MM-20). */
  start: string;
  /** Último dia do ciclo (AAAA-MM-19 do mês seguinte). */
  end: string;
  /** Meses civis que o ciclo toca (sempre dois). */
  months: [string, string];
};

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function isCycleMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH_PATTERN.test(value);
}

export function nextMonth(month: string): string {
  const [year, monthIndex] = month.split("-").map(Number);
  return monthIndex === 12 ? `${year + 1}-01` : `${year}-${pad2(monthIndex + 1)}`;
}

export function benefitCycle(month: string): BenefitCycle | null {
  if (!isCycleMonth(month)) return null;
  const following = nextMonth(month);
  return {
    month,
    start: `${month}-${pad2(BENEFIT_CYCLE_START_DAY)}`,
    end: `${following}-${pad2(BENEFIT_CYCLE_END_DAY)}`,
    months: [month, following],
  };
}

/** Todas as datas AAAA-MM-DD do ciclo, em ordem. */
export function cycleDates(cycle: BenefitCycle): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${cycle.start}T00:00:00Z`);
  const last = new Date(`${cycle.end}T00:00:00Z`).getTime();
  while (cursor.getTime() <= last) {
    dates.push(
      `${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}-${pad2(cursor.getUTCDate())}`,
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function weekdayOf(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export type BenefitRule = {
  /** Alimentação: valor CHEIO do ciclo. */
  foodCents: number;
  /** Transporte: valor por dia contado. */
  transportPerDayCents: number;
};
export type BenefitRules = Record<WorkSchedule, BenefitRule>;

// Valores da aba REGRAS de Benefícios (hr_settings, chave "benefit_rules").
export const DEFAULT_BENEFIT_RULES: BenefitRules = {
  "5x2": { foodCents: 24500, transportPerDayCents: 900 },
  "6x1": { foodCents: 50000, transportPerDayCents: 900 },
};

function cents(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

/** Regras salvas (JSON) com os padrões para o que faltar ou for inválido. */
export function parseBenefitRules(value: unknown): BenefitRules {
  let data: Record<string, Record<string, unknown>> = {};
  try {
    data = typeof value === "string" ? JSON.parse(value) : (value as typeof data) ?? {};
  } catch {
    data = {};
  }
  const rule = (schedule: WorkSchedule): BenefitRule => ({
    foodCents: cents(data?.[schedule]?.foodCents, DEFAULT_BENEFIT_RULES[schedule].foodCents),
    transportPerDayCents: cents(data?.[schedule]?.transportPerDayCents, DEFAULT_BENEFIT_RULES[schedule].transportPerDayCents),
  });
  return { "5x2": rule("5x2"), "6x1": rule("6x1") };
}

/**
 * Dias exatos do ciclo: 5x2 = segunda a sexta; 6x1 = segunda a sábado.
 * Feriados, faltas, atestados e folgas NÃO saem daqui — são ajustados na
 * revisão do ciclo antes do pagamento (decisão do usuário, 28/10/2026).
 */
export function countedDaysInCycle(cycle: BenefitCycle, schedule: WorkSchedule): number {
  return cycleDates(cycle).filter((date) => {
    const wd = weekdayOf(date);
    return wd !== 0 && (schedule === "6x1" || wd !== 6);
  }).length;
}

export type CycleBenefitAmounts = {
  foodCents: number;
  transportCents: number;
  totalCents: number;
};

/**
 * Valor do funcionário no ciclo: o VALOR TOTAL MENSAL do cadastro (> 0)
 * substitui a regra da escala (31/10/2026). O transporte total vale para os
 * dias contados do ciclo; a revisão de dias de passagem aplica a proporção.
 */
export type EmployeeBenefitRule = BenefitRule & { transportTotalCents: number; countedDays: number };
export function employeeBenefitRule(
  rule: BenefitRule,
  employee: { benefitFoodTotalCents?: number; benefitTransportTotalCents?: number },
  countedDays: number,
): EmployeeBenefitRule {
  const food = Math.max(0, Math.round(Number(employee.benefitFoodTotalCents) || 0));
  const transport = Math.max(0, Math.round(Number(employee.benefitTransportTotalCents) || 0));
  return { foodCents: food || rule.foodCents, transportPerDayCents: rule.transportPerDayCents, transportTotalCents: transport, countedDays };
}

/** Alimentação cheia ± ajuste da revisão; transporte = dias × valor do dia (ou total proporcional). */
export function cycleBenefitAmounts(
  rule: BenefitRule & { transportTotalCents?: number; countedDays?: number },
  transportDays: number,
  foodAdjustCents = 0,
): CycleBenefitAmounts {
  const days = Math.max(0, Math.round(transportDays) || 0);
  const foodCents = Math.max(0, rule.foodCents + (Math.round(foodAdjustCents) || 0));
  const counted = Number(rule.countedDays) || 0;
  const transportCents = rule.transportTotalCents
    ? (counted ? Math.round((rule.transportTotalCents * days) / counted) : 0)
    : days * rule.transportPerDayCents;
  return { foodCents, transportCents, totalCents: foodCents + transportCents };
}
