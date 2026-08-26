// Regras centralizadas de status/datas de Contas a Pagar — única fonte de
// verdade pra não deixar status armazenado divergir do calculado (ver
// requisito de "Regime contábil" do módulo). O status persistido no banco
// só guarda os estados que dependem de uma AÇÃO explícita do usuário
// ('open' | 'scheduled' | 'partially_paid' | 'paid' | 'canceled'); os
// estados que dependem da data atual (vencido/vencendo hoje/a vencer) são
// sempre calculados aqui, nunca gravados.

// Mesmo fuso já usado pelo restante do módulo Financeiro (ver
// financeCurrentMonthKey() em public/estoque.html) — America/Recife e
// America/Sao_Paulo têm o mesmo offset (UTC-3, sem horário de verão desde
// 2019), então é o mesmo "hoje" na prática; mantido igual ao que já existia
// em vez de introduzir um segundo identificador de fuso pro mesmo horário.
export const TIMEZONE = "America/Recife";

export type StoredStatus = "open" | "scheduled" | "partially_paid" | "paid" | "canceled";

export type DisplayStatus =
  | "upcoming" // a vencer
  | "due_today" // vencendo hoje
  | "overdue" // vencido
  | "partially_paid"
  | "paid"
  | "scheduled"
  | "canceled";

/** Data de hoje (YYYY-MM-DD) no fuso configurado do projeto. */
export function todayInTimezone(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(now);
}

/**
 * Status ARMAZENADO derivado dos valores da obrigação, recalculado a cada
 * escrita (criação/edição/pagamento/agendamento/cancelamento) — nunca
 * confiar em um status enviado pelo cliente.
 */
export function computeStoredStatus(params: {
  originalAmountCents: number;
  paidAmountCents: number;
  canceled: boolean;
  hasPendingSchedule: boolean;
}): StoredStatus {
  if (params.canceled) return "canceled";
  if (params.paidAmountCents >= params.originalAmountCents && params.originalAmountCents > 0) {
    return "paid";
  }
  if (params.paidAmountCents > 0) return "partially_paid";
  if (params.hasPendingSchedule) return "scheduled";
  return "open";
}

/**
 * Status de EXIBIÇÃO — cruza o status armazenado com a data de vencimento
 * e "hoje". Uma conta parcialmente paga e vencida continua indicando saldo
 * vencido (a precedência do requisito): overdue/due_today/upcoming só se
 * aplicam quando ainda há saldo em aberto.
 */
export function computeDisplayStatus(params: {
  storedStatus: StoredStatus;
  dueDate: string;
  today?: string;
}): DisplayStatus {
  const { storedStatus, dueDate } = params;
  const today = params.today ?? todayInTimezone();
  if (storedStatus === "canceled") return "canceled";
  if (storedStatus === "paid") return "paid";

  const hasOpenBalance = storedStatus === "open" || storedStatus === "partially_paid" || storedStatus === "scheduled";
  if (hasOpenBalance) {
    if (dueDate < today) return "overdue";
    if (dueDate === today) return "due_today";
  }
  if (storedStatus === "partially_paid") return "partially_paid";
  if (storedStatus === "scheduled") return "scheduled";
  return "upcoming";
}

export const DISPLAY_STATUS_LABELS: Record<DisplayStatus, string> = {
  upcoming: "A VENCER",
  due_today: "VENCENDO HOJE",
  overdue: "VENCIDO",
  partially_paid: "PARCIALMENTE PAGO",
  paid: "PAGO",
  scheduled: "AGENDADO",
  canceled: "CANCELADO",
};

export type QuickView =
  | "today"
  | "tomorrow"
  | "week"
  | "next7"
  | "next30"
  | "month"
  | "year"
  | "overdue"
  | "paid"
  | "open_suppliers";

export function addDays(dateText: string, days: number): string {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export type DashboardPeriod = "day" | "week" | "month" | "year";

/**
 * Intervalo [from, to] (inclusive, YYYY-MM-DD) pro filtro de período do
 * Dashboard Geral do Financeiro (Dia/Semana/Mês/Ano) — parecido com
 * quickViewDueRange, mas ancorado numa data ESCOLHIDA pelo usuário (não
 * necessariamente "hoje"), então mantido como função separada em vez de
 * generalizar quickViewDueRange (que é sempre relativo a "hoje" por
 * definição dos atalhos de Contas a Pagar).
 */
export function periodDueRange(period: DashboardPeriod, referenceDate: string): { from: string; to: string } {
  switch (period) {
    case "day":
      return { from: referenceDate, to: referenceDate };
    case "week": {
      const [year, month, day] = referenceDate.split("-").map(Number);
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      const startOffset = weekday === 0 ? -6 : 1 - weekday;
      const start = addDays(referenceDate, startOffset);
      const end = addDays(start, 6);
      return { from: start, to: end };
    }
    case "year":
      return { from: `${referenceDate.slice(0, 4)}-01-01`, to: `${referenceDate.slice(0, 4)}-12-31` };
    case "month":
    default: {
      const [year, month] = referenceDate.split("-").map(Number);
      const start = `${referenceDate.slice(0, 7)}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end = `${referenceDate.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
      return { from: start, to: end };
    }
  }
}

/**
 * Intervalo de vencimento [from, to] (inclusive, YYYY-MM-DD) para cada
 * atalho de visualização rápida — definido em UM lugar só pra evitar
 * ambiguidade/duplicidade entre front e back.
 */
export function quickViewDueRange(view: QuickView, today: string): { from: string; to: string } | null {
  switch (view) {
    case "today":
      return { from: today, to: today };
    case "tomorrow": {
      const tomorrow = addDays(today, 1);
      return { from: tomorrow, to: tomorrow };
    }
    case "week": {
      const [year, month, day] = today.split("-").map(Number);
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      const startOffset = weekday === 0 ? -6 : 1 - weekday;
      const start = addDays(today, startOffset);
      const end = addDays(start, 6);
      return { from: start, to: end };
    }
    case "next7":
      return { from: today, to: addDays(today, 7) };
    case "next30":
      return { from: today, to: addDays(today, 30) };
    case "month": {
      const [year, month] = today.split("-").map(Number);
      const start = `${today.slice(0, 7)}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const end = `${today.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
      return { from: start, to: end };
    }
    case "year":
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    case "overdue":
    case "paid":
    case "open_suppliers":
      return null;
    default:
      return null;
  }
}
