import { getD1 } from "../../../../db";
import { type ScopeActor, canSeeAllStores } from "../../../lib/access-scope";
import { DATE_PATTERN } from "../../../lib/payables-recurrence";
import { safeText, type JsonMap } from "../shared";

export type Database = Awaited<ReturnType<typeof getD1>>;

export type ReceivableRow = {
  id: string;
  companyId: string;
  companyName: string;
  operatorText: string;
  acquirerId: string;
  competenceMonth: string;
  expectedDate: string;
  expectedAmountCents: number;
  receivedAmountCents: number | null;
  receivedDate: string;
  notes: string;
  canceled: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
  canceledBy: string;
  canceledByName: string;
  canceledAt: string;
};

export const RECEIVABLE_COLUMNS = `id, company_id AS companyId, company_name AS companyName,
  operator_text AS operatorText, acquirer_id AS acquirerId,
  competence_month AS competenceMonth, expected_date AS expectedDate,
  expected_amount_cents AS expectedAmountCents, received_amount_cents AS receivedAmountCents,
  received_date AS receivedDate, notes, canceled,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt,
  canceled_by AS canceledBy, canceled_by_name AS canceledByName, canceled_at AS canceledAt`;

export async function loadReceivable(database: Database, id: string) {
  return await database
    .prepare(`SELECT ${RECEIVABLE_COLUMNS} FROM accounts_receivable WHERE id=?1 LIMIT 1`)
    .bind(id)
    .first<ReceivableRow>();
}

/**
 * Mesmo contrato de assertAccess() de payables/shared.ts: quem não enxerga
 * todas as lojas só age sobre recebíveis da própria loja.
 */
export function assertReceivableAccess(actor: ScopeActor, row: { companyId: string }): string | null {
  if (canSeeAllStores(actor, "finance:manage")) return null;
  if (row.companyId && row.companyId === actor.companyId) return null;
  return "VOCÊ NÃO TEM ACESSO A ESSE RECEBÍVEL.";
}

/**
 * Interpreta o par valor/data recebidos vindo do corpo da requisição.
 * receivedAmountCents ausente/null/'' = ainda pendente (grava NULL); qualquer
 * número, INCLUSIVE 0, = recebido — e nesse caso a data do recebimento passa
 * a ser obrigatória, senão o Fluxo de Caixa não teria em que dia lançar a
 * entrada.
 */
export function parseReceived(body: JsonMap): {
  receivedAmountCents: number | null;
  receivedDate: string;
  error?: string;
} {
  const raw = body.receivedAmountCents;
  const receivedDate = safeText(body.receivedDate, 10);
  if (raw === null || raw === undefined || raw === "") {
    return { receivedAmountCents: null, receivedDate: "" };
  }
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { receivedAmountCents: null, receivedDate: "", error: "INFORME UM VALOR RECEBIDO VÁLIDO." };
  }
  if (!DATE_PATTERN.test(receivedDate)) {
    return { receivedAmountCents: null, receivedDate: "", error: "INFORME A DATA DO RECEBIMENTO." };
  }
  return { receivedAmountCents: parsed, receivedDate };
}

/**
 * Resolve a "operadora" de um recebível a partir do corpo da requisição.
 * Fase 7: se vier `acquirerId`, valida contra o cadastro de finance_acquirers
 * (adquirente global '' ou da mesma loja) e usa o nome dela como
 * operator_text (snapshot — os índices/agrupamentos continuam por texto).
 * Sem acquirerId, aceita `operatorText` livre (compatibilidade com clientes
 * antigos e com o histórico anterior ao cadastro).
 */
export async function resolveReceivableOperator(
  database: Database,
  body: JsonMap,
  companyId: string,
): Promise<{ acquirerId: string; operatorText: string; error?: string }> {
  const acquirerId = safeText(body.acquirerId, 80);
  if (acquirerId) {
    const acquirer = await database
      .prepare("SELECT name, company_id AS companyId, status FROM finance_acquirers WHERE id=?1")
      .bind(acquirerId)
      .first<{ name: string; companyId: string; status: string }>();
    if (!acquirer) return { acquirerId: "", operatorText: "", error: "ADQUIRENTE NÃO ENCONTRADA." };
    if (acquirer.companyId && acquirer.companyId !== companyId) {
      return { acquirerId: "", operatorText: "", error: "ESSA ADQUIRENTE É DE OUTRA UNIDADE." };
    }
    return { acquirerId, operatorText: acquirer.name };
  }
  const operatorText = safeText(body.operatorText, 120);
  if (!operatorText) return { acquirerId: "", operatorText: "", error: "INFORME A OPERADORA." };
  return { acquirerId: "", operatorText };
}
