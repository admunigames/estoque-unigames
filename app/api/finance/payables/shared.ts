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

export type PayablesBulkAction = "pay" | "reschedule" | "category" | "cancel";

/**
 * Ações em lote de contas a pagar — usada pelo Fluxo de Caixa
 * (cash-flow/payments/bulk: pay/reschedule) e por Contas a Pagar
 * (payables/bulk: as quatro), para que MARCAR COMO PAGO dê o mesmo resultado
 * nas duas telas. Confere TODOS os ids antes (404 se algum sumiu, 403 se for
 * de outra loja) e devolve os SQL para uma transação só:
 * - pay: pagamento CONFIRMADO do saldo em aberto (original − pago − agendados
 *   pendentes) pela regra do POST payables/[id]/payments (planPayablePayment);
 * - reschedule: novo vencimento (fields.dueDate);
 * - category: item financeiro e/ou centro de custo (mesma checagem do PATCH
 *   individual: item existe, célula da DRE livre) e recalcula a DRE;
 * - cancel: mesma regra do [id]/cancel (soft-cancel, DRE recalculada, dívida
 *   de fornecedor gêmea cancelada junto); conta paga é pulada, como na tela.
 */
export async function planPayablesBulk(
  database: Awaited<ReturnType<typeof getD1>>,
  actor: { id: string; displayName: string },
  scopeActor: ScopeActor,
  action: PayablesBulkAction,
  ids: string[],
  fields: Record<string, unknown>,
): Promise<
  | { error: string; status: number }
  | { applied: number; skipped: Array<{ id: string; description: string; reason: string }>; statements: [string, unknown[]][] }
