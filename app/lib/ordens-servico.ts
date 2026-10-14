// Assistência > Ordens de Serviço — regras puras (sem banco) usadas pela rota
// e pelos testes: listas da planilha UNITEC, criticidade da data limite e a
// ordem da lista (mais crítica primeiro).

export const OS_CATEGORIES = ["CONSOLE", "INFORMÁTICA", "CONTROLE", "CELULAR", "TERCEIRIZADO"] as const;

// Coluna STATUS da planilha + FINALIZADA (tira a O.S. da lista de abertas).
export const OS_STATUSES = [
  "ORÇAMENTO PENDENTE",
  "PASSADO ORÇAMENTO",
  "AUTORIZADA",
  "GARANTIA DE SERVIÇO",
  "GARANTIA DE VENDA",
  "DE VENDA",
  "FINALIZADA",
] as const;
export const OS_CLOSED_STATUS = "FINALIZADA";

// Sugestões da coluna OBSERVAÇÕES (o campo aceita texto livre).
export const OS_SITUATIONS = [
  "NO PRAZO",
  "AGUARDANDO ORÇAMENTO",
  "AGUARDANDO AUTORIZAÇÃO",
  "CLIENTE AGUARDANDO ORÇAMENTO",
  "AGUARDANDO PEÇA",
  "REPROVADO",
];

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type DeadlineLevel = "atrasada" | "hoje" | "proxima" | "no_prazo" | "sem_data";

function dayNumber(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/** Dias até a data limite (negativo = vencida) e o nível de criticidade. */
export function deadlineInfo(deadline: string, today: string): { days: number | null; level: DeadlineLevel } {
  if (!DATE_PATTERN.test(deadline)) return { days: null, level: "sem_data" };
  const days = dayNumber(deadline) - dayNumber(today);
  if (days < 0) return { days, level: "atrasada" };
  if (days === 0) return { days, level: "hoje" };
  if (days <= 2) return { days, level: "proxima" };
  return { days, level: "no_prazo" };
}

/** Data (YYYY-MM-DD) em America/Recife de um instante ISO. */
export function recifeDate(iso: string | Date = new Date()): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Recife", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

type Sortable = { closed: number; deadline: string; osNumber: string; closedAt?: string };

/**
 * Abertas antes das finalizadas; entre as abertas, a data limite mais antiga
 * (mais vencida) primeiro e as sem data no fim; empate pelo número da O.S.
 * Finalizadas: a mais recente primeiro.
 */
export function compareOrders(a: Sortable, b: Sortable): number {
  if (a.closed !== b.closed) return a.closed ? 1 : -1;
  if (a.closed) return String(b.closedAt || "").localeCompare(String(a.closedAt || ""));
  const aHas = DATE_PATTERN.test(a.deadline);
  const bHas = DATE_PATTERN.test(b.deadline);
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aHas && a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
  return a.osNumber.localeCompare(b.osNumber, "pt-BR", { numeric: true });
}
