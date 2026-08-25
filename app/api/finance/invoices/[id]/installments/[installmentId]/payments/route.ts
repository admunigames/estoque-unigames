import { getD1 } from "../../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../../lib/notion";
import { computeStoredStatus } from "../../../../../../../lib/finance-status";
import { identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../../../../shared";
import { DATE_PATTERN, assertFinanceAccountBelongsToCompany } from "../../../../../payables/shared";
import {
  assertInvoiceAccess,
  buildInvoiceStatusRecalcStatement,
  canConfirmInvoicePayment,
  canViewInvoices,
  invoiceEventStatement,
  loadInvoice,
  INSTALLMENT_ROW_SELECT,
  type InstallmentRow,
} from "../../../../shared";

async function loadInstallment(
  database: Awaited<ReturnType<typeof getD1>>,
  id: string,
): Promise<InstallmentRow | null> {
  return database
    .prepare(`SELECT ${INSTALLMENT_ROW_SELECT} FROM supplier_invoice_installments WHERE id=?1`)
    .bind(id)
    .first<InstallmentRow>();
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; installmentId: string }> },
) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewInvoices(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER PAGAMENTOS." }, 403);
  }
  const { id, installmentId } = await context.params;
  try {
    const database = await getD1();
    const invoice = await loadInvoice(database, id);
    if (!invoice) return jsonResponse({ error: "NOTA FISCAL NÃO ENCONTRADA." }, 404);
    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertInvoiceAccess(scopeActor, invoice);
    if (accessError) return jsonResponse({ error: accessError }, 403);
    const installment = await loadInstallment(database, installmentId);
    if (!installment || installment.invoiceId !== id) return jsonResponse({ error: "DUPLICATA NÃO ENCONTRADA." }, 404);
    if (!installment.accountsPayableId) return jsonResponse({ payments: [] });

    const result = await database
      .prepare(
        `SELECT id, amount_cents AS amountCents, payment_date AS paymentDate, payment_method AS paymentMethod,
                finance_account_id AS financeAccountId, notes, scheduled, confirmed_at AS confirmedAt,
                created_by_name AS createdByName, created_at AS createdAt
         FROM accounts_payable_payments WHERE payable_id=?1 ORDER BY created_at DESC`,
      )
      .bind(installment.accountsPayableId)
      .all();
    return jsonResponse({ payments: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os pagamentos da duplicata.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS PAGAMENTOS." }, 500);
  }
}

// Agendar/confirmar pagamento de uma duplicata — reaproveita 100% a mesma
// tabela e regra de saldo/idempotência de accounts_payable_payments (ver
// app/api/finance/payables/[id]/payments/route.ts), só espelhando o valor
// pago também em supplier_invoice_installments.paid_amount_cents (fonte da
// verdade continua accounts_payable; a duplicata é um espelho, ver nota em
// db/schema.ts) e recalculando o financial_status agregado da NF.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; installmentId: string }> },
) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canConfirmInvoicePayment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA REGISTRAR PAGAMENTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id, installmentId } = await context.params;

  try {
    const body = (await request.json()) as JsonMap;
    const idempotencyKey = safeText(body.idempotencyKey, 120);
    if (!idempotencyKey) return jsonResponse({ error: "REQUISIÇÃO INVÁLIDA (SEM CHAVE DE IDEMPOTÊNCIA)." }, 400);

    const database = await getD1();
    const invoice = await loadInvoice(database, id);
    if (!invoice) return jsonResponse({ error: "NOTA FISCAL NÃO ENCONTRADA." }, 404);
    if (invoice.canceled) return jsonResponse({ error: "ESTA NOTA FISCAL ESTÁ CANCELADA." }, 409);
    const installment = await loadInstallment(database, installmentId);
    if (!installment || installment.invoiceId !== id) return jsonResponse({ error: "DUPLICATA NÃO ENCONTRADA." }, 404);
    if (installment.canceled) return jsonResponse({ error: "ESTA DUPLICATA ESTÁ CANCELADA." }, 409);
    if (!installment.accountsPayableId) {
      return jsonResponse({ error: "ESTA DUPLICATA NÃO POSSUI UM LANÇAMENTO FINANCEIRO VINCULADO." }, 409);
    }

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertInvoiceAccess(scopeActor, invoice);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const existingByKey = await database
      .prepare("SELECT id FROM accounts_payable_payments WHERE idempotency_key=?1")
      .bind(idempotencyKey)
      .first<{ id: string }>();
    if (existingByKey) {
      return jsonResponse({ created: true, alreadyProcessed: true, id: existingByKey.id });
    }

    const amountCents = Math.trunc(Number(body.amountCents));
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR DE PAGAMENTO VÁLIDO E POSITIVO." }, 400);
    }
    const paymentDate = safeText(body.paymentDate, 10);
    if (!DATE_PATTERN.test(paymentDate)) return jsonResponse({ error: "INFORME A DATA DO PAGAMENTO." }, 400);

    const scheduled = body.scheduled === true;
    const remainingBalance = installment.originalAmountCents - installment.paidAmountCents;
    if (amountCents > remainingBalance) {
      return jsonResponse(
        { error: "O VALOR DO PAGAMENTO NÃO PODE SER MAIOR QUE O SALDO EM ABERTO DA DUPLICATA." },
        400,
      );
    }

    const paymentMethod = safeText(body.paymentMethod, 40) || installment.paymentMethod;
    const financeAccountId = safeText(body.financeAccountId, 80) || installment.financeAccountId;
    const accountError = await assertFinanceAccountBelongsToCompany(database, financeAccountId, invoice.companyId);
    if (accountError) return jsonResponse({ error: accountError }, 409);
    if (!financeAccountId && !scheduled) {
      return jsonResponse({ error: "SELECIONE A CONTA BANCÁRIA USADA NO PAGAMENTO." }, 400);
    }

    const notes = safeText(body.notes, 2000);
    const paymentId = crypto.randomUUID();
    const actorName = actor.displayName || "Administrador";

    const statements: [string, unknown[]][] = [
      [
        `INSERT INTO accounts_payable_payments
          (id, payable_id, amount_cents, payment_date, payment_method, finance_account_id, notes,
           scheduled, confirmed_at, created_by, created_by_name, created_at, idempotency_key)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,CURRENT_TIMESTAMP,?12)`,
        [
          paymentId,
          installment.accountsPayableId,
          amountCents,
          paymentDate,
          paymentMethod,
          financeAccountId,
          notes,
          scheduled ? 1 : 0,
          scheduled ? "" : new Date().toISOString(),
          actor.id,
          actorName,
          idempotencyKey,
        ],
      ],
    ];

    if (!scheduled) {
      const newPaidAmount = installment.paidAmountCents + amountCents;
      const status = computeStoredStatus({
        originalAmountCents: installment.originalAmountCents,
        paidAmountCents: newPaidAmount,
        canceled: false,
        hasPendingSchedule: false,
      });
      statements.push([
        `UPDATE accounts_payable
         SET paid_amount_cents=?1, status=?2, updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP
         WHERE id=?5`,
        [newPaidAmount, status, actor.id, actorName, installment.accountsPayableId],
      ]);
      statements.push([
        `UPDATE supplier_invoice_installments
         SET paid_amount_cents=?1, finance_account_id=?2, payment_method=?3, updated_at=CURRENT_TIMESTAMP
         WHERE id=?4`,
        [newPaidAmount, financeAccountId, paymentMethod, installmentId],
      ]);
    } else {
      statements.push([
        `UPDATE accounts_payable
         SET status=(CASE WHEN status='open' THEN 'scheduled' ELSE status END),
             updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
        [actor.id, actorName, installment.accountsPayableId],
      ]);
    }

    const recalc = await buildInvoiceStatusRecalcStatement(database, invoice, actor.id, actorName);
    statements.push([recalc.sql, recalc.values]);
    statements.push(
      invoiceEventStatement({
        invoiceId: id,
        eventType: scheduled ? "payment_scheduled" : "payment_confirmed",
        description: `${scheduled ? "PAGAMENTO AGENDADO" : "PAGAMENTO CONFIRMADO"} NA DUPLICATA ${installment.installmentNumber}/${installment.installmentTotal}.`,
        metadata: { installmentId, amountCents },
        actorId: actor.id,
        actorName,
      }),
    );

    await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ created: true, id: paymentId, scheduled }, 201);
  } catch (error) {
    console.error("Não foi possível registrar o pagamento da duplicata.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR O PAGAMENTO." }, 500);
  }
}
