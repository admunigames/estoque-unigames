import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { todayInTimezone } from "../../../../../lib/finance-status";
import { computeInstallmentStatus, planInstallments } from "../../../../../lib/supplier-invoice-status";
import { identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../../shared";
import {
  DATE_PATTERN,
  assertFinanceAccountBelongsToCompany,
  assertSlotAvailableForPayable,
  recalcPayableEntrySql,
} from "../../../payables/shared";
import {
  assertInvoiceAccess,
  buildInvoiceStatusRecalcStatement,
  canReconcileInvoices,
  canViewInvoices,
  invoiceEventStatement,
  loadInstallments,
  loadInvoice,
  loadPendingScheduleIds,
  toInstallmentSnapshot,
} from "../../shared";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewInvoices(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER NOTAS FISCAIS." }, 403);
  }
  const { id } = await context.params;

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

    const installments = await loadInstallments(database, id);
    const pendingScheduleIds = await loadPendingScheduleIds(
      database,
      installments.map((installment) => installment.accountsPayableId),
    );
    const today = todayInTimezone();
    return jsonResponse({
      installments: installments.map((installment) => ({
        ...installment,
        status: computeInstallmentStatus(toInstallmentSnapshot(installment, pendingScheduleIds), today),
      })),
    });
  } catch (error) {
    console.error("Não foi possível carregar as duplicatas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS DUPLICATAS." }, 500);
  }
}

