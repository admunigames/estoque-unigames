import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores } from "../../../../lib/access-scope";
import { computeStoredStatus, todayInTimezone } from "../../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, MONTH_PATTERN, type JsonMap } from "../../shared";
import {
  DATE_PATTERN,
  assertAccess,
  assertFinanceAccountBelongsToCompany,
  assertSlotAvailableForPayable,
  computeDreAnchorAssignments,
  dreViewFromGroup,
  loadPayable,
  loadPayableGroupRows,
  recalcPayableEntrySql,
  statusView,
} from "../shared";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const payable = await loadPayable(database, id);
    if (!payable) return jsonResponse({ error: "CONTA NÃO ENCONTRADA." }, 404);

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertAccess(scopeActor, payable);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const [payments, siblings] = await Promise.all([
      database
        .prepare(
          `SELECT id, amount_cents AS amountCents, payment_date AS paymentDate, payment_method AS paymentMethod,
                  finance_account_id AS financeAccountId, notes, scheduled, confirmed_at AS confirmedAt,
                  created_by_name AS createdByName, created_at AS createdAt
           FROM accounts_payable_payments WHERE payable_id=?1 ORDER BY created_at DESC`,
        )
        .bind(id)
        .all(),
      database
        .prepare(
          `SELECT id, description, original_amount_cents AS originalAmountCents, status
           FROM accounts_payable
           WHERE company_id=?1 AND finance_item_id=?2 AND competence_month=?3 AND status != 'canceled' AND id != ?4`,
        )
        .bind(payable.companyId, payable.financeItemId, payable.competenceMonth, id)
        .all(),
    ]);

    const today = todayInTimezone();
    const groupRows = await loadPayableGroupRows(database, payable);
    return jsonResponse({
      payable: { ...payable, ...statusView(payable.status, payable.dueDate, today) },
      payments: payments.results ?? [],
      dreOriginSiblings: siblings.results ?? [],
      dre: dreViewFromGroup(groupRows),
    });
  } catch (error) {
    console.error("Não foi possível carregar a conta a pagar.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A CONTA A PAGAR." }, 500);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR CONTAS A PAGAR." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const payable = await loadPayable(database, id);
    if (!payable) return jsonResponse({ error: "CONTA NÃO ENCONTRADA." }, 404);
    if (payable.status === "canceled") {
      return jsonResponse({ error: "ESTA CONTA ESTÁ CANCELADA E NÃO PODE SER EDITADA." }, 409);
    }

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertAccess(scopeActor, payable);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const body = (await request.json()) as JsonMap;

    const description = safeText(body.description, 200) || payable.description;
    const financeItemId = safeText(body.financeItemId, 80) || payable.financeItemId;
    const supplierId = body.supplierId === undefined ? payable.supplierId : safeText(body.supplierId, 80);
    const financeAccountId =
      body.financeAccountId === undefined ? payable.financeAccountId : safeText(body.financeAccountId, 80);
    const paymentMethod = body.paymentMethod === undefined ? payable.paymentMethod : safeText(body.paymentMethod, 40);
    const invoiceNumber = body.invoiceNumber === undefined ? payable.invoiceNumber : safeText(body.invoiceNumber, 60);
    const orderReference =
      body.orderReference === undefined ? payable.orderReference : safeText(body.orderReference, 60);
    const billingCode = body.billingCode === undefined ? payable.billingCode : safeText(body.billingCode, 80);
    const notes = body.notes === undefined ? payable.notes : safeText(body.notes, 2000);
    const issueDate = body.issueDate === undefined ? payable.issueDate : safeText(body.issueDate, 10);
    const dueDate = body.dueDate === undefined ? payable.dueDate : safeText(body.dueDate, 10);
    if (!DATE_PATTERN.test(dueDate)) return jsonResponse({ error: "VENCIMENTO INVÁLIDO." }, 400);
    if (issueDate && !DATE_PATTERN.test(issueDate)) return jsonResponse({ error: "DATA DE EMISSÃO INVÁLIDA." }, 400);

    const competenceMonth =
      body.competenceMonth === undefined ? payable.competenceMonth : safeText(body.competenceMonth, 7);
    if (!MONTH_PATTERN.test(competenceMonth)) {
      return jsonResponse({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);
    }

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

    const companyId = body.companyId === undefined ? payable.companyId : safeText(body.companyId, 80);
    const companyName = body.companyName === undefined ? payable.companyName : safeText(body.companyName, 160);
    const allStores = canSeeAllStores(scopeActor, "finance:manage");
    if (!allStores && companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ SÓ PODE MOVER A CONTA PARA A PRÓPRIA LOJA." }, 403);
    }

    const item = await database
      .prepare("SELECT id FROM finance_items WHERE id=?1")
      .bind(financeItemId)
      .first<{ id: string }>();
    if (!item) return jsonResponse({ error: "ITEM DE DESPESA NÃO ENCONTRADO NO CATÁLOGO FINANCEIRO." }, 400);

    const accountError = await assertFinanceAccountBelongsToCompany(database, financeAccountId, companyId);
    if (accountError) return jsonResponse({ error: accountError }, 409);

    const slotChanged =
      companyId !== payable.companyId ||
      financeItemId !== payable.financeItemId ||
      competenceMonth !== payable.competenceMonth;
    if (slotChanged) {
      const conflict = await assertSlotAvailableForPayable(database, companyId, financeItemId, competenceMonth);
      if (conflict) return jsonResponse({ error: conflict }, 409);
    }

    const hasPendingSchedule = await database
      .prepare(
        "SELECT COUNT(*) AS total FROM accounts_payable_payments WHERE payable_id=?1 AND scheduled=1 AND confirmed_at=''",
      )
      .bind(id)
      .first<{ total: number }>();
    const status = computeStoredStatus({
      originalAmountCents,
      paidAmountCents: payable.paidAmountCents,
      canceled: false,
      hasPendingSchedule: Number(hasPendingSchedule?.total ?? 0) > 0,
    });

    const actorName = actor.displayName || "Administrador";
    const statements: [string, unknown[]][] = [
      [
        `UPDATE accounts_payable
         SET company_id=?1, company_name=?2, description=?3, supplier_id=?4, finance_item_id=?5, finance_account_id=?6,
             original_amount_cents=?7, issue_date=?8, competence_month=?9, due_date=?10, payment_method=?11,
             invoice_number=?12, order_reference=?13, billing_code=?14, notes=?15, status=?16,
             updated_by=?17, updated_by_name=?18, updated_at=CURRENT_TIMESTAMP
         WHERE id=?19`,
        [
          companyId,
          companyName,
          description,
          supplierId,
          financeItemId,
          financeAccountId,
          originalAmountCents,
          issueDate,
          competenceMonth,
          dueDate,
          paymentMethod,
          invoiceNumber,
          orderReference,
          billingCode,
          notes,
          status,
          actor.id,
          actorName,
          id,
        ],
      ],
    ];

    // Decisão de "Incluir na DRE?" — só mexe em dre_amount_cents quando o
    // campo vem explicitamente na requisição (o usuário mexeu no toggle).
    // Reescreve TODAS as linhas do grupo (âncora + demais zeradas) na
    // mesma transação, e garante que a competência de CADA linha do grupo
    // entra na lista de recálculo — não só a da linha editada — porque uma
    // recorrência pode ter ocorrências em meses diferentes e todas
    // precisam refletir a nova decisão (mesmo as que ficaram zeradas).
    const slotKeySet = new Map<string, { companyId: string; financeItemId: string; month: string }>();
    function addSlot(slotCompanyId: string, slotFinanceItemId: string, slotMonth: string) {
      slotKeySet.set(`${slotCompanyId}::${slotFinanceItemId}::${slotMonth}`, {
        companyId: slotCompanyId,
        financeItemId: slotFinanceItemId,
        month: slotMonth,
      });
    }
    if (slotChanged) {
      addSlot(payable.companyId, payable.financeItemId, payable.competenceMonth);
    }
    addSlot(companyId, financeItemId, competenceMonth);

    let dreWarning: string | null = null;
    if (body.dreIncluded !== undefined) {
      const dreIncluded = Boolean(body.dreIncluded);
      const dreAmountCentsRaw = Number(body.dreAmountCents);
      if (!Number.isFinite(dreAmountCentsRaw) || !Number.isInteger(dreAmountCentsRaw) || dreAmountCentsRaw < 0) {
        return jsonResponse({ error: "INFORME UM VALOR VÁLIDO (EM CENTAVOS, NÃO NEGATIVO) PARA A DRE." }, 400);
      }
      const groupRows = await loadPayableGroupRows(database, payable);
      const totalOriginal = groupRows.reduce((sum, row) => sum + row.originalAmountCents, 0);
      if (dreIncluded && dreAmountCentsRaw > totalOriginal) {
        dreWarning = "O VALOR INFORMADO PARA A DRE É MAIOR QUE O VALOR TOTAL DA CONTA.";
      }
      const orderedIds = groupRows.map((row) => row.id);
      const assignments = computeDreAnchorAssignments(orderedIds, dreIncluded, dreAmountCentsRaw);
      for (const row of groupRows) {
        statements.push([
          `UPDATE accounts_payable SET dre_amount_cents=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4`,
          [assignments.get(row.id) ?? 0, actor.id, actorName, row.id],
        ]);
        // A linha que está sendo editada agora já reflete companyId/
        // financeItemId/competenceMonth NOVOS (statement acima na mesma
        // transação); as demais do grupo mantêm seu próprio slot.
        const rowSlot =
          row.id === payable.id
            ? { companyId, financeItemId, month: competenceMonth }
            : { companyId: payable.companyId, financeItemId: payable.financeItemId, month: row.competenceMonth };
        addSlot(rowSlot.companyId, rowSlot.financeItemId, rowSlot.month);
      }
    }

    for (const slot of slotKeySet.values()) {
      const entryId = crypto.randomUUID();
      for (const [sql, sqlValues] of recalcPayableEntrySql(
        entryId,
        slot.companyId,
        slot.financeItemId,
        slot.month,
        actor.id,
        actorName,
      )) {
        statements.push([sql, sqlValues]);
      }
    }

    const prepared = statements.map(([sql, sqlValues]) => database.prepare(sql).bind(...sqlValues));
    await database.batch(prepared);

    return jsonResponse({ updated: true, id, dreWarning });
  } catch (error) {
    console.error("Não foi possível editar a conta a pagar.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR A CONTA A PAGAR." }, 500);
  }
}

