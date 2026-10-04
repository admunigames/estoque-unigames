// Lógica pura dos Cartões de Crédito Corporativos (Financeiro Fase 7).
// Sem I/O. IMPORTANTE: este módulo NUNCA lida com senha nem CVV — a única
// coisa relacionada a "dados sensíveis" aqui é a lista de chaves que devem
// ser RECUSADAS/DESCARTADAS se aparecerem num payload ou numa planilha.

// Chaves que jamais podem ser aceitas/gravadas/logadas. Se qualquer uma
// aparecer no corpo de uma requisição, a rota responde 400. Se aparecer
// numa planilha importada, o front descarta a coluna antes de enviar.
export const FORBIDDEN_CARD_KEYS = [
  "cvv",
  "cvc",
  "cvv2",
  "cid",
  "codigodeseguranca",
  "codigoseguranca",
  "securitycode",
  "password",
  "senha",
  "pin",
];

function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** true se o objeto tem QUALQUER chave proibida (em qualquer grafia). */
export function hasForbiddenCardKey(input: Record<string, unknown>): boolean {
  return Object.keys(input).some((key) => FORBIDDEN_CARD_KEYS.includes(normalizeKey(key)));
}

export const CORPORATE_CARD_STATUSES = ["active", "blocked", "canceled"] as const;
export type CorporateCardStatus = (typeof CORPORATE_CARD_STATUSES)[number];

export function isCorporateCardStatus(value: unknown): value is CorporateCardStatus {
  return typeof value === "string" && (CORPORATE_CARD_STATUSES as readonly string[]).includes(value);
}

function isDay(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 31;
}

export function validateCorporateCardDraft(draft: {
  name: string;
  last4: string;
  bestPurchaseDay: number;
  closingDay: number;
  dueDay: number;
}): string | null {
  if (draft.name.trim().length < 2) return "INFORME O NOME DO CARTÃO.";
  if (!/^\d{4}$/.test(draft.last4)) return "OS ÚLTIMOS 4 DÍGITOS DEVEM TER EXATAMENTE 4 NÚMEROS.";
  if (!isDay(draft.closingDay)) return "DIA DE FECHAMENTO INVÁLIDO (1 A 31).";
  if (!isDay(draft.dueDay)) return "DIA DE VENCIMENTO INVÁLIDO (1 A 31).";
  if (draft.bestPurchaseDay && !isDay(draft.bestPurchaseDay)) {
    return "MELHOR DIA DE COMPRA INVÁLIDO (1 A 31).";
  }
  return null;
}

/**
 * Interpreta um rótulo de parcela: "2/6", "02 / 06", "2 de 6",
 * "PARCELA 2/6", "2-6". Devolve { current, total } ou { current: 1, total: 1 }
 * quando não há indicação de parcelamento.
 */
export function parseInstallmentLabel(text: string): { current: number; total: number; label: string } {
  const match = String(text || "").match(/(\d{1,2})\s*(?:\/|de|-)\s*(\d{1,2})/i);
  if (!match) return { current: 1, total: 1, label: "" };
  const current = Math.max(1, Number(match[1]));
  const total = Math.max(current, Number(match[2]));
  return { current, total, label: `${current}/${total}` };
}

