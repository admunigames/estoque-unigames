import type { getD1 } from "../../../../db";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR, type ScopeActor } from "../../../lib/access-scope";
import { DISPLAY_STATUS_LABELS, computeDisplayStatus, computeStoredStatus, type StoredStatus } from "../../../lib/finance-status";
import {
  DATE_PATTERN,
  RECURRENCE_FREQUENCIES,
  competenceMonthOf,
  computeDreAnchorAssignments,
  displayStatusCaseSql,
  effectiveDreAmountCents,
  generateInstallmentDueDates,
  generateRecurrenceDueDates,
  isDreIncluded,
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
  computeDreAnchorAssignments,
  displayStatusCaseSql,
  effectiveDreAmountCents,
  generateInstallmentDueDates,
  generateRecurrenceDueDates,
  isDreIncluded,
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
  dreAmountCents: number | null;
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
  costCenterId: string | null;
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
              dre_amount_cents AS dreAmountCents,
              issue_date AS issueDate, competence_month AS competenceMonth, due_date AS dueDate,
              payment_method AS paymentMethod, invoice_number AS invoiceNumber, order_reference AS orderReference,
              billing_code AS billingCode, notes, status,
              recurrence_id AS recurrenceId, recurrence_frequency AS recurrenceFrequency,
              installment_group_id AS installmentGroupId, installment_number AS installmentNumber,
              installment_total AS installmentTotal, expense_id AS expenseId, cost_center AS costCenter,
              cost_center_id AS costCenterId,
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

export type PayableGroupRow = {
  id: string;
  originalAmountCents: number;
  dreAmountCents: number | null;
  competenceMonth: string;
};

/**
 * Carrega, em ordem estável (âncora sempre primeiro), todas as linhas de
 * accounts_payable que formam o mesmo "conjunto lógico" de uma conta a
 * pagar avulsa/parcelada/recorrente pra fins da decisão de DRE — ver
 * computeDreAnchorAssignments. Um lançamento avulso sem grupo devolve só a
 * própria linha.
 */
export async function loadPayableGroupRows(
  database: Awaited<ReturnType<typeof getD1>>,
  payable: Pick<PayableRow, "id" | "installmentGroupId" | "recurrenceId">,
): Promise<PayableGroupRow[]> {
  if (payable.installmentGroupId) {
    const result = await database
      .prepare(
        `SELECT id, original_amount_cents AS originalAmountCents, dre_amount_cents AS dreAmountCents,
                competence_month AS competenceMonth
         FROM accounts_payable WHERE installment_group_id=?1
         ORDER BY installment_number ASC, created_at ASC, id ASC`,
      )
      .bind(payable.installmentGroupId)
      .all<PayableGroupRow>();
    return result.results ?? [];
  }
  if (payable.recurrenceId) {
    const result = await database
      .prepare(
        `SELECT id, original_amount_cents AS originalAmountCents, dre_amount_cents AS dreAmountCents,
                competence_month AS competenceMonth
         FROM accounts_payable WHERE recurrence_id=?1
         ORDER BY recurrence_occurrence_index ASC, created_at ASC, id ASC`,
      )
      .bind(payable.recurrenceId)
      .all<PayableGroupRow>();
    return result.results ?? [];
  }
  const result = await database
    .prepare(
      `SELECT id, original_amount_cents AS originalAmountCents, dre_amount_cents AS dreAmountCents,
              competence_month AS competenceMonth
       FROM accounts_payable WHERE id=?1`,
    )
    .bind(payable.id)
    .all<PayableGroupRow>();
  return result.results ?? [];
}

export type DreView = { included: boolean; amountCents: number; isCustomized: boolean };

/** Estado do toggle "Incluir na DRE?" pra exibição — derivado da linha âncora do grupo. */
export function dreViewFromGroup(group: PayableGroupRow[]): DreView {
  const anchor = group[0];
  if (!anchor) return { included: true, amountCents: 0, isCustomized: false };
  const totalOriginal = group.reduce((sum, row) => sum + row.originalAmountCents, 0);
  if (anchor.dreAmountCents === null || anchor.dreAmountCents === undefined) {
    return { included: true, amountCents: totalOriginal, isCustomized: false };
  }
  return { included: anchor.dreAmountCents > 0, amountCents: anchor.dreAmountCents, isCustomized: true };
}

/**
 * Valida e monta os SQL de UM pagamento (integral/parcial confirmado na hora,
 * ou agendado) de uma conta — sem executar. Usado pelo POST
 * payables/[id]/payments e pelo MARCAR COMO PAGO em lote do Fluxo de Caixa,
 * que junta vários numa transação. Pagamento nunca toca a DRE (já lançada
 * na criação): só paid_amount_cents e o status da conta.
 */
export async function planPayablePayment(
  database: Awaited<ReturnType<typeof getD1>>,
  payable: PayableRow,
  actor: { id: string; displayName: string },
  input: {
    idempotencyKey: string;
    amountCents: number;
    paymentDate: string;
    scheduled: boolean;
    paymentMethod: string;
    financeAccountId: string;
    notes: string;
  },
): Promise<{ error: string; status: number } | { paymentId: string; statements: [string, unknown[]][] }> {
  if (payable.status === "canceled") return { error: "ESTA CONTA ESTÁ CANCELADA.", status: 409 };
  const amountCents = Math.trunc(Number(input.amountCents));
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { error: "INFORME UM VALOR DE PAGAMENTO VÁLIDO E POSITIVO.", status: 400 };
  }
  if (!DATE_PATTERN.test(input.paymentDate)) return { error: "INFORME A DATA DO PAGAMENTO.", status: 400 };
  if (amountCents > payable.originalAmountCents - payable.paidAmountCents) {
    return { error: "O VALOR DO PAGAMENTO NÃO PODE SER MAIOR QUE O SALDO EM ABERTO DA CONTA.", status: 400 };
  }
  const accountError = await assertFinanceAccountBelongsToCompany(database, input.financeAccountId, payable.companyId);
  if (accountError) return { error: accountError, status: 409 };

  const paymentId = crypto.randomUUID();
  const actorName = actor.displayName || "Administrador";
  const statements: [string, unknown[]][] = [
    [
      `INSERT INTO accounts_payable_payments
        (id, payable_id, amount_cents, payment_date, payment_method, finance_account_id, notes,
         scheduled, confirmed_at, created_by, created_by_name, created_at, idempotency_key)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,CURRENT_TIMESTAMP,?12)`,
      [
        paymentId, payable.id, amountCents, input.paymentDate, input.paymentMethod, input.financeAccountId,
        input.notes, input.scheduled ? 1 : 0, input.scheduled ? "" : new Date().toISOString(),
        actor.id, actorName, input.idempotencyKey,
      ],
    ],
  ];
  if (!input.scheduled) {
    const newPaidAmount = payable.paidAmountCents + amountCents;
    const status = computeStoredStatus({
      originalAmountCents: payable.originalAmountCents,
      paidAmountCents: newPaidAmount,
      canceled: false,
      hasPendingSchedule: false,
    });
    statements.push([
      `UPDATE accounts_payable
       SET paid_amount_cents=?1, status=?2, updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP
       WHERE id=?5`,
      [newPaidAmount, status, actor.id, actorName, payable.id],
    ]);
  } else if (payable.status === "open") {
    statements.push([
      `UPDATE accounts_payable
       SET status='scheduled', updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
       WHERE id=?3`,
      [actor.id, actorName, payable.id],
    ]);
  }
  return { paymentId, statements };
}
