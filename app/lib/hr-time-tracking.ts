// Controle de Horas - Logística — lançamento manual do ponto de papel
// (não é integração com relógio de ponto) e cálculo de horas
// trabalhadas/extras + banco de horas.
//
// Regras confirmadas com o usuário:
//  - A jornada (quantidade de marcações por dia) VARIA por colaborador/dia
//    — não é sempre entrada/saída-almoço/retorno-almoço/saída. Por isso as
//    marcações são uma lista de horários (par, alternando entrada/saída),
//    não campos fixos.
//  - A jornada contratada (referência para hora extra) VARIA por
//    colaborador/cargo — cada colaborador tem sua própria meta diária,
//    cadastrada em hr_time_tracking_settings.
//
// Marcações alternam entrada/saída: intervalos ímpares (1ª–2ª, 3ª–4ª, …)
// são trabalhados; intervalos pares (2ª–3ª, 4ª–5ª, …) são intervalo/almoço
// e não entram na soma. Isso cobre 2 marcações (sem intervalo), 4 (um
// intervalo) ou mais (vários intervalos) com a mesma regra.

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parsePunches(raw: string): string[] {
  return String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function formatPunches(punches: string[]): string {
  return punches.join(",");
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

export type PunchValidation = { ok: true; minutesList: number[] } | { ok: false; error: string };

export function validatePunches(punches: string[]): PunchValidation {
  if (punches.length < 2) {
    return { ok: false, error: "INFORME AO MENOS UMA ENTRADA E UMA SAÍDA." };
  }
  if (punches.length % 2 !== 0) {
    return { ok: false, error: "AS MARCAÇÕES DEVEM SER EM PARES (ENTRADA E SAÍDA)." };
  }
  const minutesList: number[] = [];
  for (const punch of punches) {
    if (!TIME_PATTERN.test(punch)) {
      return { ok: false, error: `HORÁRIO INVÁLIDO: "${punch}" (USE HH:MM).` };
    }
    minutesList.push(toMinutes(punch));
  }
  for (let index = 1; index < minutesList.length; index += 1) {
    if (minutesList[index] <= minutesList[index - 1]) {
      return { ok: false, error: "AS MARCAÇÕES DEVEM ESTAR EM ORDEM CRESCENTE, SEM REPETIÇÃO." };
    }
  }
  return { ok: true, minutesList };
}

/** Soma dos intervalos trabalhados (ímpares): 1ª–2ª, 3ª–4ª, … */
export function computeWorkedMinutes(minutesList: number[]): number {
  let worked = 0;
  for (let index = 0; index + 1 < minutesList.length; index += 2) {
    worked += minutesList[index + 1] - minutesList[index];
  }
  return worked;
}

export type DailyBalance = {
  workedMinutes: number;
  targetMinutes: number;
  balanceMinutes: number;
};

export function computeDailyBalance(minutesList: number[], targetMinutes: number): DailyBalance {
  const workedMinutes = computeWorkedMinutes(minutesList);
  return { workedMinutes, targetMinutes, balanceMinutes: workedMinutes - targetMinutes };
}

export function formatHoursFromMinutes(totalMinutes: number): string {
  const sign = totalMinutes < 0 ? "-" : "";
  const absolute = Math.abs(totalMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `${sign}${hours}h${String(minutes).padStart(2, "0")}`;
}

export type MonthlyEntrySummary = { balanceMinutes: number };

export type MonthlyBalanceRow = {
  yearMonth: string;
  workedMinutes: number;
  targetMinutes: number;
  overtimeMinutes: number;
  deficitMinutes: number;
  netMinutes: number;
  paidMinutes: number;
  cumulativeBalanceMinutes: number;
};

/**
 * Agrega lançamentos diários (já com balanceMinutes calculado e gravado)
 * por mês e acumula o saldo (banco de horas) mês a mês, em ordem
 * cronológica, descontando o que já foi pago em cada competência.
 */
export function aggregateMonthlyBalance(
  entries: Array<{ yearMonth: string; workedMinutes: number; targetMinutes: number; balanceMinutes: number }>,
  paidMinutesByMonth: Record<string, number>,
): MonthlyBalanceRow[] {
  const byMonth = new Map<string, { workedMinutes: number; targetMinutes: number; overtimeMinutes: number; deficitMinutes: number; netMinutes: number }>();
  for (const entry of entries) {
    const current = byMonth.get(entry.yearMonth) || {
      workedMinutes: 0,
      targetMinutes: 0,
      overtimeMinutes: 0,
      deficitMinutes: 0,
      netMinutes: 0,
    };
    current.workedMinutes += entry.workedMinutes;
    current.targetMinutes += entry.targetMinutes;
    current.overtimeMinutes += Math.max(0, entry.balanceMinutes);
    current.deficitMinutes += Math.max(0, -entry.balanceMinutes);
    current.netMinutes += entry.balanceMinutes;
    byMonth.set(entry.yearMonth, current);
  }
  for (const yearMonth of Object.keys(paidMinutesByMonth)) {
    if (!byMonth.has(yearMonth)) {
      byMonth.set(yearMonth, { workedMinutes: 0, targetMinutes: 0, overtimeMinutes: 0, deficitMinutes: 0, netMinutes: 0 });
    }
  }
  const months = [...byMonth.keys()].sort();
  let cumulative = 0;
  return months.map((yearMonth) => {
    const summary = byMonth.get(yearMonth)!;
    const paidMinutes = paidMinutesByMonth[yearMonth] || 0;
    cumulative += summary.netMinutes - paidMinutes;
    return {
      yearMonth,
      workedMinutes: summary.workedMinutes,
      targetMinutes: summary.targetMinutes,
      overtimeMinutes: summary.overtimeMinutes,
      deficitMinutes: summary.deficitMinutes,
      netMinutes: summary.netMinutes,
      paidMinutes,
      cumulativeBalanceMinutes: cumulative,
    };
  });
}