> {
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const paymentDate = text(fields.paymentDate, 10);
  const dueDate = text(fields.dueDate, 10);
  if (action === "pay" && !DATE_PATTERN.test(paymentDate)) return { error: "INFORME A DATA DO PAGAMENTO.", status: 400 };
  if (action === "reschedule" && !DATE_PATTERN.test(dueDate)) return { error: "INFORME O NOVO VENCIMENTO.", status: 400 };
  const financeItemId = text(fields.financeItemId, 80);
  const costCenterChanged = fields.costCenterId !== undefined;
  const costCenterId = text(fields.costCenterId, 80);
  let costCenterName = "";
  if (action === "category") {
    if (!financeItemId && !costCenterChanged) return { error: "ESCOLHA A CATEGORIA OU O CENTRO DE CUSTO.", status: 400 };
    if (financeItemId) {
      const item = await database.prepare("SELECT id FROM finance_items WHERE id=?1").bind(financeItemId).first();
      if (!item) return { error: "ITEM DE DESPESA NÃO ENCONTRADO NO CATÁLOGO FINANCEIRO.", status: 400 };
    }
    if (costCenterId) {
      const row = await database.prepare("SELECT name FROM finance_cost_centers WHERE id=?1").bind(costCenterId).first<{ name: string }>();
      if (!row) return { error: "CENTRO DE CUSTO NÃO ENCONTRADO.", status: 400 };
      costCenterName = row.name;
    }
  }

  const payables: PayableRow[] = [];
  for (const id of ids) {
    const payable = await loadPayable(database, id);
    if (!payable) return { error: "ALGUMA CONTA SELECIONADA NÃO EXISTE MAIS. ATUALIZE A LISTA.", status: 404 };
    const accessError = assertAccess(scopeActor, payable);
    if (accessError) return { error: accessError, status: 403 };
    payables.push(payable);
  }

  const pending = await database
    .prepare(
      `SELECT payable_id AS payableId, SUM(amount_cents) AS total FROM accounts_payable_payments
       WHERE scheduled = 1 AND confirmed_at = '' AND payable_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})
       GROUP BY payable_id`,
    )
    .bind(...ids)
    .all<{ payableId: string; total: number }>();
  const scheduledOf = new Map((pending.results ?? []).map((row) => [row.payableId, Number(row.total || 0)]));

  const skipped: Array<{ id: string; description: string; reason: string }> = [];
  const statements: [string, unknown[]][] = [];
  const slots = new Map<string, [string, string, string]>();
  const addSlot = (companyId: string, itemId: string, month: string) => slots.set(`${companyId}|${itemId}|${month}`, [companyId, itemId, month]);
  const actorName = actor.displayName || "Administrador";
  for (const payable of payables) {
    const skip = (reason: string) => skipped.push({ id: payable.id, description: payable.description, reason });
    if (payable.status === "canceled") { skip("CONTA CANCELADA"); continue; }
    if (action === "category") {
      const nextItem = financeItemId || payable.financeItemId;
      if (nextItem !== payable.financeItemId) {
        const conflict = await assertSlotAvailableForPayable(database, payable.companyId, nextItem, payable.competenceMonth);
        if (conflict) { skip(conflict); continue; }
        addSlot(payable.companyId, payable.financeItemId, payable.competenceMonth);
        addSlot(payable.companyId, nextItem, payable.competenceMonth);
      }
      statements.push([
        `UPDATE accounts_payable SET finance_item_id=?1, cost_center=?2, cost_center_id=?3,
           updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP WHERE id=?6`,
        [
          nextItem,
          costCenterChanged ? costCenterName : payable.costCenter,
          costCenterChanged ? costCenterId || null : payable.costCenterId,
          actor.id, actorName, payable.id,
        ],
      ]);
      continue;
    }
    if (payable.status === "paid") { skip("CONTA JÁ PAGA"); continue; }
    if (action === "reschedule") {
      statements.push([
        `UPDATE accounts_payable SET due_date=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4`,
        [dueDate, actor.id, actorName, payable.id],
      ]);
      continue;
    }
    if (action === "cancel") {
      statements.push([
        `UPDATE accounts_payable
         SET status='canceled', canceled_by=?1, canceled_by_name=?2, canceled_at=CURRENT_TIMESTAMP,
             updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
        [actor.id, actorName, payable.id],
      ]);
      statements.push([
        `UPDATE supplier_open_debts SET canceled=1, updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
         WHERE accounts_payable_id=?3`,
        [actor.id, actorName, payable.id],
      ]);
      addSlot(payable.companyId, payable.financeItemId, payable.competenceMonth);
      continue;
    }
    const openCents = payable.originalAmountCents - payable.paidAmountCents - (scheduledOf.get(payable.id) ?? 0);
    if (openCents <= 0) { skip("SALDO JÁ AGENDADO — CONFIRME O AGENDAMENTO EM CONTAS A PAGAR"); continue; }
    const plan = await planPayablePayment(database, payable, actor, {
      idempotencyKey: `payables-bulk:${crypto.randomUUID()}`,
      amountCents: openCents,
      paymentDate,
      scheduled: false,
      paymentMethod: text(fields.paymentMethod, 40),
      financeAccountId: text(fields.financeAccountId, 80),
      notes: text(fields.notes, 200) || "PAGO EM LOTE",
    });
    if ("error" in plan) { skip(plan.error); continue; }
    statements.push(...plan.statements);
  }
  for (const [companyId, itemId, month] of slots.values()) {
    statements.push(...recalcPayableEntrySql(crypto.randomUUID(), companyId, itemId, month, actor.id, actorName));
  }
  return { applied: payables.length - skipped.length, skipped, statements };
}

/**
 * EXCLUIR conta a pagar de vez (pedido do usuário: limpar lançamentos
 * cancelados). Regras de segurança — o que não pode, é PULADO com o motivo:
 *  - só conta já CANCELADA (o cancelamento é que tira o valor da DRE; excluir
 *    é só tirar da lista);
 *  - sem pagamento confirmado (o dinheiro saiu; o histórico fica);
 *  - duplicata de NOTA FISCAL: exclui-se pela nota;
 *  - conta de DESPESA: a despesa inteira sai junto (todas as contas dela,
 *    fatias do rateio e anexos), e só se TODAS as contas dela estiverem
 *    canceladas e sem pagamento; despesa vinda do cartão corporativo ou do
 *    extrato bancário não é excluída por aqui (o lançamento de origem
 *    ficaria apontando para ela).
 * Apaga também agendamentos/anexos de pagamento e a dívida "gêmea" de
 * Fornecedores em Aberto.
 */
export async function planPayablesDelete(
  database: Awaited<ReturnType<typeof getD1>>,
  scopeActor: ScopeActor,
  ids: string[],
): Promise<
  | { error: string; status: number }
  | { applied: number; skipped: Array<{ id: string; description: string; reason: string }>; statements: [string, unknown[]][] }
> {
  const payables: PayableRow[] = [];
  for (const id of ids) {
    const payable = await loadPayable(database, id);
    if (!payable) return { error: "ALGUMA CONTA SELECIONADA NÃO EXISTE MAIS. ATUALIZE A LISTA.", status: 404 };
    const accessError = assertAccess(scopeActor, payable);
    if (accessError) return { error: accessError, status: 403 };
    payables.push(payable);
  }
  const skipped: Array<{ id: string; description: string; reason: string }> = [];
  const statements: [string, unknown[]][] = [];
  const deletedPayables = new Set<string>();
  const handledExpenses = new Set<string>();

  const confirmedPayments = async (payableIds: string[]) => {
    if (!payableIds.length) return 0;
    const row = await database
      .prepare(
        `SELECT COUNT(*) AS n FROM accounts_payable_payments
         WHERE confirmed_at <> '' AND payable_id IN (${payableIds.map((_, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...payableIds)
      .first<{ n: number }>();
    return Number(row?.n || 0);
  };
  const deletePayableSql = (payableId: string) => {
    statements.push(
      [
        `DELETE FROM accounts_payable_payment_attachments
         WHERE payment_id IN (SELECT id FROM accounts_payable_payments WHERE payable_id=?1)`,
        [payableId],
      ],
      ["DELETE FROM accounts_payable_payments WHERE payable_id=?1", [payableId]],
      ["DELETE FROM supplier_open_debts WHERE accounts_payable_id=?1", [payableId]],
      ["DELETE FROM accounts_payable WHERE id=?1", [payableId]],
    );
    deletedPayables.add(payableId);
  };

  for (const payable of payables) {
    if (deletedPayables.has(payable.id)) continue;
    const skip = (reason: string) => skipped.push({ id: payable.id, description: payable.description, reason });
    if (payable.status !== "canceled") { skip("CANCELE A CONTA ANTES DE EXCLUIR"); continue; }
    const invoiceLink = await database
      .prepare("SELECT id FROM supplier_invoice_installments WHERE accounts_payable_id=?1")
      .bind(payable.id)
      .first<{ id: string }>();
    if (invoiceLink) { skip("VEIO DE NOTA FISCAL — EXCLUA PELA NOTA"); continue; }

    if (payable.expenseId) {
      if (handledExpenses.has(payable.expenseId)) continue;
      handledExpenses.add(payable.expenseId);
      const expense = await database
        .prepare("SELECT id, card_id AS cardId, bank_reconciliation_id AS bankReconciliationId FROM expenses WHERE id=?1")
        .bind(payable.expenseId)
        .first<{ id: string; cardId: string; bankReconciliationId: string }>();
      if (expense && (expense.cardId || expense.bankReconciliationId)) {
        skip("DESPESA VEIO DO CARTÃO OU DO EXTRATO — NÃO PODE SER EXCLUÍDA POR AQUI");
        continue;
      }
      const siblings = (
        await database
          .prepare("SELECT id, status FROM accounts_payable WHERE expense_id=?1")
          .bind(payable.expenseId)
          .all<{ id: string; status: string }>()
      ).results ?? [];
      if (siblings.some((row) => row.status !== "canceled")) {
        skip("A DESPESA TEM OUTRAS CONTAS NÃO CANCELADAS — CANCELE TODAS ANTES");
        continue;
      }
      if (await confirmedPayments(siblings.map((row) => row.id))) { skip("TEM PAGAMENTO REGISTRADO"); continue; }
      for (const row of siblings) deletePayableSql(row.id);
      statements.push(
        ["DELETE FROM expense_rateio_shares WHERE expense_id=?1", [payable.expenseId]],
        ["DELETE FROM expense_attachments WHERE expense_id=?1", [payable.expenseId]],
        ["DELETE FROM expenses WHERE id=?1", [payable.expenseId]],
      );
      continue;
    }

    if (await confirmedPayments([payable.id])) { skip("TEM PAGAMENTO REGISTRADO"); continue; }
    deletePayableSql(payable.id);
  }
  return { applied: deletedPayables.size, skipped, statements };
}
