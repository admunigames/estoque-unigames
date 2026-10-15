// Assistência > Ordens de Serviço — regras puras (sem banco) usadas pela rota
// e pelos testes: listas da planilha UNITEC, criticidade da data limite e a
// ordem da lista (mais crítica primeiro).

export const OS_CATEGORIES = ["CONSOLE", "INFORMÁTICA", "CONTROLE", "CELULAR", "TERCEIRIZADO"] as const;

// Coluna STATUS da planilha + PRODUÇÃO, reprovações e APROVADA (decisão do
// usuário, 14/10/2026). APROVADA pede SEGUE PARA A LOJA: "nao" finaliza na
// hora; "sim" espera o teste da loja (aprovada = finaliza; reprovada = volta
// para a assistência como REPROVADO EM LOJA).
export const OS_STATUSES = [
  "ORÇAMENTO PENDENTE",
  "PASSADO ORÇAMENTO",
  "AUTORIZADA",
  "NÃO AUTORIZADO",
  "PRODUÇÃO",
  "PREVENTIVA",
  "SETOR QUALIDADE",
  "SEM SOLUÇÃO",
  "REPROVADO NA ASSISTÊNCIA",
  "REPROVADO EM LOJA",
  "APROVADA",
] as const;
export const OS_APPROVED_STATUS = "APROVADA";
export const OS_STORE_REJECTED_STATUS = "REPROVADO EM LOJA";

export type ShipToStore = "" | "sim" | "nao";
export type StoreCheck = "" | "pendente" | "aprovada" | "reprovada";

/**
 * Situação depois de salvar pela assistência: fechada ou não e o teste da loja.
 * APROVADA + não segue → fecha; APROVADA + segue → aguarda a loja (se a loja
 * já aprovou, continua fechada). Outro status: aberta; "pendente" é desfeito
 * (a O.S. voltou para a assistência) e "reprovada" fica para mostrar quem reprovou.
 */
export function approvalState(status: string, ship: ShipToStore, previousCheck: StoreCheck): { closed: 0 | 1; storeCheck: StoreCheck } {
  if (status === OS_APPROVED_STATUS) {
    if (ship === "nao") return { closed: 1, storeCheck: "" };
    return previousCheck === "aprovada" ? { closed: 1, storeCheck: "aprovada" } : { closed: 0, storeCheck: "pendente" };
  }
  return { closed: 0, storeCheck: previousCheck === "pendente" || previousCheck === "aprovada" ? "" : previousCheck };
}

// Sugestões da coluna OBSERVAÇÕES (o campo aceita texto livre). Garantia e
// venda saíram do STATUS (15/10/2026); "NO PRAZO" deixou de existir: a data
// limite já diz se está no prazo ou atrasada.
export const OS_SITUATIONS = [
  "GARANTIA DE VENDA",
  "GARANTIA DE SERVIÇO",
  "DE VENDA",
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
