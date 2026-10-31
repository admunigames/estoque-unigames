// RH > Funcionários > FÉRIAS — regra CLT, lógica pura (decisão do usuário,
// 31/10/2026): período aquisitivo de 12 meses a partir da admissão; as
// férias daquele período vencem 12 meses depois do fim dele (período
// concessivo). Cada período dá 30 dias; as férias gozadas ficam ligadas ao
// início do período aquisitivo (hr_vacations.acquisition_start).

export const VACATION_DAYS = 30;

export type VacationPeriod = {
  /** Início do período aquisitivo (AAAA-MM-DD). */
  start: string;
  /** Fim do período aquisitivo — a partir do dia seguinte já pode tirar. */
  end: string;
  /** Último dia para gozar as férias desse período (fim do concessivo). */
  deadline: string;
  takenDays: number;
  remainingDays: number;
};

export type VacationStatus = {
  /** Período das PRÓXIMAS férias (o mais antigo com saldo), ou null sem admissão. */
  next: (VacationPeriod & { situation: "vencida" | "a_vencer" | "em_aquisicao" }) | null;
  /** Data de retorno das últimas férias (dia seguinte ao fim) ou ''. */
  lastReturn: string;
  periods: VacationPeriod[];
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parts(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d };
}

function iso(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** date + years − daysBack (29/02 vira 01/03 em ano não bissexto, como no Date). */
export function shiftDate(date: string, years: number, days = 0): string {
  const { y, m, d } = parts(date);
  return iso(Date.UTC(y + years, m - 1, d + days));
}

/** Dias corridos de start a end, contando os dois. */
export function vacationDays(start: string, end: string): number {
  if (!DATE_RE.test(start) || !DATE_RE.test(end) || end < start) return 0;
  return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86_400_000) + 1;
}

export function vacationStatus(
  admissionDate: string,
  vacations: Array<{ acquisitionStart: string; startDate: string; endDate: string }>,
  today: string,
): VacationStatus {
  const lastEnd = vacations.reduce((max, item) => (item.endDate > max ? item.endDate : max), "");
  const lastReturn = lastEnd ? shiftDate(lastEnd, 0, 1) : "";
  if (!DATE_RE.test(admissionDate)) return { next: null, lastReturn, periods: [] };
  const taken = new Map<string, number>();
  for (const item of vacations) taken.set(item.acquisitionStart, (taken.get(item.acquisitionStart) ?? 0) + vacationDays(item.startDate, item.endDate));

  // Períodos da admissão até o que está correndo hoje (ponytail: máx. 60 anos).
  const periods: VacationPeriod[] = [];
  for (let k = 0; k < 60; k += 1) {
    const start = shiftDate(admissionDate, k);
    if (start > today && k > 0) break;
    const takenDays = taken.get(start) ?? 0;
    periods.push({
      start,
      end: shiftDate(admissionDate, k + 1, -1),
      deadline: shiftDate(admissionDate, k + 2, -1),
      takenDays,
      remainingDays: Math.max(0, VACATION_DAYS - takenDays),
    });
  }
  // Próximas férias: o período completo mais antigo com saldo; sem nenhum,
  // o período que está sendo adquirido agora.
  const pending = periods.find((period) => period.end < today && period.remainingDays > 0);
  const current = periods.find((period) => period.start <= today && today <= period.end);
  const chosen = pending ?? current ?? null;
  const next = chosen
    ? { ...chosen, situation: (pending ? (chosen.deadline < today ? "vencida" : "a_vencer") : "em_aquisicao") as "vencida" | "a_vencer" | "em_aquisicao" }
    : null;
  return { next, lastReturn, periods };
}