type Plan = { dueDate: string; amountCents: number; documentNumber: string };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canReconcileInvoices(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR DUPLICATAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const invoice = await loadInvoice(database, id);
    if (!invoice) return jsonResponse({ error: "NOTA FISCAL NÃO ENCONTRADA." }, 404);
    if (invoice.canceled) return jsonResponse({ error: "ESTA NOTA FISCAL ESTÁ CANCELADA." }, 409);
    if (!invoice.sentToFinanceAt) {
      return jsonResponse({ error: "ESTA NOTA FISCAL AINDA NÃO FOI ENVIADA AO FINANCEIRO." }, 409);
    }
    if (!invoice.financeItemId) {
      return jsonResponse({ error: "DEFINA O ITEM FINANCEIRO DA NF ANTES DE CADASTRAR DUPLICATAS." }, 400);
    }

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertInvoiceAccess(scopeActor, invoice);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const body = (await request.json()) as JsonMap;
    const paymentMethod = safeText(body.paymentMethod, 40);
    const financeAccountId = safeText(body.financeAccountId, 80);
    const accountError = await assertFinanceAccountBelongsToCompany(database, financeAccountId, invoice.companyId);
    if (accountError) return jsonResponse({ error: accountError }, 409);

    const mode = safeText(body.mode, 20) || "manual";
    let plans: Plan[];

    if (mode === "generate") {
      const installmentTotal = Math.trunc(Number(body.installmentTotal));
      if (!Number.isInteger(installmentTotal) || installmentTotal < 1 || installmentTotal > 120) {
        return jsonResponse({ error: "INFORME A QUANTIDADE DE PARCELAS (MÍNIMO 1)." }, 400);
      }
      const firstDueDate = safeText(body.firstDueDate, 10);
      const customDueDatesRaw = Array.isArray(body.customDueDates) ? body.customDueDates : undefined;
      const customDueDates = customDueDatesRaw?.map((value) => safeText(value, 10));
      if (customDueDates) {
        if (customDueDates.length !== installmentTotal || customDueDates.some((date) => !DATE_PATTERN.test(date))) {
          return jsonResponse({ error: "AS DATAS CUSTOMIZADAS DEVEM TER UMA POR PARCELA, TODAS VÁLIDAS." }, 400);
        }
      } else if (!DATE_PATTERN.test(firstDueDate)) {
        return jsonResponse({ error: "INFORME O 1º VENCIMENTO OU AS DATAS CUSTOMIZADAS." }, 400);
      }
      const amountCents = Number(body.amountCents ?? invoice.totalAmountCents);
      if (!Number.isFinite(amountCents) || !Number.isInteger(amountCents) || amountCents <= 0) {
        return jsonResponse({ error: "INFORME UM VALOR VÁLIDO PARA DISTRIBUIR NAS PARCELAS." }, 400);
      }
      const generated = planInstallments({ totalAmountCents: amountCents, installmentTotal, firstDueDate, customDueDates });
      plans = generated.map((entry) => ({ dueDate: entry.dueDate, amountCents: entry.amountCents, documentNumber: "" }));
    } else {
      const dueDate = safeText(body.dueDate, 10);
      if (!DATE_PATTERN.test(dueDate)) return jsonResponse({ error: "INFORME O VENCIMENTO DA DUPLICATA." }, 400);
      const amountCents = Number(body.originalAmountCents);
      if (!Number.isFinite(amountCents) || !Number.isInteger(amountCents) || amountCents <= 0) {
        return jsonResponse({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
      }
      plans = [{ dueDate, amountCents, documentNumber: safeText(body.documentNumber, 60) }];
    }

    const existing = await loadInstallments(database, id);
    const existingActive = existing.filter((installment) => !installment.canceled);
    const newInstallmentTotal = existingActive.length + plans.length;

    const conflict = await assertSlotAvailableForPayable(
      database,
      invoice.companyId,
      invoice.financeItemId,
      invoice.competenceMonth,
    );
    // Só bloqueia se o slot já não é usado por esta MESMA NF (as duplicatas
    // desta NF já ocupam o slot 'payable' legitimamente).
    if (conflict && existingActive.length === 0) return jsonResponse({ error: conflict }, 409);

    const actorName = actor.displayName || "Administrador";
    const boletoCode = safeText(body.boletoCode, 80);
    const notes = safeText(body.notes, 2000);
    const statements: [string, unknown[]][] = [];
    const createdIds: string[] = [];

    for (const existingInstallment of existingActive) {
      statements.push([
        `UPDATE supplier_invoice_installments SET installment_total=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2`,
        [newInstallmentTotal, existingInstallment.id],
      ]);
    }

    for (const [offset, plan] of plans.entries()) {
      const installmentNumber = existingActive.length + offset + 1;
      const payableId = crypto.randomUUID();
      const installmentId = crypto.randomUUID();
      const description = `NF ${invoice.invoiceNumber}${invoice.series ? "/" + invoice.series : ""} - PARCELA ${installmentNumber}/${newInstallmentTotal}`;
      const idempotencyKey = `invoice-installment:${installmentId}`;

      statements.push([
        `INSERT INTO accounts_payable
          (id, company_id, company_name, description, supplier_id, finance_item_id, finance_account_id,
           original_amount_cents, paid_amount_cents, issue_date, competence_month, due_date, payment_method,
           invoice_number, order_reference, billing_code, notes, status, installment_number, installment_total,
           idempotency_key, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8,?9,?10,?11,?12,?13,?14,?15,'open',?16,?17,?18,?19,?20,CURRENT_TIMESTAMP,?19,?20,CURRENT_TIMESTAMP)`,
        [
          payableId,
          invoice.companyId,
          invoice.companyName,
          description,
          invoice.supplierId,
          invoice.financeItemId,
          financeAccountId,
          invoice.issueDate,
          invoice.competenceMonth,
          plan.dueDate,
          paymentMethod,
          invoice.invoiceNumber,
          invoice.notionPurchaseId,
          boletoCode,
          notes,
          installmentNumber,
          newInstallmentTotal,
          idempotencyKey,
          actor.id,
          actorName,
        ],
      ]);

      statements.push([
        `INSERT INTO supplier_invoice_installments
          (id, invoice_id, company_id, installment_number, installment_total, document_number, due_date,
           original_amount_cents, paid_amount_cents, payment_method, finance_account_id, boleto_code, notes,
           accounts_payable_id, created_by, created_by_name, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?9,?10,?11,?12,?13,?14,?15,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [
          installmentId,
          id,
          invoice.companyId,
          installmentNumber,
          newInstallmentTotal,
          plan.documentNumber,
          plan.dueDate,
          plan.amountCents,
          paymentMethod,
          financeAccountId,
          boletoCode,
          notes,
          payableId,
          actor.id,
          actorName,
        ],
      ]);
      createdIds.push(installmentId);
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
        eventType: "installments_created",
        description: `${plans.length} DUPLICATA(S) CADASTRADA(S).`,
        actorId: actor.id,
        actorName,
      }),
    );

    await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));

    return jsonResponse({ created: true, ids: createdIds }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar as duplicatas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR AS DUPLICATAS." }, 500);
  }
}
