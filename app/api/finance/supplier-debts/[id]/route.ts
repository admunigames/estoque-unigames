import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { computeStoredStatus, todayInTimezone } from "../../../../lib/finance-status";
import { DATE_PATTERN, recalcPayableEntrySql } from "../../payables/shared";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { assertSupplierDebtAccess, canManageSupplierDebts, loadSupplierDebt, supplierDebtStatusView } from "../shared";

type PayableTwin = {
  id: string;
  companyId: string;
  companyName: string;
  financeItemId: string;
  originalAmountCents: number;
  paidAmountCents: number;
  status: "open" | "scheduled" | "partially_paid" | "paid" | "canceled";
  competenceMonth: string;
  dueDate: string;
};

async function loadPayableTwin(database: Awaited<ReturnType<typeof getD1>>, accountsPayableId: string) {
  return database
    .prepare(
      `SELECT id, company_id AS companyId, company_name AS companyName, finance_item_id AS financeItemId,
              original_amount_cents AS originalAmountCents, paid_amount_cents AS paidAmountCents, status,
              competence_month AS competenceMonth, due_date AS dueDate
       FROM accounts_payable WHERE id=?1`,
    )
    .bind(accountsPayableId)
    .first<PayableTwin>();
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageSupplierDebts(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR FORNECEDORES EM ABERTO." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const debt = await loadSupplierDebt(database, id);
    if (!debt) return jsonResponse({ error: "DÍVIDA NÃO ENCONTRADA." }, 404);

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertSupplierDebtAccess(scopeActor, debt);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const payable = await loadPayableTwin(database, debt.accountsPayableId);
    if (!payable) return jsonResponse({ error: "CONTA A PAGAR VINCULADA NÃO ENCONTRADA (DADOS INCONSISTENTES)." }, 500);

    const today = todayInTimezone();
    const payments = await database
      .prepare(
        `SELECT id, amount_cents AS amountCents, payment_date AS paymentDate, payment_method AS paymentMethod,
                finance_account_id AS financeAccountId, notes, scheduled, confirmed_at AS confirmedAt,
                created_by_name AS createdByName, created_at AS createdAt
         FROM accounts_payable_payments WHERE payable_id=?1 ORDER BY created_at DESC`,
      )
      .bind(debt.accountsPayableId)
      .all();

    return jsonResponse({
      debt: {
        ...debt,
        originalAmountCents: payable.originalAmountCents,
        paidAmountCents: payable.paidAmountCents,
        ...supplierDebtStatusView(payable.status, payable.dueDate, today),
      },
      payments: payments.results ?? [],
    });
  } catch (error) {
    console.error("Não foi possível carregar a dívida de fornecedor.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A DÍVIDA DE FORNECEDOR." }, 500);
  }
}

