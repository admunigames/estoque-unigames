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

export type RmaAlertDays = { staleDays: number; osWarningDays: number };
export const RMA_DEFAULT_ALERT_DAYS: RmaAlertDays = { staleDays: RMA_STALE_DAYS, osWarningDays: RMA_OS_WARNING_DAYS };

/** Alertas de um RMA no dia `today` (YYYY-MM-DD, America/Recife). Finalizado não alerta. */
export function rmaAlerts(rma: RmaAlertInput, today: string, days: RmaAlertDays = RMA_DEFAULT_ALERT_DAYS): RmaAlerts {
  const open = !rma.finalized && rma.status !== "CANCELADO";
  const last = recifeDate(rma.lastUpdateAt || rma.createdAt);
  const daysWithoutUpdate = DATE_PATTERN.test(last) ? dayNumber(today) - dayNumber(last) : null;
  const osDays = DATE_PATTERN.test(rma.osDeadline) ? dayNumber(rma.osDeadline) - dayNumber(today) : null;
  return {
    daysWithoutUpdate,
    stale: open && daysWithoutUpdate !== null && daysWithoutUpdate > days.staleDays,
    osLevel: !open || osDays === null ? "" : osDays < 0 ? "vencida" : osDays <= days.osWarningDays ? "vence_em_breve" : "",
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

// ---- Configurações (opções editáveis, tabela rma_options) ----
// Cada categoria vira uma lista em RMA > CONFIGURAÇÕES. Sem linhas no banco, a
// categoria usa os padrões abaixo. Renomear uma opção atualiza os registros
// que já usam o nome antigo (RMA_OPTION_COLUMNS).
export const RMA_OPTION_CATEGORIES = [
  { key: "rma_status", label: "STATUS DO RMA", defaults: [...RMA_STATUSES] },
  { key: "priority", label: "PRIORIDADES", defaults: [...RMA_PRIORITIES] },
  { key: "solution_type", label: "TIPOS DE SOLUÇÃO", defaults: [...RMA_SOLUTION_TYPES] },
  { key: "credit_status", label: "STATUS DO CRÉDITO", defaults: RMA_CREDIT_STATUSES },
  { key: "credit_usage", label: "FORMAS DE UTILIZAÇÃO DE CRÉDITO", defaults: RMA_CREDIT_USAGES },
  { key: "disposal_reason", label: "MOTIVOS DE DESCARTE", defaults: RMA_DISPOSAL_REASONS },
  { key: "product_category", label: "CATEGORIAS DE PRODUTO", defaults: RMA_PRODUCT_CATEGORIES },
  { key: "defect_type", label: "TIPOS DE DEFEITO", defaults: RMA_DEFECT_TYPES },
  { key: "os_situation", label: "SITUAÇÕES DA O.S.", defaults: RMA_OS_SITUATIONS },
  { key: "accessory_type", label: "TIPOS DE ACESSÓRIO", defaults: ["CAIXA", "CAPA", "CARREGADOR", "CABO", "FONE", "MANUAL", "NOTA FISCAL"] },
  { key: "alert_days", label: "PRAZOS DE ALERTA (DIAS)", defaults: ["SEM_ATUALIZACAO", "OS_VENCIMENTO"] },
] as const;
export type RmaOptionCategory = (typeof RMA_OPTION_CATEGORIES)[number]["key"];

export const RMA_OPTION_COLUMNS: Partial<Record<RmaOptionCategory, [table: string, column: string][]>> = {
  rma_status: [["rma_cases", "status"], ["rma_updates", "new_status"]],
  priority: [["rma_cases", "priority"]],
  solution_type: [["rma_cases", "solution_type"]],
  credit_status: [["rma_credits", "status"]],
  credit_usage: [["rma_credits", "usage_type"]],
  disposal_reason: [["rma_disposals", "reason"]],
  product_category: [["rma_cases", "product_category"], ["rma_disposals", "product_category"]],
  defect_type: [["rma_cases", "defect_type"]],
  os_situation: [["rma_cases", "os_situation"]],
};

// Usadas pelo código: não podem ser renomeadas, desativadas nem excluídas.
export const RMA_LOCKED_OPTIONS: Partial<Record<RmaOptionCategory, string[]>> = {
  rma_status: ["RECEBIDO", RMA_FINAL_STATUS, "CANCELADO"],
  alert_days: ["SEM_ATUALIZACAO", "OS_VENCIMENTO"],
};
export const RMA_ALERT_DAY_LABELS: Record<string, string> = {
  SEM_ATUALIZACAO: "ALERTA DE RMA SEM ATUALIZAÇÃO (DIAS)",
  OS_VENCIMENTO: "AVISO DE O.S. VENCENDO (DIAS ANTES DO PRAZO)",
};

export type RmaOption = { id: string; category: string; name: string; description: string; color: string; sortOrder: number; active: number };

/** Opções por categoria (banco ou padrões) e os prazos de alerta em vigor. */
export function resolveOptions(rows: RmaOption[]) {
  const options: Record<string, RmaOption[]> = {};
  for (const category of RMA_OPTION_CATEGORIES) {
    const saved = rows.filter((row) => row.category === category.key).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "pt-BR"));
    options[category.key] = saved.length
      ? saved
      : category.defaults.map((name, index) => ({
        id: "", category: category.key, name, color: "", sortOrder: index + 1, active: 1,
        description: category.key === "alert_days" ? String(name === "SEM_ATUALIZACAO" ? RMA_STALE_DAYS : RMA_OS_WARNING_DAYS) : "",
      }));
  }
  const day = (name: string, fallback: number) => {
    const value = Number(options.alert_days.find((option) => option.name === name)?.description);
    return Number.isInteger(value) && value >= 0 && value <= 365 ? value : fallback;
  };
  return { options, alertDays: { staleDays: day("SEM_ATUALIZACAO", RMA_STALE_DAYS), osWarningDays: day("OS_VENCIMENTO", RMA_OS_WARNING_DAYS) } };
}

/** Nome válido para a categoria: opção cadastrada (ativa, ou a atual do registro). */
export function isOption(options: Record<string, RmaOption[]>, category: RmaOptionCategory, name: string, current = "") {
  return (Boolean(current) && name === current) || options[category].some((option) => option.name === name && option.active);
}
