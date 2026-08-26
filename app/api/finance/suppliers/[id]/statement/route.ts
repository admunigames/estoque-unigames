import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../../lib/access-scope";
import { todayInTimezone } from "../../../../../lib/finance-status";
import { identity, jsonResponse, safeText } from "../../../shared";

// Conta corrente do fornecedor — agrega TODAS as accounts_payable do
// fornecedor (independente da origem: duplicata de NF, dívida avulsa de
// Fornecedores em Aberto, despesa ou conta manual — já estão todas na
// mesma tabela, ver decisão de arquitetura do módulo), seus pagamentos e um
// resumo das notas fiscais do fornecedor, montando um extrato cronológico
// com saldo corrente. Rotaviza a origem de cada linha por LEFT JOIN com as
// tabelas "gêmeas" conhecidas (supplier_invoice_installments,
// supplier_open_debts) + expense_id da própria accounts_payable.
type PayableRow = {
  id: string;
  companyId: string;
  companyName: string;
  description: string;
  invoiceNumber: string;
  orderReference: string;
  issueDate: string;
  dueDate: string;
  originalAmountCents: number;
  paidAmountCents: number;
  status: string;
  createdAt: string;
  origin: "invoice" | "debt" | "expense" | "manual";
};

type PaymentRow = {
  id: string;
  payableId: string;
  amountCents: number;
  paymentDate: string;
  paymentMethod: string;
  notes: string;
  scheduled: number;
  confirmedAt: string;
  createdByName: string;
  createdAt: string;
};

