import { getD1 } from "../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../lib/notion";
import { identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../../../shared";
import { DATE_PATTERN, assertFinanceAccountBelongsToCompany, recalcPayableEntrySql } from "../../../../payables/shared";
import {
  assertInvoiceAccess,
  buildInvoiceStatusRecalcStatement,
  canReconcileInvoices,
  invoiceEventStatement,
  loadInvoice,
  type InstallmentRow,
  INSTALLMENT_ROW_SELECT,
} from "../../../shared";

async function loadInstallment(
  database: Awaited<ReturnType<typeof getD1>>,
  id: string,
): Promise<InstallmentRow | null> {
  return database
    .prepare(`SELECT ${INSTALLMENT_ROW_SELECT} FROM supplier_invoice_installments WHERE id=?1`)
    .bind(id)
    .first<InstallmentRow>();
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; installmentId: string }> },
) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canReconcileInvoices(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR DUPLICATAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id, installmentId } = await context.params;

  try {
    const database = await getD1();
    const invoice = await loadInvoice(database, id);
    if (!invoice) return jsonResponse({ error: "NOTA FISCAL NÃO ENCONTRADA." }, 404);
    const installment = await loadInstallment(database, installmentId);
    if (!installment || installment.invoiceId !== id) {
      return jsonResponse({ error: "DUPLICATA NÃO ENCONTRADA." }, 404);
    }
    if (installment.canceled) return jsonResponse({ error: "ESTA DUPLICATA ESTÁ CANCELADA." }, 409);
    if (installment.paidAmountCents > 0) {
      return jsonResponse({ error: "NÃO É POSSÍVEL EDITAR UMA DUPLICATA QUE JÁ RECEBEU PAGAMENTO." }, 409);
    }

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertInvoiceAccess(scopeActor, invoice);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const body = (await request.json()) as JsonMap;
    const dueDate = body.dueDate === undefined ? installment.dueDate : safeText(body.dueDate, 10);
    if (!DATE_PATTERN.test(dueDate)) return jsonResponse({ error: "VENCIMENTO INVÁLIDO." }, 400);
    const originalAmountCents =
      body.originalAmountCents === undefined ? installment.originalAmountCents : Number(body.originalAmountCents);
    if (!Number.isFinite(originalAmountCents) || !Number.isInteger(originalAmountCents) || originalAmountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
    }
    const documentNumber =
      body.documentNumber === undefined ? installment.documentNumber : safeText(body.documentNumber, 60);
    const paymentMethod = body.paymentMethod === undefined ? installment.paymentMethod : safeText(body.paymentMethod, 40);
    const financeAccountId =
      body.financeAccountId === undefined ? installment.financeAccountId : safeText(body.financeAccountId, 80);
    const accountError = await assertFinanceAccountBelongsToCompany(database, financeAccountId, invoice.companyId);
    if (accountError) return jsonResponse({ error: accountError }, 409);
    const boletoCode = body.boletoCode === undefined ? installment.boletoCode : safeText(body.boletoCode, 80);
    const notes = body.notes === undefined ? installment.notes : safeText(body.notes, 2000);

    const actorName = actor.displayName || "Administrador";
    const statements: [string, unknown[]][] = [
      [
        `UPDATE supplier_invoice_installments
         SET due_date=?1, original_amount_cents=?2, document_number=?3, payment_method=?4, finance_account_id=?5,
             boleto_code=?6, notes=?7, updated_at=CURRENT_TIMESTAMP
         WHERE id=?8`,
        [dueDate, originalAmountCents, documentNumber, paymentMethod, financeAccountId, boletoCode, notes, installmentId],
      ],
    ];
    if (installment.accountsPayableId) {
      statements.push([
        `UPDATE accounts_payable
         SET due_date=?1, original_amount_cents=?2, invoice_number=?3, payment_method=?4, finance_account_id=?5,
             billing_code=?6, notes=?7, updated_by=?8, updated_by_name=?9, updated_at=CURRENT_TIMESTAMP
         WHERE id=?10`,
        [
          dueDate,
          originalAmountCents,
          invoice.invoiceNumber,
          paymentMethod,
          financeAccountId,
          boletoCode,
          notes,
          actor.id,
          actorName,
          installment.accountsPayableId,
        ],
      ]);
    }
    if (originalAmountCents !== installment.originalAmountCents) {
      const entryId = crypto.randomUUID();
      for (const [sql, values] of recalcPayableEntrySql(
        entryId,
        invoice.companyId,
        invoice.financeItemId,
        invoice.competenceMonth,
        actor.id,
        actorName,
      )) {
        statements.push([sql, values]);
      }
    }
    const recalc = await buildInvoiceStatusRecalcStatement(database, invoice, actor.id, actorName);
    statements.push([recalc.sql, recalc.values]);

    await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ updated: true, id: installmentId });
  } catch (error) {
    console.error("Não foi possível editar a duplicata.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR A DUPLICATA." }, 500);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; installmentId: string }> },
) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canReconcileInvoices(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR DUPLICATAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id, installmentId } = await context.params;

  try {
    const database = await getD1();
    const invoice = await loadInvoice(database, id);
    if (!invoice) return jsonResponse({ error: "NOTA FISCAL NÃO ENCONTRADA." }, 404);
    const installment = await loadInstallment(database, installmentId);
    if (!installment || installment.invoiceId !== id) {
      return jsonResponse({ error: "DUPLICATA NÃO ENCONTRADA." }, 404);
    }
    if (installment.canceled) return jsonResponse({ error: "ESTA DUPLICATA JÁ ESTÁ CANCELADA." }, 409);
    if (installment.paidAmountCents > 0) {
      return jsonResponse({ error: "NÃO É POSSÍVEL EXCLUIR UMA DUPLICATA QUE JÁ RECEBEU PAGAMENTO." }, 409);
    }

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertInvoiceAccess(scopeActor, invoice);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const actorName = actor.displayName || "Administrador";
    const statements: [string, unknown[]][] = [
      [
        `UPDATE supplier_invoice_installments SET canceled=1, updated_at=CURRENT_TIMESTAMP WHERE id=?1`,
        [installmentId],
      ],
    ];
    if (installment.accountsPayableId) {
      statements.push([
        `UPDATE accounts_payable
         SET status='canceled', canceled_by=?1, canceled_by_name=?2, canceled_at=CURRENT_TIMESTAMP::text,
             updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
        [actor.id, actorName, installment.accountsPayableId],
      ]);
    }
    const entryId = crypto.randomUUID();
    for (const [sql, values] of recalcPayableEntrySql(
      entryId,
      invoice.companyId,
      invoice.financeItemId,
      invoice.competenceMonth,
      actor.id,
      actorName,
    )) {
      statements.push([sql, values]);
    }
    const recalc = await buildInvoiceStatusRecalcStatement(database, invoice, actor.id, actorName);
    statements.push([recalc.sql, recalc.values]);
    statements.push(
      invoiceEventStatement({
        invoiceId: id,
        eventType: "installment_deleted",
        description: `DUPLICATA ${installment.installmentNumber}/${installment.installmentTotal} EXCLUÍDA.`,
        actorId: actor.id,
        actorName,
      }),
    );

    await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a duplicata.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A DUPLICATA." }, 500);
  }
}
