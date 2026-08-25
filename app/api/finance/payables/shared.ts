import type { getD1 } from "../../../../db";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR, type ScopeActor } from "../../../lib/access-scope";
import { DISPLAY_STATUS_LABELS, computeDisplayStatus, type StoredStatus } from "../../../lib/finance-status";
import {
  DATE_PATTERN,
  RECURRENCE_FREQUENCIES,
  competenceMonthOf,
  displayStatusCaseSql,
  generateInstallmentDueDates,
  generateRecurrenceDueDates,
  nextRecurrenceDueDate,
  recalcPayableEntrySql,
  splitIntoInstallments,
  type RecurrenceFrequency,
} from "../../../lib/payables-recurrence";
import { MONTH_PATTERN } from "../shared";

export {
  DATE_PATTERN,
  RECURRENCE_FREQUENCIES,
  competenceMonthOf,
  displayStatusCaseSql,
  generateInstallmentDueDates,
  generateRecurrenceDueDates,
  nextRecurrenceDueDate,
  recalcPayableEntrySql,
  splitIntoInstallments,
  type RecurrenceFrequency,
};

export type PayableRow = {
  id: string;
  companyId: string;
  companyName: string;
  description: string;
  supplierId: string;
  financeItemId: string;
  financeAccountId: string;
  originalAmountCents: number;
  paidAmountCents: number;
  issueDate: string;
  competenceMonth: string;
  dueDate: string;
  paymentMethod: string;
  invoiceNumber: string;
  orderReference: string;
  billingCode: string;
  notes: string;
  status: StoredStatus;
  recurrenceId: string | null;
  recurrenceFrequency: string;
  installmentGroupId: string | null;
  installmentNumber: number;
  installmentTotal: number;
  expenseId: string | null;
  costCenter: string;
  createdAt: string;
  updatedAt: string;
};

export async function loadPayable(
  database: Awaited<ReturnType<typeof getD1>>,
  id: string,
): Promise<PayableRow | null> {
  return database
    .prepare(
      `SELECT id, company_id AS companyId, company_name AS companyName, description,
              supplier_id AS supplierId, finance_item_id AS financeItemId, finance_account_id AS financeAccountId,
              original_amount_cents AS originalAmountCents, paid_amount_cents AS paidAmountCents,
              issue_date AS issueDate, competence_month AS competenceMonth, due_date AS dueDate,
              payment_method AS paymentMethod, invoice_number AS invoiceNumber, order_reference AS orderReference,
              billing_code AS billingCode, notes, status,
              recurrence_id AS recurrenceId, recurrence_frequency AS recurrenceFrequency,
              installment_group_id AS installmentGroupId, installment_number AS installmentNumber,
              installment_total AS installmentTotal, expense_id AS expenseId, cost_center AS costCenter,
              created_at AS createdAt, updated_at AS updatedAt
       FROM accounts_payable WHERE id=?1`,
    )
    .bind(id)
    .first<PayableRow>();
}

/** Isolamento por loja: null se liberado, mensagem de erro (pra responder 403) caso contrário. */
export function assertAccess(scopeActor: ScopeActor, payable: PayableRow): string | null {
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (allStores) return null;
  if (!hasCompany(scopeActor.companyId)) return NO_COMPANY_ERROR;
  if (payable.companyId !== scopeActor.companyId) return "VOCÊ NÃO TEM ACESSO A ESSA CONTA.";
  return null;
}

export { MONTH_PATTERN };

type SlotRow = { id: string; source: string };

/**
 * Confirma que uma célula loja+item+mês pode receber lançamentos vindos de
 * contas a pagar — ou seja, que não é uma célula digitada manualmente na
 * tela de DRE. Retorna uma mensagem de erro (para responder 409) ou null se
 * estiver livre.
 */
export async function assertSlotAvailableForPayable(
  database: Awaited<ReturnType<typeof getD1>>,
  storeId: string,
  itemId: string,
  month: string,
): Promise<string | null> {
  const existing = await database
    .prepare(
      "SELECT id, source FROM finance_store_entries WHERE store_id=?1 AND item_id=?2 AND month=?3",
    )
    .bind(storeId, itemId, month)
    .first<SlotRow>();
  if (existing && existing.source === "manual") {
    return `JÁ EXISTE UM LANÇAMENTO MANUAL PARA ESSE ITEM NESSA LOJA/MÊS (${month}) NA TELA DE DRE — REMOVA-O OU ESCOLHA OUTRO ITEM/COMPETÊNCIA ANTES DE VINCULAR A CONTA A PAGAR.`;
  }
  return null;
}

/**
 * Confirma que a conta financeira selecionada é da MESMA empresa/loja da
 * conta a pagar (ou global — company_id='' — pra registros antigos de
 * antes da migration 0029) e está ativa. Nunca confia só no que o
 * frontend já filtrou. Retorna mensagem de erro (409) ou null se ok.
 */
export async function assertFinanceAccountBelongsToCompany(
  database: Awaited<ReturnType<typeof getD1>>,
  financeAccountId: string,
  companyId: string,
): Promise<string | null> {
  if (!financeAccountId) return null;
  const account = await database
    .prepare("SELECT company_id AS companyId, active FROM finance_accounts WHERE id=?1")
    .bind(financeAccountId)
    .first<{ companyId: string; active: number }>();
  if (!account) return "CONTA FINANCEIRA NÃO ENCONTRADA.";
  if (account.companyId && account.companyId !== companyId) {
    return "ESSA CONTA FINANCEIRA PERTENCE A OUTRA EMPRESA/LOJA.";
  }
  if (!account.active) {
    return "ESSA CONTA FINANCEIRA ESTÁ INATIVA E NÃO PODE SER USADA EM NOVOS LANÇAMENTOS.";
  }
  return null;
}

export type PayableStatusView = {
  storedStatus: StoredStatus;
  displayStatus: string;
  displayStatusLabel: string;
};

export function statusView(storedStatus: StoredStatus, dueDate: string, today: string): PayableStatusView {
  const displayStatus = computeDisplayStatus({ storedStatus, dueDate, today });
  return { storedStatus, displayStatus, displayStatusLabel: DISPLAY_STATUS_LABELS[displayStatus] };
}
