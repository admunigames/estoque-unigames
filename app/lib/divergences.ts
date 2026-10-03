// Divergências de estoque — regras puras do módulo (sem banco), usadas
// pelas rotas em app/api/divergences/** e pelos testes. A loja abre um
// PEDIDO com 1+ itens (físico x sistema); o estoque responde item a item.
// O status do pedido é sempre DERIVADO dos itens (a cópia gravada em
// divergence_requests.status só existe para listar/filtrar e é recalculada
// na mesma transação de qualquer mudança de item).

import { todayInTimezone } from "./finance-status";

export const ITEM_STATUSES = [
  "nao_visto",
  "em_verificacao",
  "verificacao_loja",
  "concluido",
  "inventario",
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const REQUEST_STATUSES = ["aberto", "verificacao", "finalizado"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  nao_visto: "NÃO VISTO",
  em_verificacao: "EM VERIFICAÇÃO",
  verificacao_loja: "VERIFICAÇÃO DA LOJA",
  concluido: "CONCLUÍDO",
  inventario: "ANOTADO PARA INVENTÁRIO",
};

export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  aberto: "EM ABERTO",
  verificacao: "EM VERIFICAÇÃO",
  finalizado: "FINALIZADO",
};

/** Status que o estoque pode atribuir ao responder um item. */
export const RESPOND_STATUSES: readonly ItemStatus[] = [
  "em_verificacao",
  "verificacao_loja",
  "concluido",
  "inventario",
];

/** Itens nesses status contam como resolvidos para finalizar o pedido. */
export const RESOLVED_ITEM_STATUSES: readonly ItemStatus[] = ["concluido", "inventario"];

/** Item em NÃO VISTO há mais que isso (dias corridos, fuso Recife) gera alerta. */
export const OVERDUE_DAYS = 14;

export function isItemStatus(value: unknown): value is ItemStatus {
  return typeof value === "string" && (ITEM_STATUSES as readonly string[]).includes(value);
}

export function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === "string" && (REQUEST_STATUSES as readonly string[]).includes(value);
}

/**
 * EM ABERTO: todos os itens em NÃO VISTO (ou pedido sem itens);
 * FINALIZADO: todos em CONCLUÍDO ou ANOTADO PARA INVENTÁRIO;
 * EM VERIFICAÇÃO: qualquer outro caso.
 */
export function computeRequestStatus(itemStatuses: readonly string[]): RequestStatus {
  if (itemStatuses.every((status) => status === "nao_visto")) return "aberto";
  if (itemStatuses.every((status) => (RESOLVED_ITEM_STATUSES as readonly string[]).includes(status))) {
    return "finalizado";
  }
  return "verificacao";
}

/** DIVERGÊNCIA = FÍSICO − SISTEMA (nunca gravada). */
export function divergenceOf(physicalQty: number, systemQty: number): number {
  return (Number(physicalQty) || 0) - (Number(systemQty) || 0);
}

function twoDigits(value: number) {
  return String(Math.abs(value)).padStart(2, "0");
}

/** "01 A MENOS FISICAMENTE" / "02 A MAIS FISICAMENTE" / "SEM DIVERGÊNCIA". */
export function divergenceLabel(physicalQty: number, systemQty: number): string {
  const diff = divergenceOf(physicalQty, systemQty);
  if (diff === 0) return "SEM DIVERGÊNCIA";
  return `${twoDigits(diff)} ${diff < 0 ? "A MENOS" : "A MAIS"} FISICAMENTE`;
}

// America/Recife é UTC-3 fixo (sem horário de verão desde 2019 — ver a
// nota de TIMEZONE em finance-status.ts). Os timestamps do módulo são ISO
// UTC, então o início de um dia de Recife é 03:00Z do mesmo dia.
const RECIFE_OFFSET_HOURS = 3;

/** Início (inclusivo) do dia YYYY-MM-DD de Recife, em ISO UTC. */
export function recifeDayStartIso(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, RECIFE_OFFSET_HOURS)).toISOString();
}

/** Início do dia SEGUINTE (limite exclusivo de um filtro "até"). */
export function recifeNextDayStartIso(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1, RECIFE_OFFSET_HOURS)).toISOString();
}

export function isDateOnly(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Data (YYYY-MM-DD) de Recife de um timestamp ISO/Postgres. */
export function recifeDateOf(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "";
  return todayInTimezone(parsed);
}

/** Dias corridos (calendário de Recife) entre a criação e hoje. */
export function daysSince(timestamp: string, now: Date = new Date()): number {
  const from = recifeDateOf(timestamp);
  if (!from) return 0;
  const to = todayInTimezone(now);
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Item em NÃO VISTO criado há MAIS de 14 dias. */
export function isOverdueUnseen(status: string, createdAt: string, now: Date = new Date()): boolean {
  return status === "nao_visto" && daysSince(createdAt, now) > OVERDUE_DAYS;
}

/** Chave para agrupar o mesmo produto entre pedidos/lojas. */
export function productKey(productCode: string, productName: string): string {
  const code = String(productCode || "").trim().toUpperCase();
  if (code) return `code:${code}`;
  return `name:${String(productName || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim()}`;
}
