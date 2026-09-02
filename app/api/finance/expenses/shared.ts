import type { getD1 } from "../../../../db";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR, type ScopeActor } from "../../../lib/access-scope";
import {
  DATE_PATTERN,
  RECURRENCE_FREQUENCIES,
  competenceMonthOf,
  computeDreAnchorAssignments,
  effectiveDreAmountCents,
  generateInstallmentDueDates,
  generateRecurrenceDueDates,
  isDreIncluded,
  prorateDreAmountByShare,
  recalcPayableEntrySql,
  splitIntoInstallments,
  type RecurrenceFrequency,
} from "../../../lib/payables-recurrence";
import { assertFinanceAccountBelongsToCompany, assertSlotAvailableForPayable } from "../payables/shared";
import { MONTH_PATTERN } from "../shared";

export {
  DATE_PATTERN,
  RECURRENCE_FREQUENCIES,
  MONTH_PATTERN,
  assertFinanceAccountBelongsToCompany,
  assertSlotAvailableForPayable,
  competenceMonthOf,
  computeDreAnchorAssignments,
  effectiveDreAmountCents,
  generateInstallmentDueDates,
  generateRecurrenceDueDates,
  isDreIncluded,
  prorateDreAmountByShare,
  recalcPayableEntrySql,
  splitIntoInstallments,
  type RecurrenceFrequency,
};

// 'single_store' (pertence só a uma loja) | 'rateio' (dividida entre lojas —
// modelo de cálculo implementado numa etapa seguinte) | 'no_rateio' (nunca
// entra em rateio).
export const RATEIO_TYPES = ["single_store", "rateio", "no_rateio"] as const;
export type RateioType = (typeof RATEIO_TYPES)[number];

export { RATEIO_MODELS, REVENUE_RATEIO_MODELS, type RateioModel } from "../../../lib/rateio-models";

export type ExpenseRow = {
  id: string;
  companyId: string;
  companyName: string;
  description: string;
  supplierId: string;
  financeItemId: string;
  financeAccountId: string;
  costCenter: string;
  costCenterId: string | null;
  originalAmountCents: number;
  issueDate: string;
  competenceMonth: string;
  dueDate: string;
  paymentMethod: string;
  invoiceNumber: string;
  orderReference: string;
  notes: string;
  kind: string;
  installmentTotal: number;
  recurrenceFrequency: string;
  recurrenceOccurrenceCount: number | null;
  recurrenceEndDate: string;
  rateioType: string;
  rateioModel: string;
  cardId: string;
  bankReconciliationId: string;
  createdAt: string;
  updatedAt: string;
};

export const EXPENSE_SELECT_COLUMNS = `id, company_id AS companyId, company_name AS companyName, description,
  supplier_id AS supplierId, finance_item_id AS financeItemId, finance_account_id AS financeAccountId,
  cost_center AS costCenter, cost_center_id AS costCenterId, original_amount_cents AS originalAmountCents,
  issue_date AS issueDate, competence_month AS competenceMonth, due_date AS dueDate,
  payment_method AS paymentMethod, invoice_number AS invoiceNumber, order_reference AS orderReference,
  notes, kind, installment_total AS installmentTotal,
  recurrence_frequency AS recurrenceFrequency, recurrence_occurrence_count AS recurrenceOccurrenceCount,
  recurrence_end_date AS recurrenceEndDate, rateio_type AS rateioType, rateio_model AS rateioModel,
  card_id AS cardId, bank_reconciliation_id AS bankReconciliationId,
  created_at AS createdAt, updated_at AS updatedAt`;

export async function loadExpense(
  database: Awaited<ReturnType<typeof getD1>>,
  id: string,
): Promise<ExpenseRow | null> {
  return database
    .prepare(`SELECT ${EXPENSE_SELECT_COLUMNS} FROM expenses WHERE id=?1`)
    .bind(id)
    .first<ExpenseRow>();
}

/** Isolamento por loja: null se liberado, mensagem de erro (pra responder 403) caso contrário. */
export function assertExpenseAccess(scopeActor: ScopeActor, expense: ExpenseRow): string | null {
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (allStores) return null;
  if (!hasCompany(scopeActor.companyId)) return NO_COMPANY_ERROR;
  if (expense.companyId !== scopeActor.companyId) return "VOCÊ NÃO TEM ACESSO A ESSA DESPESA.";
  return null;
}
