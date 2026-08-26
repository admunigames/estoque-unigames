import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { isValidCpfOrCnpj } from "../../../../lib/br-documents";
import { todayInTimezone } from "../../../../lib/finance-status";
import { computeInstallmentStatus, computeInstallmentTotals } from "../../../../lib/supplier-invoice-status";
import { identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { computeDreAnchorAssignments } from "../../../../lib/payables-recurrence";
import { recalcPayableEntrySql } from "../../payables/shared";
import {
  assertInvoiceAccess,
  buildInvoiceStatusRecalcStatement,
  canReconcileInvoices,
  canViewInvoices,
  invoiceEventStatement,
  loadInstallments,
  loadInvoice,
  loadInvoiceDreView,
  loadPendingScheduleIds,
  toInstallmentSnapshot,
} from "../shared";

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
    const installmentsView = installments.map((installment) => ({
      ...installment,
      status: computeInstallmentStatus(toInstallmentSnapshot(installment, pendingScheduleIds), today),
    }));

    const [attachments, events, payableIds] = await Promise.all([
      database
        .prepare(
          `SELECT id, invoice_id AS invoiceId, installment_id AS installmentId, payment_id AS paymentId,
                  attachment_type AS attachmentType, file_name AS fileName, content_type AS contentType,
                  size_bytes AS sizeBytes, uploaded_by_name AS uploadedByName, created_at AS createdAt
           FROM supplier_invoice_attachments WHERE invoice_id=?1
             OR installment_id IN (SELECT id FROM supplier_invoice_installments WHERE invoice_id=?1)
           ORDER BY created_at DESC`,
        )
        .bind(id)
        .all(),
      database
        .prepare(
          `SELECT id, event_type AS eventType, description, metadata_json AS metadataJson,
                  actor_name AS actorName, created_at AS createdAt
           FROM supplier_invoice_events WHERE invoice_id=?1 ORDER BY created_at DESC`,
        )
        .bind(id)
        .all(),
      Promise.resolve(installments.map((installment) => installment.accountsPayableId).filter(Boolean)),
    ]);

    let payments: unknown[] = [];
    if (payableIds.length) {
      const placeholders = payableIds.map((_, index) => `?${index + 1}`).join(",");
      const result = await database
        .prepare(
          `SELECT id, payable_id AS payableId, amount_cents AS amountCents, payment_date AS paymentDate,
                  payment_method AS paymentMethod, finance_account_id AS financeAccountId, notes,
                  scheduled, confirmed_at AS confirmedAt, created_by_name AS createdByName, created_at AS createdAt
           FROM accounts_payable_payments WHERE payable_id IN (${placeholders}) ORDER BY created_at DESC`,
        )
        .bind(...payableIds)
        .all();
      payments = result.results ?? [];
    }

    const totals = computeInstallmentTotals(invoice.totalAmountCents, installments);
    const dre = await loadInvoiceDreView(database, installments);

    return jsonResponse({
      invoice,
      installments: installmentsView,
      totals,
      payments,
      attachments: attachments.results ?? [],
      events: events.results ?? [],
      today,
      dre,
    });
  } catch (error) {
    console.error("Não foi possível carregar a nota fiscal.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A NOTA FISCAL." }, 500);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canReconcileInvoices(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR NOTAS FISCAIS." }, 403);
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

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertInvoiceAccess(scopeActor, invoice);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    const actorName = actor.displayName || "Administrador";

    if (action === "review") {
      if (invoice.financialStatus !== "aguardando_conferencia") {
        return jsonResponse({ error: "ESTA NOTA FISCAL NÃO ESTÁ AGUARDANDO CONFERÊNCIA." }, 409);
      }
      const recalc = await buildInvoiceStatusRecalcStatement(database, invoice, actor.id, actorName, {
        reviewed: true,
      });
      const statements = [
        [recalc.sql, recalc.values] as [string, unknown[]],
        invoiceEventStatement({
          invoiceId: id,
          eventType: "reviewed",
          description: "NOTA FISCAL CONFERIDA.",
          actorId: actor.id,
          actorName,
        }),
      ];
      await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
      return jsonResponse({ updated: true, financialStatus: recalc.nextStatus });
    }

    if (action === "cancel") {
      const installments = await loadInstallments(database, id);
      const statements: [string, unknown[]][] = [
        [
          `UPDATE supplier_invoices
           SET canceled=1, financial_status='cancelado', updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
           WHERE id=?3`,
          [actor.id, actorName, id],
        ],
        invoiceEventStatement({
          invoiceId: id,
          eventType: "canceled",
          description: safeText(body.reason, 500) || "NOTA FISCAL CANCELADA.",
          actorId: actor.id,
          actorName,
        }),
      ];
      for (const installment of installments) {
        if (installment.canceled || !installment.accountsPayableId) continue;
        statements.push([
          `UPDATE accounts_payable
           SET status='canceled', canceled_by=?1, canceled_by_name=?2, canceled_at=CURRENT_TIMESTAMP::text,
               updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
           WHERE id=?3`,
          [actor.id, actorName, installment.accountsPayableId],
        ]);
        statements.push([
          `UPDATE supplier_invoice_installments SET canceled=1, updated_at=CURRENT_TIMESTAMP WHERE id=?1`,
          [installment.id],
        ]);
      }
      const distinctMonths = [...new Set(installments.map(() => invoice.competenceMonth))];
      for (const month of distinctMonths) {
        const entryId = crypto.randomUUID();
        for (const [sql, values] of recalcPayableEntrySql(
          entryId,
          invoice.companyId,
          invoice.financeItemId,
          month,
          actor.id,
          actorName,
        )) {
          statements.push([sql, values]);
        }
      }
      await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
      return jsonResponse({ updated: true, canceled: true });
    }

    // Edição de campos — bloqueia mudar o valor total depois que já existem
    // duplicatas cadastradas (quebraria o invariante soma==total que o
    // financial_status calculado depende, e mudaria retroativamente o que
    // já foi lançado na DRE por uma soma que não corresponde mais a nada).
    const hasInstallments = (await loadInstallments(database, id)).length > 0;

    const supplierId = body.supplierId === undefined ? invoice.supplierId : safeText(body.supplierId, 80);
    const supplierDocument =
      body.supplierDocument === undefined ? invoice.supplierDocument : safeText(body.supplierDocument, 20);
    if (supplierDocument && !isValidCpfOrCnpj(supplierDocument)) {
      return jsonResponse({ error: "O CNPJ/CPF DO FORNECEDOR É INVÁLIDO." }, 400);
    }
    const financeCategoryId =
      body.financeCategoryId === undefined ? invoice.financeCategoryId : safeText(body.financeCategoryId, 80);
    const financeItemId = body.financeItemId === undefined ? invoice.financeItemId : safeText(body.financeItemId, 80);
    if (hasInstallments && financeItemId !== invoice.financeItemId) {
      return jsonResponse(
        { error: "NÃO É POSSÍVEL TROCAR O ITEM FINANCEIRO DEPOIS DE CADASTRAR DUPLICATAS." },
        409,
      );
    }
    let costCenter = invoice.costCenter;
    let costCenterId = invoice.costCenterId;
    if (body.costCenterId !== undefined) {
      costCenterId = safeText(body.costCenterId, 80) || null;
      if (costCenterId) {
        const costCenterRow = await database
          .prepare("SELECT name FROM finance_cost_centers WHERE id=?1")
          .bind(costCenterId)
          .first<{ name: string }>();
        if (!costCenterRow) return jsonResponse({ error: "CENTRO DE CUSTO NÃO ENCONTRADO." }, 400);
        costCenter = costCenterRow.name;
      } else {
        costCenter = "";
      }
    }
    const notes = body.notes === undefined ? invoice.notes : safeText(body.notes, 2000);
    const accessKey = body.accessKey === undefined ? invoice.accessKey : safeText(body.accessKey, 44);
    if (accessKey && !/^\d{44}$/.test(accessKey)) {
      return jsonResponse({ error: "A CHAVE DE ACESSO DA NF-E DEVE TER 44 DÍGITOS." }, 400);
    }
    const entryDate = body.entryDate === undefined ? invoice.entryDate : safeText(body.entryDate, 10);

    let totalAmountCents = invoice.totalAmountCents;
    if (body.totalAmountCents !== undefined) {
      if (hasInstallments) {
        return jsonResponse(
          { error: "NÃO É POSSÍVEL ALTERAR O VALOR TOTAL DEPOIS DE CADASTRAR DUPLICATAS." },
          409,
        );
      }
      totalAmountCents = Number(body.totalAmountCents);
      if (!Number.isFinite(totalAmountCents) || !Number.isInteger(totalAmountCents) || totalAmountCents <= 0) {
        return jsonResponse({ error: "INFORME UM VALOR TOTAL VÁLIDO EM CENTAVOS." }, 400);
      }
    }

    if (financeItemId) {
      const item = await database
        .prepare("SELECT id FROM finance_items WHERE id=?1")
        .bind(financeItemId)
        .first<{ id: string }>();
      if (!item) return jsonResponse({ error: "ITEM DE DESPESA NÃO ENCONTRADO NO CATÁLOGO FINANCEIRO." }, 400);
    }

    const statements: [string, unknown[]][] = [
      [
        `UPDATE supplier_invoices
         SET supplier_id=?1, supplier_document=?2, finance_category_id=?3, finance_item_id=?4, cost_center=?5,
             notes=?6, access_key=?7, entry_date=?8, total_amount_cents=?9,
             updated_by=?10, updated_by_name=?11, updated_at=CURRENT_TIMESTAMP, cost_center_id=?13
         WHERE id=?12`,
        [
          supplierId,
          supplierDocument,
          financeCategoryId,
          financeItemId,
          costCenter,
          notes,
          accessKey,
          entryDate,
          totalAmountCents,
          actor.id,
          actorName,
          id,
          costCenterId,
        ],
      ],
    ];

    // Decisão de "Incluir na DRE?" (opcional, nível da NF inteira) — só faz
    // sentido depois que já existem duplicatas cadastradas (é nelas que o
    // valor é gravado, na âncora = 1ª duplicata). Ver installments/route.ts
    // (POST) pra quando o toggle é definido junto da geração das duplicatas.
    let dreWarning: string | null = null;
    if (body.dreIncluded !== undefined) {
      const installmentsForDre = await loadInstallments(database, id);
      const activeInstallments = installmentsForDre.filter((installment) => !installment.canceled);
      if (!activeInstallments.length) {
        return jsonResponse(
          { error: "GERE AS DUPLICATAS ANTES DE DEFINIR A INCLUSÃO NA DRE DESTA NOTA FISCAL." },
          409,
        );
      }
      const dreIncludedFlag = Boolean(body.dreIncluded);
      const dreAmountCentsRaw = Number(body.dreAmountCents);
      if (!Number.isFinite(dreAmountCentsRaw) || !Number.isInteger(dreAmountCentsRaw) || dreAmountCentsRaw < 0) {
        return jsonResponse({ error: "INFORME UM VALOR VÁLIDO (EM CENTAVOS, NÃO NEGATIVO) PARA A DRE." }, 400);
      }
      const totalOriginal = activeInstallments.reduce((sum, installment) => sum + installment.originalAmountCents, 0);
      if (dreIncludedFlag && dreAmountCentsRaw > totalOriginal) {
        dreWarning = "O VALOR INFORMADO PARA A DRE É MAIOR QUE O VALOR TOTAL DA NOTA FISCAL.";
      }
      const orderedPayableIds = activeInstallments.map((installment) => installment.accountsPayableId).filter(Boolean);
      const assignments = computeDreAnchorAssignments(orderedPayableIds, dreIncludedFlag, dreAmountCentsRaw);
      for (const payableId of orderedPayableIds) {
        statements.push([
          `UPDATE accounts_payable SET dre_amount_cents=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4`,
          [assignments.get(payableId) ?? 0, actor.id, actorName, payableId],
        ]);
      }
      const entryId = crypto.randomUUID();
      for (const [sql, values] of recalcPayableEntrySql(
        entryId,
        invoice.companyId,
        financeItemId || invoice.financeItemId,
        invoice.competenceMonth,
        actor.id,
        actorName,
      )) {
        statements.push([sql, values]);
      }
    }

    await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));

    return jsonResponse({ updated: true, id, dreWarning });
  } catch (error) {
    console.error("Não foi possível editar a nota fiscal.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR A NOTA FISCAL." }, 500);
  }
}