function clampDayToMonth(year: number, monthIndex0: number, day: number): string {
  const lastDay = new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
  const d = Math.min(day, lastDay);
  return `${year}-${String(monthIndex0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Datas do ciclo de fatura a partir de hoje:
 * - closingDate: próximo fechamento >= hoje
 * - previousClosing: fechamento anterior (início do ciclo em aberto)
 * - dueDate: vencimento da fatura que fecha em closingDate (dueDay; se o dia
 *   de vencimento for <= dia de fechamento, cai no mês seguinte).
 */
export function invoiceCycleDates(
  today: string,
  closingDay: number,
  dueDay: number,
): { previousClosing: string; closingDate: string; dueDate: string } {
  const [y, m, d] = today.split("-").map(Number);
  const year = y;
  const monthIndex = m - 1;
  let closingYear = year;
  let closingMonthIndex = monthIndex;
  if (d > Math.min(closingDay, new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate())) {
    closingMonthIndex += 1;
    if (closingMonthIndex > 11) {
      closingMonthIndex = 0;
      closingYear += 1;
    }
  }
  const closingDate = clampDayToMonth(closingYear, closingMonthIndex, closingDay);

  let prevYear = closingYear;
  let prevMonthIndex = closingMonthIndex - 1;
  if (prevMonthIndex < 0) {
    prevMonthIndex = 11;
    prevYear -= 1;
  }
  const previousClosing = clampDayToMonth(prevYear, prevMonthIndex, closingDay);

  let dueYear = closingYear;
  let dueMonthIndex = closingMonthIndex;
  if (dueDay <= closingDay) {
    dueMonthIndex += 1;
    if (dueMonthIndex > 11) {
      dueMonthIndex = 0;
      dueYear += 1;
    }
  }
  const dueDate = clampDayToMonth(dueYear, dueMonthIndex, dueDay);
  return { previousClosing, closingDate, dueDate };
}

export type CardEntryForSummary = {
  entryDate: string;
  amountCents: number;
  installmentCurrent: number;
  installmentTotal: number;
};

/**
 * Resumo do cartão. "Utilizado" é o compromisso do limite: os lançamentos
 * do ciclo em aberto + as parcelas ainda não faturadas dos parcelamentos.
 * Não há controle de pagamento da fatura no sistema, então "utilizado" é
 * uma projeção do comprometido, não um saldo devedor exato.
 */
export function computeCardSummary(input: {
  limitCents: number;
  closingDay: number;
  dueDay: number;
  today: string;
  entries: CardEntryForSummary[];
}): {
  limitCents: number;
  currentInvoiceCents: number;
  futureInstallmentsCents: number;
  usedCents: number;
  availableCents: number;
  closingDate: string;
  dueDate: string;
} {
  const { previousClosing, closingDate, dueDate } = invoiceCycleDates(
    input.today,
    input.closingDay,
    input.dueDay,
  );
  let currentInvoiceCents = 0;
  let futureInstallmentsCents = 0;
  for (const entry of input.entries) {
    if (entry.entryDate > previousClosing && entry.entryDate <= closingDate) {
      currentInvoiceCents += entry.amountCents;
    }
    const total = Math.max(1, Number(entry.installmentTotal || 1));
    const current = Math.max(1, Number(entry.installmentCurrent || 1));
    if (total > current) {
      const perInstallment = Math.round(entry.amountCents);
      futureInstallmentsCents += perInstallment * (total - current);
    }
  }
  const usedCents = currentInvoiceCents + futureInstallmentsCents;
  return {
    limitCents: input.limitCents,
    currentInvoiceCents,
    futureInstallmentsCents,
    usedCents,
    availableCents: input.limitCents - usedCents,
    closingDate,
    dueDate,
  };
}

// ---------------------------------------------------------------------------
// Financeiro 2/9 (04/10/2026): duplicidade de lançamentos e classificação.
// ---------------------------------------------------------------------------

// 'not_expense' = NÃO É DESPESA (compra pessoal a reembolsar, estorno,
// transferência): nunca vira Despesa e pode voltar para pendente.
export const CARD_ENTRY_STATUSES = ["pending", "classified", "expensed", "not_expense"] as const;
export type CardEntryStatus = (typeof CARD_ENTRY_STATUSES)[number];

/** Estabelecimento comparável: maiúsculas, sem acento, espaços simples. */
export function normalizeMerchant(text: string): string {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Chave de "mesmo lançamento" num cartão: data + valor + estabelecimento
 * normalizado + parcela atual/total. Parcelas 2/10 e 3/10 da mesma compra
 * têm chaves diferentes (não são duplicadas).
 */
export function cardEntryDuplicateKey(entry: {
  entryDate: string;
  amountCents: number;
  merchant: string;
  installmentCurrent: number;
  installmentTotal: number;
}): string {
  const current = Math.max(1, Number(entry.installmentCurrent) || 1);
  const total = Math.max(current, Number(entry.installmentTotal) || 1);
  return [entry.entryDate, Math.round(Number(entry.amountCents) || 0), normalizeMerchant(entry.merchant), `${current}/${total}`].join("|");
}

function dayNumber(isoDate: string): number {
  return Math.round(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);
}

/** Soma dias a uma data AAAA-MM-DD. */
export function shiftIsoDate(isoDate: string, days: number): string {
  return new Date((dayNumber(isoDate) + days) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Lançamentos ainda não lançados que provavelmente já estão em Despesas
 * (alguém lançou a compra à mão): Despesa da mesma loja, mesmo valor, data
 * a até ±`days` dias e sem vínculo com cartão. Só sinaliza.
 */
export function possibleExpenseDuplicates(
  entries: Array<{ id: string; entryDate: string; amountCents: number; expenseId: string; status: string }>,
  expenses: Array<{ date: string; amountCents: number }>,
  days = 3,
): Set<string> {
  const flagged = new Set<string>();
  for (const entry of entries) {
    if (entry.expenseId || entry.status === "not_expense") continue;
    const day = dayNumber(entry.entryDate);
    const hit = expenses.some(
      (expense) => Number(expense.amountCents) === Number(entry.amountCents) && Math.abs(dayNumber(expense.date) - day) <= days,
    );
    if (hit) flagged.add(entry.id);
  }
  return flagged;
}

export type CardEntryFields = {
  categoryItemId?: string;
  costCenterId?: string;
  holderName?: string;
  notes?: string;
  // 'expense' (é despesa) | 'not_expense' (NÃO É DESPESA). Ausente = mantém.
  expenseKind?: "expense" | "not_expense";
};

/**
 * Aplica só os campos informados a um lançamento e devolve o novo estado.
 * Lançamento já LANÇADO EM DESPESAS só aceita responsável e observação (a
 * categoria vale pela Despesa).
 */
export function applyCardEntryFields(
  entry: { status: string; expenseId: string; categoryItemId: string; costCenterId: string; holderName: string; notes: string },
  fields: CardEntryFields,
):
  | { error: string }
  | { status: CardEntryStatus; categoryItemId: string; costCenterId: string; holderName: string; notes: string } {
  const next = {
    categoryItemId: fields.categoryItemId ?? entry.categoryItemId,
    costCenterId: fields.costCenterId ?? entry.costCenterId,
    holderName: fields.holderName ?? entry.holderName,
    notes: fields.notes ?? entry.notes,
  };
  if (entry.expenseId) {
    if (fields.categoryItemId !== undefined || fields.costCenterId !== undefined || fields.expenseKind !== undefined) {
      return { error: "JÁ LANÇADO EM DESPESAS — ALTERE PELA DESPESA." };
    }
    return { ...next, status: "expensed" };
  }
  const notExpense = fields.expenseKind ? fields.expenseKind === "not_expense" : entry.status === "not_expense";
  return { ...next, status: notExpense ? "not_expense" : next.categoryItemId ? "classified" : "pending" };
}
