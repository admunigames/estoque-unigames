// Assistência > RMA — regras puras (sem banco) usadas pelas rotas, pela
// importação do Base44 e pelos testes. Listas iguais às do sistema RMA antigo
// (Base44), em CAIXA ALTA.

import { recifeDate } from "./ordens-servico";

export { recifeDate };

export const RMA_STATUSES = [
  "RECEBIDO",
  "PREPARANDO ENVIO DO PRODUTO AO FORNECEDOR",
  "ENVIADO AO FORNECEDOR",
  "AGUARDANDO RETORNO DO FORNECEDOR",
  "AGUARDANDO RETORNO NF",
  "CRÉDITO GERADO",
  "PRODUTO SUBSTITUÍDO",
  "DESCARTADO",
  "CANCELADO",
  "FINALIZADO",
] as const;
export const RMA_FINAL_STATUS = "FINALIZADO";
export const RMA_SUPPLIER_STATUSES = ["ENVIADO AO FORNECEDOR", "AGUARDANDO RETORNO DO FORNECEDOR", "AGUARDANDO RETORNO NF"];

export const RMA_PRIORITIES = ["BAIXA", "MÉDIA", "ALTA", "CRÍTICA"] as const;
export const RMA_HIGH_PRIORITIES = ["ALTA", "CRÍTICA"];

export const RMA_SOLUTION_TYPES = [
  "CRÉDITO GERADO",
  "PRODUTO SUBSTITUÍDO",
  "CONSERTO REALIZADO",
  "PRODUTO DESCARTADO",
  "PRODUTO DEVOLVIDO SEM SOLUÇÃO",
  "CANCELADO",
  "OUTRO",
] as const;

export const RMA_OS_SITUATIONS = ["COBERTURA DE GARANTIA", "PRODUTO DE VENDA"];

// Sugestões (os campos aceitam texto livre).
export const RMA_DEFECT_TYPES = ["NÃO LIGA", "TELA QUEBRADA", "BATERIA", "PROBLEMA DE SOFTWARE", "CONECTOR DANIFICADO", "DANIFICADO NO TRANSPORTE", "DEFEITO DE FÁBRICA", "OUTRO"];
export const RMA_PRODUCT_CATEGORIES = ["SMARTPHONES", "NOTEBOOKS", "TABLETS", "ACESSÓRIOS", "PERIFÉRICOS", "GAMES", "OUTROS"];
export const RMA_DISPOSAL_REASONS = ["PRODUTO SEM CONSERTO", "PRODUTO SEM GARANTIA", "CUSTO DE REPARO INVIÁVEL", "PRODUTO DANIFICADO NO TRANSPORTE", "PRODUTO SEM RETORNO DO FORNECEDOR", "PRODUTO OBSOLETO", "OUTRO"];
export const RMA_CREDIT_STATUSES = ["DISPONÍVEL", "PARCIALMENTE UTILIZADO", "UTILIZADO EM COMPRA", "ABATIDO EM BOLETO", "CANCELADO"];
export const RMA_CREDIT_USAGES = ["ABATIDO EM NF", "ABATIDO EM BOLETO", "UTILIZADO EM NOVA COMPRA", "CRÉDITO PARCIAL", "CANCELADO", "OUTRO"];

// Alertas do sistema antigo: sem atualização há mais de 7 dias; O.S. vencida
// ou vencendo em até 5 dias.
export const RMA_STALE_DAYS = 7;
export const RMA_OS_WARNING_DAYS = 5;

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

export type RmaAlertInput = {
  finalized: number;
  status: string;
  priority: string;
  osDeadline: string;
  lastUpdateAt: string;
  createdAt: string;
  nextUpdateDate: string;
};

export type RmaAlerts = {
  daysWithoutUpdate: number | null;
  stale: boolean;
  osLevel: "" | "vencida" | "vence_em_breve";
  osDays: number | null;
  highPriority: boolean;
  awaitingSupplier: boolean;
  nextUpdateLate: boolean;
};

/** Alertas de um RMA no dia `today` (YYYY-MM-DD, America/Recife). Finalizado não alerta. */
export function rmaAlerts(rma: RmaAlertInput, today: string): RmaAlerts {
  const open = !rma.finalized && rma.status !== "CANCELADO";
  const last = recifeDate(rma.lastUpdateAt || rma.createdAt);
  const daysWithoutUpdate = DATE_PATTERN.test(last) ? dayNumber(today) - dayNumber(last) : null;
  const osDays = DATE_PATTERN.test(rma.osDeadline) ? dayNumber(rma.osDeadline) - dayNumber(today) : null;
  return {
    daysWithoutUpdate,
    stale: open && daysWithoutUpdate !== null && daysWithoutUpdate > RMA_STALE_DAYS,
    osLevel: !open || osDays === null ? "" : osDays < 0 ? "vencida" : osDays <= RMA_OS_WARNING_DAYS ? "vence_em_breve" : "",
    osDays,
    highPriority: open && RMA_HIGH_PRIORITIES.includes(rma.priority),
    awaitingSupplier: open && RMA_SUPPLIER_STATUSES.includes(rma.status),
    nextUpdateLate: open && DATE_PATTERN.test(rma.nextUpdateDate) && rma.nextUpdateDate < today,
  };
}

/** Código novo no padrão do sistema antigo: RMA-XXXXXX (6 hexadecimais). */
export function newRmaCode() {
  return `RMA-${crypto.randomUUID().replace(/-/g, "").slice(-6).toUpperCase()}`;
}

/** "1.234,56" / "1234.56" / 1234.56 → centavos; inválido → null. */
export function parseMoneyCents(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
  const text = String(value ?? "").trim().replace(/^R\$\s*/i, "");
  if (!text) return null;
  const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) : null;
}
