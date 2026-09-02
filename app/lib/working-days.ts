// Cálculo de dias úteis do mês por escala de trabalho — base dos
// benefícios pagos por dia trabalhado (RH Financeiro).
//
// Regras confirmadas com o usuário:
//  - 5x2: dias úteis = segunda a sexta do mês, menos feriados que caem
//    em dia útil.
//  - 6x1: trabalha 6 / folga 1 repetindo, sem vínculo com a semana do
//    calendário → dias trabalhados ≈ total de dias do mês × 6/7
//    (arredondado), menos a quantidade de feriados da competência
//    (piso em 0).

export const WORK_SCHEDULES = ["5x2", "6x1"] as const;
export type WorkSchedule = (typeof WORK_SCHEDULES)[number];

export function isWorkSchedule(value: unknown): value is WorkSchedule {
  return typeof value === "string" && (WORK_SCHEDULES as readonly string[]).includes(value);
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function daysInMonth(month: string): number {
  if (!MONTH_PATTERN.test(month)) return 0;
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
}

/** Dia da semana (0 = domingo … 6 = sábado) em UTC, sem fuso. */
function weekday(year: number, monthIndex: number, day: number): number {
  return new Date(Date.UTC(year, monthIndex - 1, day)).getUTCDay();
}

function weekdayCount(month: string): number {
  const [year, monthIndex] = month.split("-").map(Number);
  const total = daysInMonth(month);
  let count = 0;
  for (let day = 1; day <= total; day += 1) {
    const wd = weekday(year, monthIndex, day);
    if (wd !== 0 && wd !== 6) count += 1;
  }
  return count;
}

/**
 * `holidayDates`: lista de datas AAAA-MM-DD (já filtradas por abrangência —
 * nacional + a loja do funcionário). Datas fora da competência ou repetidas
 * são ignoradas.
 */
export function workingDaysInMonth(
  month: string,
  schedule: WorkSchedule,
  holidayDates: string[] = [],
): number {
  if (!MONTH_PATTERN.test(month)) return 0;
  const [year, monthIndex] = month.split("-").map(Number);

  const holidaysInMonth = [...new Set(holidayDates)].filter(
    (date) => DATE_PATTERN.test(date) && date.slice(0, 7) === month,
  );

  if (schedule === "5x2") {
    const holidaysOnWeekdays = holidaysInMonth.filter((date) => {
      const wd = weekday(year, monthIndex, Number(date.slice(8, 10)));
      return wd !== 0 && wd !== 6;
    }).length;
    return Math.max(0, weekdayCount(month) - holidaysOnWeekdays);
  }

  // 6x1
  const worked = Math.round((daysInMonth(month) * 6) / 7);
  return Math.max(0, worked - holidaysInMonth.length);
}
