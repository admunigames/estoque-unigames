// Recargas de Celulares (Financeiro 8/9): período de recarga por linha
// (30 / 60 / 90 dias corridos). Regra única do servidor; o front só repete a
// conta como prévia (recargaNextDate em public/estoque.html, comparado em teste).

import { addDays } from "./finance-status";

export const RECHARGE_PERIOD_DAYS = [30, 60, 90] as const;
export type RechargePeriod = (typeof RECHARGE_PERIOD_DAYS)[number];
export const DEFAULT_RECHARGE_PERIOD: RechargePeriod = 90;
export const RECHARGE_PERIOD_ERROR = "ESCOLHA 30, 60 OU 90 DIAS.";

export function isRechargePeriod(value: unknown): value is RechargePeriod {
  return RECHARGE_PERIOD_DAYS.includes(value as RechargePeriod);
}

/** Sem valor → 90; 30/60/90 (número ou texto) → ele; qualquer outro → null (400). */
export function parseRechargePeriod(value: unknown): RechargePeriod | null {
  if (value === undefined || value === null || value === "") return DEFAULT_RECHARGE_PERIOD;
  const n = Number(value);
  return isRechargePeriod(n) ? n : null;
}

/** Última recarga + N dias corridos (31/01/2026 + 30 = 02/03/2026). */
export function nextRechargeDate(lastDate: string, periodDays: number): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(lastDate) ? addDays(lastDate, periodDays) : "";
}
