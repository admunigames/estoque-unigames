// Lógica pura (sem I/O) do parcelamento de DESCONTO do Comissionamento
// (item 2). Fica isolada, sem imports internos, para ser testada direto
// (ver tests/hr-payroll.test.mjs) sem o resolvedor de módulos do bundler.
//
// Regra confirmada com o usuário: o desconto parcelado REPETE o valor
// cheio nas competências seguintes (não divide). Ex.: R$150 em 3x lança
// R$150 na competência-âncora + R$150 + R$150 nas duas seguintes.

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// Trava de segurança: no máximo 60 ocorrências (5 anos) por série.
export const MAX_INSTALLMENTS = 60;

/** Competência AAAA-MM somada de N meses (N pode ser 0). */
export function addMonthsToCompetence(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const base = new Date(Date.UTC(year, monthNumber - 1, 1));
  base.setUTCMonth(base.getUTCMonth() + offset);
  const nextYear = base.getUTCFullYear();
  const nextMonth = String(base.getUTCMonth() + 1).padStart(2, "0");
  return `${nextYear}-${nextMonth}`;
}

/**
 * Competências de todas as ocorrências de uma série, a partir da âncora
 * (inclusive). total = 1 devolve só a âncora (equivale a não parcelar).
 */
export function competencesForInstallments(anchorMonth: string, total: number): string[] {
  const count = Math.max(1, Math.min(MAX_INSTALLMENTS, Math.trunc(total)));
  const months: string[] = [];
  for (let index = 0; index < count; index += 1) {
    months.push(addMonthsToCompetence(anchorMonth, index));
  }
  return months;
}

/**
 * Normaliza a quantidade de parcelas informada. Só vale para desconto:
 * qualquer outro tipo, ou valor < 2, devolve 1 (sem parcelamento).
 */
export function normalizeInstallmentTotal(kind: string, rawTotal: unknown): number {
  if (kind !== "desconto") return 1;
  const parsed = Math.trunc(Number(rawTotal));
  if (!Number.isFinite(parsed) || parsed < 2) return 1;
  return Math.min(MAX_INSTALLMENTS, parsed);
}