type StatementEntry = {
  date: string;
  document: string;
  orderReference: string;
  movement: "compra" | "pagamento";
  origin: string;
  amountCents: number;
  balanceCents: number;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (actor.role !== "admin" && !actor.permissions.includes("finance:manage")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const { id: supplierId } = await context.params;

  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const url = new URL(request.url);
  const requestedCompanyId = safeText(url.searchParams.get("companyId"), 80);
  if (!allStores && requestedCompanyId && requestedCompanyId !== scopeActor.companyId) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
  }
  const effectiveCompanyId = allStores ? requestedCompanyId : scopeActor.companyId;

  try {
    const database = await getD1();
    const supplier = await database
      .prepare("SELECT id, name, document FROM finance_suppliers WHERE id=?1")
      .bind(supplierId)
      .first<{ id: string; name: string; document: string }>();
    if (!supplier) return jsonResponse({ error: "FORNECEDOR NÃO ENCONTRADO." }, 404);

    const companyCondition = effectiveCompanyId ? "AND a.company_id=?2" : "";
    const payableParams = effectiveCompanyId ? [supplierId, effectiveCompanyId] : [supplierId];

    const payablesResult = await database
      .prepare(
        `SELECT a.id, a.company_id AS companyId, a.company_name AS companyName, a.description,
                a.invoice_number AS invoiceNumber, a.order_reference AS orderReference,
                a.issue_date AS issueDate, a.due_date AS dueDate,
                a.original_amount_cents AS originalAmountCents, a.paid_amount_cents AS paidAmountCents,
                a.status, a.created_at AS createdAt,
                CASE
                  WHEN sii.id IS NOT NULL THEN 'invoice'
                  WHEN sod.id IS NOT NULL THEN 'debt'
                  WHEN a.expense_id IS NOT NULL THEN 'expense'
                  ELSE 'manual'
                END AS origin
         FROM accounts_payable a
         LEFT JOIN supplier_invoice_installments sii ON sii.accounts_payable_id = a.id
         LEFT JOIN supplier_open_debts sod ON sod.accounts_payable_id = a.id
         WHERE a.supplier_id=?1 AND a.status != 'canceled' ${companyCondition}
         ORDER BY a.due_date ASC`,
      )
      .bind(...payableParams)
      .all<PayableRow>();
    const payables = payablesResult.results ?? [];
    const payableIds = payables.map((row) => row.id);

    let payments: PaymentRow[] = [];
    if (payableIds.length) {
      const placeholders = payableIds.map((_, index) => `?${index + 1}`).join(",");
      const paymentsResult = await database
        .prepare(
          `SELECT id, payable_id AS payableId, amount_cents AS amountCents, payment_date AS paymentDate,
                  payment_method AS paymentMethod, notes, scheduled, confirmed_at AS confirmedAt,
                  created_by_name AS createdByName, created_at AS createdAt
           FROM accounts_payable_payments
           WHERE payable_id IN (${placeholders})
           ORDER BY payment_date ASC`,
        )
        .bind(...payableIds)
        .all<PaymentRow>();
      payments = paymentsResult.results ?? [];
    }

    const invoicesCompanyCondition = effectiveCompanyId ? "AND company_id=?2" : "";
    const invoicesParams = effectiveCompanyId ? [supplierId, effectiveCompanyId] : [supplierId];
    const invoicesRow = await database
      .prepare(
        `SELECT COUNT(*) AS totalCount,
                COALESCE(SUM(total_amount_cents), 0) AS totalCents,
                COUNT(*) FILTER (WHERE financial_status NOT IN ('pago', 'cancelado')) AS openCount
         FROM supplier_invoices
         WHERE supplier_id=?1 AND canceled=0 ${invoicesCompanyCondition}`,
      )
      .bind(...invoicesParams)
      .first<{ totalCount: number; totalCents: number; openCount: number }>();

    const today = todayInTimezone();
    const ORIGIN_LABELS: Record<string, string> = {
      invoice: "NOTA FISCAL",
      debt: "DÍVIDA AVULSA",
      expense: "DESPESA",
      manual: "CONTA MANUAL",
    };

    // Extrato cronológico: cada compra (accounts_payable) entra como um
    // evento positivo na data de emissão (ou criação, se emissão vazia);
    // cada pagamento confirmado entra como evento negativo na data do
    // pagamento. Agendamentos ainda não confirmados NÃO entram no extrato
    // (não afetaram o saldo ainda), mas continuam no histórico de pagamentos.
    const rawEntries: Omit<StatementEntry, "balanceCents">[] = [];
    for (const payable of payables) {
      rawEntries.push({
        date: payable.issueDate || payable.createdAt.slice(0, 10),
        document: payable.invoiceNumber || payable.description,
        orderReference: payable.orderReference,
        movement: "compra",
        origin: ORIGIN_LABELS[payable.origin] || "CONTA MANUAL",
        amountCents: payable.originalAmountCents,
      });
    }
    for (const payment of payments) {
      if (payment.scheduled && !payment.confirmedAt) continue;
      const payable = payables.find((row) => row.id === payment.payableId);
      rawEntries.push({
        date: payment.paymentDate,
        document: payable?.invoiceNumber || payable?.description || "",
        orderReference: payable?.orderReference || "",
        movement: "pagamento",
        origin: "PAGAMENTO",
        amountCents: -payment.amountCents,
      });
    }
    rawEntries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let runningBalance = 0;
    const statement: StatementEntry[] = rawEntries.map((entry) => {
      runningBalance += entry.amountCents;
      return { ...entry, balanceCents: runningBalance };
    });

    const totalPurchasedCents = payables.reduce((sum, row) => sum + row.originalAmountCents, 0);
    const totalPaidCents = payables.reduce((sum, row) => sum + row.paidAmountCents, 0);
    const openPayables = payables.filter((row) => row.status !== "paid");
    const totalOpenCents = openPayables.reduce((sum, row) => sum + (row.originalAmountCents - row.paidAmountCents), 0);
    const overdueCents = openPayables
      .filter((row) => row.dueDate < today)
      .reduce((sum, row) => sum + (row.originalAmountCents - row.paidAmountCents), 0);
    const upcomingPayments = openPayables
      .filter((row) => row.dueDate >= today)
      .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))
      .slice(0, 10);

    return jsonResponse({
      supplier,
      totals: {
        totalPurchasedCents,
        totalPaidCents,
        totalOpenCents,
        overdueCents,
        openInvoicesCount: Number(invoicesRow?.openCount ?? 0),
        openInstallmentsCount: openPayables.filter((row) => row.origin === "invoice").length,
        totalInvoicesCount: Number(invoicesRow?.totalCount ?? 0),
        totalInvoicedCents: Number(invoicesRow?.totalCents ?? 0),
      },
      upcomingPayments,
      paymentHistory: payments,
      statement,
      today,
    });
  } catch (error) {
    console.error("Não foi possível carregar a conta corrente do fornecedor.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A CONTA CORRENTE DO FORNECEDOR." }, 500);
  }
}
