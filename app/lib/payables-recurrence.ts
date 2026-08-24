// Lógica pura (sem I/O) de datas/valores de Contas a Pagar — recorrência,
// parcelamento e as duas escritas que sincronizam finance_store_entries com
// a soma das contas a pagar não canceladas de uma célula loja+item+mês.
// Fica num módulo sem imports internos de propósito, pra poder ser testada
// diretamente (ver tests/finance-payables.test.mjs) sem precisar do
// resolvedor de módulos do bundler.

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const RECURRENCE_FREQUENCIES = [
  "weekly",
  "monthly",
  "bimonthly",
  "quarterly",
  "semiannual",
  "annual",
] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

const FREQUENCY_STEP_DAYS: Record<RecurrenceFrequency, number | null> = {
  weekly: 7,
  monthly: null,
  bimonthly: null,
  quarterly: null,
  semiannual: null,
  annual: null,
};
const FREQUENCY_STEP_MONTHS: Record<RecurrenceFrequency, number | null> = {
  weekly: null,
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

function monthOf(dateText: string): string {
  return dateText.slice(0, 7);
}

function addDaysToDate(dateText: string, days: number): string {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonthsToDate(dateText: string, months: number): string {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, 1));
  date.setUTCMonth(date.getUTCMonth() + months);
  // Trata meses com quantidades diferentes de dias: se o dia original não
  // existe no mês de destino (ex.: 31 de janeiro -> fevereiro), cai no
  // último dia do mês de destino em vez de estourar pro mês seguinte.
  const lastDayOfTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return date.toISOString().slice(0, 10);
}

export function nextRecurrenceDueDate(dueDate: string, frequency: RecurrenceFrequency): string {
  const days = FREQUENCY_STEP_DAYS[frequency];
  if (days) return addDaysToDate(dueDate, days);
  const months = FREQUENCY_STEP_MONTHS[frequency];
  return addMonthsToDate(dueDate, months ?? 1);
}

/**
 * Gera as datas de vencimento de todas as ocorrências de uma recorrência, a
 * partir da primeira. Limitada por occurrenceCount OU endDate (o que vier
 * primeiro); pelo menos um dos dois é obrigatório na validação da rota.
 */
export function generateRecurrenceDueDates(params: {
  firstDueDate: string;
  frequency: RecurrenceFrequency;
  occurrenceCount: number | null;
  endDate: string;
}): string[] {
  const dates: string[] = [params.firstDueDate];
  const maxOccurrences = params.occurrenceCount ?? 260; // trava de segurança (~5 anos semanais)
  while (dates.length < maxOccurrences) {
    const next = nextRecurrenceDueDate(dates[dates.length - 1], params.frequency);
    if (params.endDate && next > params.endDate) break;
    dates.push(next);
  }
  return dates;
}

/**
 * Divide o valor total em N parcelas de mesmo valor, jogando a diferença de
 * arredondamento (centavos) inteiramente na última parcela — garante que a
 * soma das parcelas bate exatamente com o valor original.
 */
export function splitIntoInstallments(totalAmountCents: number, installmentTotal: number): number[] {
  const base = Math.floor(totalAmountCents / installmentTotal);
  const amounts = new Array(installmentTotal).fill(base);
  const remainder = totalAmountCents - base * installmentTotal;
  amounts[amounts.length - 1] += remainder;
  return amounts;
}

/** Vencimentos mensais sucessivos de um parcelamento, a partir da 1ª parcela. */
export function generateInstallmentDueDates(firstDueDate: string, installmentTotal: number): string[] {
  const dates: string[] = [firstDueDate];
  for (let i = 1; i < installmentTotal; i += 1) {
    dates.push(addMonthsToDate(firstDueDate, i));
  }
  return dates;
}

export function competenceMonthOf(dueDate: string): string {
  return monthOf(dueDate);
}

/**
 * As duas escritas que mantêm finance_store_entries em dia com a soma das
 * contas a pagar não canceladas de uma célula (loja+item+mês) — rodar as
 * duas, nessa ordem, dentro da MESMA transação que grava a(s) linha(s) de
 * accounts_payable, para cada slot (storeId,itemId,month) afetado pela
 * operação (na edição, isso inclui o slot antigo E o novo, se mudou).
 *
 * Nunca sobrescreve uma célula com source='manual' — a checagem de conflito
 * acontece antes, em assertSlotAvailableForPayable() (payables/shared.ts).
 */
export function recalcPayableEntrySql(
  newEntryId: string,
  storeId: string,
  itemId: string,
  month: string,
  actorId: string,
  actorName: string,
): [string, unknown[]][] {
  const deleteStale = [
    `DELETE FROM finance_store_entries
     WHERE store_id=?1 AND item_id=?2 AND month=?3 AND source='payable'
       AND NOT EXISTS (
         SELECT 1 FROM accounts_payable
         WHERE company_id=?1 AND finance_item_id=?2 AND competence_month=?3 AND status != 'canceled'
       )`,
    [storeId, itemId, month],
  ] as [string, unknown[]];

  const upsert = [
    `INSERT INTO finance_store_entries
      (id, store_id, item_id, month, entry_type, amount_cents, percent_basis_points, source,
       created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
     SELECT ?4, ?1, ?2, ?3, 'fixed', agg.total, NULL, 'payable', ?5, ?6, CURRENT_TIMESTAMP, ?5, ?6, CURRENT_TIMESTAMP
     FROM (
       SELECT COALESCE(SUM(original_amount_cents), 0) AS total
       FROM accounts_payable
       WHERE company_id=?1 AND finance_item_id=?2 AND competence_month=?3 AND status != 'canceled'
     ) AS agg
     WHERE agg.total > 0
     ON CONFLICT (store_id, item_id, month) DO UPDATE
       SET amount_cents = EXCLUDED.amount_cents,
           entry_type = 'fixed',
           source = 'payable',
           updated_by = EXCLUDED.updated_by,
           updated_by_name = EXCLUDED.updated_by_name,
           updated_at = CURRENT_TIMESTAMP
       WHERE finance_store_entries.source = 'payable'`,
    [storeId, itemId, month, newEntryId, actorId, actorName],
  ] as [string, unknown[]];

  return [deleteStale, upsert];
}

/**
 * Mesma precedência de app/lib/finance-status.ts#computeDisplayStatus,
 * escrita como expressão SQL (CASE), pra filtrar/ordenar no backend sem
 * carregar todas as linhas pra JS. O placeholder aqui é sempre o parâmetro
 * de "hoje" (YYYY-MM-DD) — passar por bind, nunca interpolar direto.
 */
export function displayStatusCaseSql(todayParamIndex: number): string {
  const p = `?${todayParamIndex}`;
  return `CASE
    WHEN status = 'canceled' THEN 'canceled'
    WHEN status = 'paid' THEN 'paid'
    WHEN due_date < ${p} THEN 'overdue'
    WHEN due_date = ${p} THEN 'due_today'
    WHEN status = 'partially_paid' THEN 'partially_paid'
    WHEN status = 'scheduled' THEN 'scheduled'
    ELSE 'upcoming'
  END`;
}
