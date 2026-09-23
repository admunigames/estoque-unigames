// Ciclo de benefícios (RH Financeiro) — lógica pura, sem banco.
//
// Regras confirmadas com o usuário:
//  - A competência AAAA-MM cobre do dia 20 desse mês ao dia 19 do mês
//    seguinte (ex.: 2026-09 = 20/09/2026 a 19/10/2026) — não o mês civil.
//  - 5x2: dias trabalhados = segunda a sexta do ciclo, menos feriados que
//    caem em dia útil.
//  - 6x1: quando o funcionário tem loja lançada no módulo Escalas e Folgas
//    em TODOS os meses que o ciclo toca, usa as folgas reais de lá
//    (domingos fora da escala de domingo trabalhado + folgas seg–sáb
//    lançadas) — dias = dias do ciclo − folgas − feriados que não caíram em
//    folga. Sem esses dados, cai na fórmula dias do ciclo × 6/7 (arredondado)
//    menos feriados do ciclo.
// A mesma regra de "folga de domingo" do relatório de Escalas é repetida
// aqui de propósito só como leitura (domingo sem registro de trabalho =
// folga), sem gravar nada no módulo de Escalas.

import type { WorkSchedule } from "./working-days";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

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

export function dateInCycle(date: string, cycle: BenefitCycle) {
  return DATE_PATTERN.test(date) && date >= cycle.start && date <= cycle.end;
}

function holidaysInCycle(cycle: BenefitCycle, holidayDates: string[]) {
  return [...new Set(holidayDates)].filter((date) => dateInCycle(date, cycle));
}

/** Dias trabalhados pela fórmula (sem dados reais de escala). */
export function formulaWorkingDaysInCycle(
  cycle: BenefitCycle,
  schedule: WorkSchedule,
  holidayDates: string[] = [],
): number {
  const dates = cycleDates(cycle);
  const holidays = holidaysInCycle(cycle, holidayDates);
  if (schedule === "5x2") {
    const weekdays = dates.filter((date) => {
      const wd = weekdayOf(date);
      return wd !== 0 && wd !== 6;
    }).length;
    const holidaysOnWeekdays = holidays.filter((date) => {
      const wd = weekdayOf(date);
      return wd !== 0 && wd !== 6;
    }).length;
    return Math.max(0, weekdays - holidaysOnWeekdays);
  }
  const worked = Math.round((dates.length * 6) / 7);
  return Math.max(0, worked - holidays.length);
}

export type ScheduleData = {
  /** Meses (AAAA-MM) em que o funcionário tem loja lançada no Escalas. */
  assignedMonths: string[];
  /** Domingos (AAAA-MM-DD) em que está escalado para trabalhar. */
  sundayWorkDates: string[];
  /** Folgas de segunda a sábado lançadas (AAAA-MM-DD). */
  weekdayOffDates: string[];
};

export type CycleWorkingDays = {
  workingDays: number;
  /** 'escalas' = folgas reais do módulo Escalas; 'formula' = aproximação. */
  source: "escalas" | "formula";
  /** Folgas consideradas (só quando source = 'escalas'). */
  offDays: number;
  holidays: number;
};

/**
 * Escalas só é usado quando cobre o ciclo inteiro — loja lançada nos dois
 * meses que o ciclo toca. Cobertura parcial misturaria dia real com
 * aproximação no mesmo número, então cai tudo na fórmula.
 */
export function scheduleCoversCycle(cycle: BenefitCycle, data: ScheduleData | null | undefined) {
  if (!data) return false;
  const assigned = new Set(data.assignedMonths);
  return cycle.months.every((month) => assigned.has(month));
}

export function workingDaysInCycle(
  cycle: BenefitCycle,
  schedule: WorkSchedule,
  holidayDates: string[] = [],
  scheduleData?: ScheduleData | null,
): CycleWorkingDays {
  const holidays = holidaysInCycle(cycle, holidayDates);
  if (schedule !== "6x1" || !scheduleCoversCycle(cycle, scheduleData)) {
    return {
      workingDays: formulaWorkingDaysInCycle(cycle, schedule, holidayDates),
      source: "formula",
      offDays: 0,
      holidays: schedule === "5x2"
        ? holidays.filter((date) => weekdayOf(date) !== 0 && weekdayOf(date) !== 6).length
        : holidays.length,
    };
  }

  const sundayWork = new Set(scheduleData!.sundayWorkDates);
  const weekdayOff = new Set(scheduleData!.weekdayOffDates);
  const offDates = new Set<string>();
  for (const date of cycleDates(cycle)) {
    if (weekdayOf(date) === 0) {
      if (!sundayWork.has(date)) offDates.add(date);
    } else if (weekdayOff.has(date)) {
      offDates.add(date);
    }
  }
  const holidaysOnWorkDays = holidays.filter((date) => !offDates.has(date)).length;
  const total = cycleDates(cycle).length;
  return {
    workingDays: Math.max(0, total - offDates.size - holidaysOnWorkDays),
    source: "escalas",
    offDays: offDates.size,
    holidays: holidaysOnWorkDays,
  };
}

export type CycleBenefitAmounts = {
  foodCents: number;
  transportCents: number;
  totalCents: number;
};

export function cycleBenefitAmounts(
  workingDays: number,
  foodPerDayCents: number,
  transportPerDayCents: number,
): CycleBenefitAmounts {
  const days = Math.max(0, Math.round(workingDays) || 0);
  const foodCents = days * Math.max(0, Math.round(foodPerDayCents) || 0);
  const transportCents = days * Math.max(0, Math.round(transportPerDayCents) || 0);
  return { foodCents, transportCents, totalCents: foodCents + transportCents };
}