// Edita campos não-financeiros (descrição/datas/pedido/NF/observações) e,
// opcionalmente, o valor original — quando o valor muda, atualiza também a
// accounts_payable gêmea (fonte de verdade do saldo/DRE) na mesma transação
// e recalcula a célula da DRE afetada, mesmo padrão de payables/[id]/route.ts.
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR DÍVIDAS DE FORNECEDORES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const debt = await loadSupplierDebt(database, id);
    if (!debt) return jsonResponse({ error: "DÍVIDA NÃO ENCONTRADA." }, 404);
    if (debt.canceled) return jsonResponse({ error: "ESTA DÍVIDA ESTÁ CANCELADA E NÃO PODE SER EDITADA." }, 409);

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertSupplierDebtAccess(scopeActor, debt);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const payable = await loadPayableTwin(database, debt.accountsPayableId);
    if (!payable) return jsonResponse({ error: "CONTA A PAGAR VINCULADA NÃO ENCONTRADA (DADOS INCONSISTENTES)." }, 500);
    if (payable.status === "canceled") {
      return jsonResponse({ error: "A CONTA A PAGAR VINCULADA ESTÁ CANCELADA." }, 409);
    }

    const body = (await request.json()) as JsonMap;

    const description = safeText(body.description, 200) || debt.description;
    const invoiceNumber = body.invoiceNumber === undefined ? debt.invoiceNumber : safeText(body.invoiceNumber, 60);
    const orderReference = body.orderReference === undefined ? debt.orderReference : safeText(body.orderReference, 60);
    const notes = body.notes === undefined ? debt.notes : safeText(body.notes, 2000);
    const purchaseDate = body.purchaseDate === undefined ? debt.purchaseDate : safeText(body.purchaseDate, 10);
    if (purchaseDate && !DATE_PATTERN.test(purchaseDate)) return jsonResponse({ error: "DATA DA COMPRA INVÁLIDA." }, 400);
    const dueDate = body.dueDate === undefined ? debt.dueDate : safeText(body.dueDate, 10);
    if (!DATE_PATTERN.test(dueDate)) return jsonResponse({ error: "DATA PREVISTA DE PAGAMENTO INVÁLIDA." }, 400);

    const originalAmountCents =
      body.originalAmountCents === undefined ? payable.originalAmountCents : Number(body.originalAmountCents);
    if (!Number.isFinite(originalAmountCents) || !Number.isInteger(originalAmountCents) || originalAmountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
    }
    if (originalAmountCents < payable.paidAmountCents) {
      return jsonResponse(
        { error: "O NOVO VALOR NÃO PODE SER MENOR QUE O TOTAL JÁ PAGO. REGISTRE UM ESTORNO ANTES." },
        400,
      );
    }

    const actorName = actor.displayName || "Administrador";
    const status = computeStoredStatus({
      originalAmountCents,
      paidAmountCents: payable.paidAmountCents,
      canceled: false,
      hasPendingSchedule: payable.status === "scheduled",
    });
    const competenceMonth = dueDate.slice(0, 7);

    const statements: [string, unknown[]][] = [
      [
        `UPDATE supplier_open_debts
         SET description=?1, invoice_number=?2, order_reference=?3, notes=?4, purchase_date=?5, due_date=?6,
             original_amount_cents=?7, updated_by=?8, updated_by_name=?9, updated_at=CURRENT_TIMESTAMP
         WHERE id=?10`,
        [description, invoiceNumber, orderReference, notes, purchaseDate, dueDate, originalAmountCents, actor.id, actorName, id],
      ],
      [
        `UPDATE accounts_payable
         SET description=?1, invoice_number=?2, order_reference=?3, notes=?4, issue_date=?5, due_date=?6,
             competence_month=?7, original_amount_cents=?8, status=?9,
             updated_by=?10, updated_by_name=?11, updated_at=CURRENT_TIMESTAMP
         WHERE id=?12`,
        [
          description,
          invoiceNumber,
          orderReference,
          notes,
          purchaseDate,
          dueDate,
          competenceMonth,
          originalAmountCents,
          status,
          actor.id,
          actorName,
          debt.accountsPayableId,
        ],
      ],
    ];

    const slots = new Set([`${payable.companyId}::${payable.financeItemId}::${payable.competenceMonth}`]);
    slots.add(`${payable.companyId}::${payable.financeItemId}::${competenceMonth}`);
    for (const slot of slots) {
      const [slotCompanyId, slotFinanceItemId, slotMonth] = slot.split("::");
      const entryId = crypto.randomUUID();
      for (const [sql, sqlValues] of recalcPayableEntrySql(entryId, slotCompanyId, slotFinanceItemId, slotMonth, actor.id, actorName)) {
        statements.push([sql, sqlValues]);
      }
    }

    await database.batch(statements.map(([sql, sqlValues]) => database.prepare(sql).bind(...sqlValues)));

    return jsonResponse({ updated: true, id });
  } catch (error) {
    console.error("Não foi possível editar a dívida de fornecedor.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR A DÍVIDA DE FORNECEDOR." }, 500);
  }
}
