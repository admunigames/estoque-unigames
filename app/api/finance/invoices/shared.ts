import type { getD1 } from "../../../../db";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR, type ScopeActor } from "../../../lib/access-scope";
import { effectiveDreAmountCents } from "../../../lib/payables-recurrence";
import {
  computeInvoiceFinancialStatus,
  type InstallmentSnapshot,
  type InvoiceFinancialStatus,
} from "../../../lib/supplier-invoice-status";
import type { Identity } from "../shared";

export type { InstallmentSnapshot };

/**
 * Permissões granulares do módulo NF/Duplicatas — todas com fallback pra
 * finance:manage (quem já podia tudo em Financeiro continua podendo tudo
 * aqui), conforme decisão registrada no prompt do módulo.
 */
export function canViewInvoices(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("finance:manage") ||
    actor.permissions.includes("payables:invoices_view") ||
    actor.permissions.includes("payables:invoices_reconcile") ||
    actor.permissions.includes("payables:confirm_payment") ||
    actor.permissions.includes("payables:return_to_purchases")
  );
}

export function canReconcileInvoices(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("finance:manage") ||
    actor.permissions.includes("payables:invoices_reconcile")
  );
}

export function canConfirmInvoicePayment(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("finance:manage") ||
    actor.permissions.includes("payables:confirm_payment")
  );
}

export function canReturnInvoiceToPurchases(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("finance:manage") ||
    actor.permissions.includes("payables:return_to_purchases")
  );
}

export type InvoiceRow = {
  id: string;
  companyId: string;
  companyName: string;
  supplierId: string;
  supplierDocument: string;
  invoiceNumber: string;
  series: string;
  accessKey: string;
  issueDate: string;
  entryDate: string;
  competenceMonth: string;
  notionPurchaseId: string;
  notionPurchaseUrl: string;
  totalAmountCents: number;
  financeCategoryId: string;
  financeItemId: string;
  costCenter: string;
  costCenterId: string | null;
  notes: string;
  origin: "purchase" | "manual";
  operationalStatus: string;
  financialStatus: InvoiceFinancialStatus;
  pendingCorrection: number;
  returnReason: string;
  canceled: number;
  createdBy: string;
  createdByName: string;
  sentToFinanceBy: string;
  sentToFinanceByName: string;
  sentToFinanceAt: string;
  returnedBy: string;
  returnedByName: string;
  returnedAt: string;
  createdAt: string;
  updatedAt: string;
};

export const INVOICE_ROW_SELECT = `id, company_id AS companyId, company_name AS companyName,
  supplier_id AS supplierId, supplier_document AS supplierDocument,
  invoice_number AS invoiceNumber, series, access_key AS accessKey,
  issue_date AS issueDate, entry_date AS entryDate, competence_month AS competenceMonth,
  notion_purchase_id AS notionPurchaseId, notion_purchase_url AS notionPurchaseUrl,
  total_amount_cents AS totalAmountCents, finance_category_id AS financeCategoryId,
  finance_item_id AS financeItemId, cost_center AS costCenter, cost_center_id AS costCenterId, notes, origin,
  operational_status AS operationalStatus, financial_status AS financialStatus,
  pending_correction AS pendingCorrection, return_reason AS returnReason, canceled,
  created_by AS createdBy, created_by_name AS createdByName,
  sent_to_finance_by AS sentToFinanceBy, sent_to_finance_by_name AS sentToFinanceByName,
  sent_to_finance_at AS sentToFinanceAt, returned_by AS returnedBy, returned_by_name AS returnedByName,
  returned_at AS returnedAt, created_at AS createdAt, updated_at AS updatedAt`;

export async function loadInvoice(
  database: Awaited<ReturnType<typeof getD1>>,
  id: string,
): Promise<InvoiceRow | null> {
  return database
    .prepare(`SELECT ${INVOICE_ROW_SELECT} FROM supplier_invoices WHERE id=?1`)
    .bind(id)
    .first<InvoiceRow>();
}

export function assertInvoiceAccess(scopeActor: ScopeActor, invoice: InvoiceRow): string | null {
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (allStores) return null;
  if (!hasCompany(scopeActor.companyId)) return NO_COMPANY_ERROR;
  if (invoice.companyId !== scopeActor.companyId) return "VOCÊ NÃO TEM ACESSO A ESSA NOTA FISCAL.";
  return null;
}

export type InstallmentRow = {
  id: string;
  invoiceId: string;
  companyId: string;
  installmentNumber: number;
  installmentTotal: number;
  documentNumber: string;
  dueDate: string;
  originalAmountCents: number;
  paidAmountCents: number;
  paymentMethod: string;
  financeAccountId: string;
  boletoCode: string;
  notes: string;
  accountsPayableId: string;
  canceled: number;
  createdAt: string;
  updatedAt: string;
};

export const INSTALLMENT_ROW_SELECT = `id, invoice_id AS invoiceId, company_id AS companyId,
  installment_number AS installmentNumber, installment_total AS installmentTotal,
  document_number AS documentNumber, due_date AS dueDate,
  original_amount_cents AS originalAmountCents, paid_amount_cents AS paidAmountCents,
  payment_method AS paymentMethod, finance_account_id AS financeAccountId, boleto_code AS boletoCode,
  notes, accounts_payable_id AS accountsPayableId, canceled,
  created_at AS createdAt, updated_at AS updatedAt`;

export async function loadInstallments(
  database: Awaited<ReturnType<typeof getD1>>,
  invoiceId: string,
): Promise<InstallmentRow[]> {
  const result = await database
    .prepare(
      `SELECT ${INSTALLMENT_ROW_SELECT} FROM supplier_invoice_installments
       WHERE invoice_id=?1 ORDER BY installment_number ASC, created_at ASC`,
    )
    .bind(invoiceId)
    .all<InstallmentRow>();
  return result.results ?? [];
}

