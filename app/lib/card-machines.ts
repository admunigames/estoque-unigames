// Lógica pura das Maquinetas (Financeiro Fase 7). Sem I/O: só as regras de
// "o que um evento do histórico faz com o estado da maquineta" e a
// normalização/validação dos campos de cadastro. As rotas
// (app/api/finance/card-machines/*) chamam estas funções e fazem o SQL.

export const MACHINE_STATUSES = ["active", "inactive", "transferred", "canceled"] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

export const MACHINE_EVENT_KINDS = [
  "transfer",
  "maintenance",
  "replacement",
  "cancellation",
] as const;
export type MachineEventKind = (typeof MACHINE_EVENT_KINDS)[number];

export function isMachineStatus(value: unknown): value is MachineStatus {
  return typeof value === "string" && (MACHINE_STATUSES as readonly string[]).includes(value);
}

export function isMachineEventKind(value: unknown): value is MachineEventKind {
  return typeof value === "string" && (MACHINE_EVENT_KINDS as readonly string[]).includes(value);
}

export type MachineState = {
  companyId: string;
  companyName: string;
  status: MachineStatus;
};

export type MachineEventInput = {
  kind: MachineEventKind;
  toCompanyId?: string;
  toCompanyName?: string;
};

/**
 * Aplica um evento do histórico ao estado da maquineta e devolve o novo
 * estado. Regras:
 * - transfer: move a maquineta para a loja de destino; volta a ficar
 *   'active' (uma maquineta transferida está operante na nova loja). Exige
 *   loja de destino diferente da atual.
 * - cancellation: status vira 'canceled' (fim de vida do equipamento).
 * - maintenance / replacement: não mudam loja nem status — são só registro
 *   histórico (a maquineta continua no mesmo lugar, eventualmente 'inactive'
 *   enquanto está na assistência, mas isso é decisão manual no cadastro, não
 *   automática).
 */
export function applyMachineEvent(
  current: MachineState,
  event: MachineEventInput,
): { state: MachineState; error?: string } {
  if (event.kind === "transfer") {
    const toCompanyId = (event.toCompanyId ?? "").trim();
    if (!toCompanyId) {
      return { state: current, error: "INFORME A LOJA DE DESTINO DA TRANSFERÊNCIA." };
    }
    if (toCompanyId === current.companyId) {
      return { state: current, error: "A LOJA DE DESTINO É A MESMA LOJA ATUAL DA MAQUINETA." };
    }
    return {
      state: {
        companyId: toCompanyId,
        companyName: (event.toCompanyName ?? "").trim(),
        status: "active",
      },
    };
  }
  if (event.kind === "cancellation") {
    return { state: { ...current, status: "canceled" } };
  }
  // maintenance | replacement
  return { state: current };
}

export function normalizeSerial(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase().slice(0, 60) : "";
}

/**
 * Validação dos campos obrigatórios do cadastro. `installedAt`, quando
 * informado, tem que ser uma data ISO (YYYY-MM-DD).
 */
export function validateMachineDraft(draft: {
  acquirerId: string;
  companyId: string;
  installedAt: string;
}): string | null {
  if (!draft.acquirerId) return "SELECIONE A ADQUIRENTE.";
  if (!draft.companyId) return "SELECIONE A UNIDADE.";
  if (draft.installedAt && !/^\d{4}-\d{2}-\d{2}$/.test(draft.installedAt)) {
    return "DATA DE INSTALAÇÃO INVÁLIDA.";
  }
  return null;
}
