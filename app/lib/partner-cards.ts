// CARTÕES DE CRÉDITO SÓCIO (23/10/2026) — conta do mês, sem banco.
//
// Parcelada: (valor − desconto) dividido em `installments` meses a partir de
// firstMonth; o centavo que sobra vai na última. FIXA: (valor − desconto)
// todo mês de firstMonth até endMonth ('' = sem fim).

export type PartnerCardEntry = {
  amountCents: number;
  discountCents: number;
  installments: number;
  fixed: number | boolean;
  firstMonth: string;
  endMonth: string;
};

export function monthIndex(month: string) {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

export function addMonths(month: string, count: number) {
  const index = monthIndex(month) + count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

export function netCents(entry: PartnerCardEntry) {
  return Math.max(0, Math.round(Number(entry.amountCents) || 0) - Math.round(Number(entry.discountCents) || 0));
}

/** Parcela do mês (0 = não cai neste mês) e qual parcela é (1..n; 0 na fixa). */
export function installmentForMonth(entry: PartnerCardEntry, month: string): { cents: number; number: number; total: number } {
  const offset = monthIndex(month) - monthIndex(entry.firstMonth);
  if (offset < 0) return { cents: 0, number: 0, total: 0 };
  const net = netCents(entry);
  if (entry.fixed === true || Number(entry.fixed) === 1) {
    if (entry.endMonth && month > entry.endMonth) return { cents: 0, number: 0, total: 0 };
    return { cents: net, number: 0, total: 0 };
  }
  const total = Math.max(1, Math.round(Number(entry.installments) || 1));
  if (offset >= total) return { cents: 0, number: 0, total };
  const each = Math.floor(net / total);
  return { cents: offset === total - 1 ? net - each * (total - 1) : each, number: offset + 1, total };
}