export function toInstallmentSnapshot(
  installment: InstallmentRow,
  pendingScheduleIds: Set<string> = new Set(),
): InstallmentSnapshot & { dueDate: string } {
  return {
    originalAmountCents: installment.originalAmountCents,
    paidAmountCents: installment.paidAmountCents,
    dueDate: installment.dueDate,
    canceled: Boolean(installment.canceled),
    hasPendingSchedule: pendingScheduleIds.has(installment.accountsPayableId),
    paymentMethod: installment.paymentMethod,
    boletoCode: installment.boletoCode,
  };
}

/**
 * accounts_payable_id de toda duplicata com um pagamento agendado (scheduled=1)
 * ainda não confirmado — mesma regra usada em accounts_payable/[id]/route.ts
 * pra decidir o status 'scheduled', só que em lote pra todas as duplicatas
 * de uma NF de uma vez (evita N+1 na tela de detalhe).
 */
/**
 * Monta o UPDATE de financial_status da NF a partir do estado atual do
 * banco (duplicatas + agendamentos pendentes) — devolve a statement pronta
 * pra entrar no MESMO batch da escrita que motivou o recálculo (nunca uma
 * escrita solta). `reviewed` é lido da própria NF: qualquer financial_status
 * diferente de aguardando_envio/aguardando_conferencia implica que ela já
 * foi conferida ao menos uma vez.
 */
export async function buildInvoiceStatusRecalcStatement(
  database: Awaited<ReturnType<typeof getD1>>,
  invoice: {
    id: string;
    totalAmountCents: number;
    canceled: boolean | number;
    sentToFinanceAt: string;
    financialStatus: string;
  },
  actorId: string,
  actorName: string,
  overrides?: { reviewed?: boolean },
): Promise<{ sql: string; values: unknown[]; nextStatus: InvoiceFinancialStatus }> {
  const installments = await loadInstallments(database, invoice.id);
  const pendingScheduleIds = await loadPendingScheduleIds(
    database,
    installments.map((installment) => installment.accountsPayableId),
  );
  const reviewed =
    overrides?.reviewed ??
    !["aguardando_envio", "aguardando_conferencia"].includes(invoice.financialStatus);
  const nextStatus = computeInvoiceFinancialStatus({
    totalAmountCents: invoice.totalAmountCents,
    canceled: invoice.canceled,
    sentToFinance: Boolean(invoice.sentToFinanceAt),
    reviewed,
    installments: installments.map((installment) => toInstallmentSnapshot(installment, pendingScheduleIds)),
  });
  return {
    sql: `UPDATE supplier_invoices
          SET financial_status=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP
          WHERE id=?4`,
    values: [nextStatus, actorId, actorName, invoice.id],
    nextStatus,
  };
}

export function invoiceEventStatement(params: {
  invoiceId: string;
  eventType: string;
  description: string;
  metadata?: Record<string, unknown>;
  actorId: string;
  actorName: string;
}): [string, unknown[]] {
  return [
    `INSERT INTO supplier_invoice_events (id, invoice_id, event_type, description, metadata_json, actor_id, actor_name, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,CURRENT_TIMESTAMP)`,
    [
      crypto.randomUUID(),
      params.invoiceId,
      params.eventType,
      params.description,
      JSON.stringify(params.metadata ?? {}),
      params.actorId,
      params.actorName,
    ],
  ];
}

export type DreView = { included: boolean; amountCents: number; isCustomized: boolean };

/**
 * Estado do toggle "Incluir na DRE?" em nível de NF — soma o impacto
 * EFETIVO (customizado ou original) de cada duplicata ativa vinculada,
 * lendo dre_amount_cents das linhas de accounts_payable "gêmeas" (uma por
 * duplicata, ligadas via accounts_payable_id). Duplicatas canceladas não
 * entram na soma (já saem da DRE por outro caminho — status='canceled').
 */
export async function loadInvoiceDreView(
  database: Awaited<ReturnType<typeof getD1>>,
  installments: InstallmentRow[],
): Promise<DreView> {
  const activePayableIds = installments.filter((i) => !i.canceled).map((i) => i.accountsPayableId).filter(Boolean);
  if (!activePayableIds.length) return { included: true, amountCents: 0, isCustomized: false };
  const placeholders = activePayableIds.map((_, index) => `?${index + 1}`).join(",");
  const result = await database
    .prepare(
      `SELECT id, original_amount_cents AS originalAmountCents, dre_amount_cents AS dreAmountCents
       FROM accounts_payable WHERE id IN (${placeholders})`,
    )
    .bind(...activePayableIds)
    .all<{ id: string; originalAmountCents: number; dreAmountCents: number | null }>();
  const rows = result.results ?? [];
  const totalDreImpact = rows.reduce((sum, row) => sum + effectiveDreAmountCents(row.dreAmountCents, row.originalAmountCents), 0);
  const isCustomized = rows.some((row) => row.dreAmountCents !== null && row.dreAmountCents !== undefined);
  return { included: !isCustomized || totalDreImpact > 0, amountCents: totalDreImpact, isCustomized };
}

export async function loadPendingScheduleIds(
  database: Awaited<ReturnType<typeof getD1>>,
  payableIds: string[],
): Promise<Set<string>> {
  const ids = payableIds.filter(Boolean);
  if (!ids.length) return new Set();
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
  const result = await database
    .prepare(
      `SELECT DISTINCT payable_id AS payableId FROM accounts_payable_payments
       WHERE scheduled=1 AND confirmed_at='' AND payable_id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{ payableId: string }>();
  return new Set((result.results ?? []).map((row) => row.payableId));
}
