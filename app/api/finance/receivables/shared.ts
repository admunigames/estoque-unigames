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
  operator_text AS operatorText, competence_month AS competenceMonth, expected_date AS expectedDate,
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
