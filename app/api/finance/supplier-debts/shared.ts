import type { getD1 } from "../../../../db";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR, type ScopeActor } from "../../../lib/access-scope";
import { DISPLAY_STATUS_LABELS, computeDisplayStatus, type StoredStatus } from "../../../lib/finance-status";

// Módulo "Fornecedores em Aberto" (Financeiro Fase 3) — mesmo padrão de
// app/api/finance/invoices/shared.ts: cada dívida avulsa tem sua própria
// linha "gêmea" em accounts_payable, reaproveitada por completo pra
// status/pagamento/DRE. Ver db/schema.ts#supplierOpenDebts.

// Item financeiro genérico semeado pela migration 0034 — usado como default
// quando o usuário não escolhe categoria/item explícito no cadastro da
// dívida (o formulário trata isso como opcional, por decisão do prompt).
export const DEFAULT_SUPPLIER_DEBT_FINANCE_ITEM_ID = "seed-supplier-open-debt-item";

// Reaproveita as permissões já existentes de Contas a Pagar (finance:manage)
// em vez de criar granularidade nova — decisão explícita do escopo: não há
// razão de negócio hoje pra separar quem pode ver/gerenciar Contas a Pagar
// de quem pode ver/gerenciar Fornecedores em Aberto (é o mesmo motor).
export function canManageSupplierDebts(actor: { role: "admin" | "user"; permissions: string[] }) {
  return actor.role === "admin" || actor.permissions.includes("finance:manage");
}

export type SupplierDebtRow = {
  id: string;
  companyId: string;
  companyName: string;
  supplierId: string;
  supplierName: string;
  invoiceNumber: string;
  supplierInvoiceId: string;
  orderReference: string;
  purchaseDate: string;
  description: string;
  originalAmountCents: number;
  paidAmountCents: number;
  dueDate: string;
  notes: string;
  accountsPayableId: string;
  canceled: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export const SUPPLIER_DEBT_SELECT = `sod.id, sod.company_id AS companyId, sod.company_name AS companyName,
  sod.supplier_id AS supplierId, sod.supplier_name AS supplierName,
  sod.invoice_number AS invoiceNumber, sod.supplier_invoice_id AS supplierInvoiceId,
  sod.order_reference AS orderReference, sod.purchase_date AS purchaseDate,
  sod.description, sod.original_amount_cents AS originalAmountCents,
  sod.paid_amount_cents AS paidAmountCents, sod.due_date AS dueDate, sod.notes,
  sod.accounts_payable_id AS accountsPayableId, sod.canceled,
  sod.created_by AS createdBy, sod.created_by_name AS createdByName,
  sod.created_at AS createdAt, sod.updated_at AS updatedAt`;

export async function loadSupplierDebt(
  database: Awaited<ReturnType<typeof getD1>>,
  id: string,
): Promise<SupplierDebtRow | null> {
  return database
    .prepare(`SELECT ${SUPPLIER_DEBT_SELECT} FROM supplier_open_debts sod WHERE sod.id=?1`)
    .bind(id)
    .first<SupplierDebtRow>();
}

export function assertSupplierDebtAccess(scopeActor: ScopeActor, debt: SupplierDebtRow): string | null {
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (allStores) return null;
  if (!hasCompany(scopeActor.companyId)) return NO_COMPANY_ERROR;
  if (debt.companyId !== scopeActor.companyId) return "VOCÊ NÃO TEM ACESSO A ESSA DÍVIDA DE FORNECEDOR.";
  return null;
}

export type SupplierDebtStatusView = {
  storedStatus: StoredStatus;
  displayStatus: string;
  displayStatusLabel: string;
};

/**
 * A dívida em si não guarda status — é sempre derivado da accounts_payable
 * gêmea (status + saldo + vencimento), igual ao padrão de duplicatas de NF.
 */
export function supplierDebtStatusView(
  payableStatus: StoredStatus,
  dueDate: string,
  today: string,
): SupplierDebtStatusView {
  const displayStatus = computeDisplayStatus({ storedStatus: payableStatus, dueDate, today });
  return { storedStatus: payableStatus, displayStatus, displayStatusLabel: DISPLAY_STATUS_LABELS[displayStatus] };
}
