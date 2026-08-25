import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";
import {
  DATE_PATTERN,
  MONTH_PATTERN,
  RATEIO_MODELS,
  RATEIO_TYPES,
  RECURRENCE_FREQUENCIES,
  assertFinanceAccountBelongsToCompany,
  assertSlotAvailableForPayable,
  competenceMonthOf,
  generateInstallmentDueDates,
  generateRecurrenceDueDates,
  recalcPayableEntrySql,
  splitIntoInstallments,
  type RateioModel,
  type RateioType,
  type RecurrenceFrequency,
  EXPENSE_SELECT_COLUMNS,
} from "./shared";
import { computeRateioShares } from "./rateio";

type ListRow = Record<string, unknown>;

const SORTABLE_COLUMNS: Record<string, string> = {
  dueDate: "due_date",
  competenceMonth: "competence_month",
  description: "description",
  originalAmountCents: "original_amount_cents",
  createdAt: "created_at",
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

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
  const params = url.searchParams;

  const companyId = safeText(params.get("companyId"), 80);
  if (!allStores && companyId && companyId !== scopeActor.companyId) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
  }
  const effectiveCompanyId = allStores ? companyId : scopeActor.companyId;

  const conditions: string[] = [];
  const values: unknown[] = [];
  function addCondition(sqlFragment: string, ...args: unknown[]) {
    let fragment = sqlFragment;
    for (const arg of args) {
      values.push(arg);
      fragment = fragment.replace("?", `?${values.length}`);
    }
    conditions.push(fragment);
  }

  if (effectiveCompanyId) addCondition("company_id = ?", effectiveCompanyId);
  const supplierId = safeText(params.get("supplierId"), 80);
  if (supplierId) addCondition("supplier_id = ?", supplierId);
  const financeItemId = safeText(params.get("financeItemId"), 80);
  if (financeItemId) addCondition("finance_item_id = ?", financeItemId);
  const costCenter = safeText(params.get("costCenter"), 80);
  if (costCenter) addCondition("cost_center = ?", costCenter);
  const kind = safeText(params.get("kind"), 20);
  if (kind) addCondition("kind = ?", kind);
  const rateioType = safeText(params.get("rateioType"), 20);
  if (rateioType) addCondition("rateio_type = ?", rateioType);

  const competenceFrom = safeText(params.get("competenceFrom"), 7);
  const competenceTo = safeText(params.get("competenceTo"), 7);
  if (MONTH_PATTERN.test(competenceFrom)) addCondition("competence_month >= ?", competenceFrom);
  if (MONTH_PATTERN.test(competenceTo)) addCondition("competence_month <= ?", competenceTo);

  const dueFrom = safeText(params.get("dueFrom"), 10);
  const dueTo = safeText(params.get("dueTo"), 10);
  if (DATE_PATTERN.test(dueFrom)) addCondition("due_date >= ?", dueFrom);
  if (DATE_PATTERN.test(dueTo)) addCondition("due_date <= ?", dueTo);

  const search = safeText(params.get("search"), 120);
  if (search) {
    addCondition(
      `(description ILIKE ? OR invoice_number ILIKE ? OR order_reference ILIKE ?
        OR EXISTS (SELECT 1 FROM finance_suppliers s WHERE s.id = expenses.supplier_id AND s.name ILIKE ?))`,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
    );
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(params.get("pageSize")) || 20));
  const sortField = SORTABLE_COLUMNS[params.get("sort") || ""] || "due_date";
  const sortDirection = params.get("dir") === "desc" ? "DESC" : "ASC";

  try {
    const database = await getD1();

    const totalsRow = await database
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(original_amount_cents), 0) AS originalCents
         FROM expenses ${whereSql}`,
      )
      .bind(...values)
      .first<{ count: number; originalCents: number }>();

    const rowsValues = [...values, pageSize, (page - 1) * pageSize];
    const rows = await database
      .prepare(
        `SELECT ${EXPENSE_SELECT_COLUMNS},
                (SELECT COUNT(*) FROM accounts_payable ap WHERE ap.expense_id = expenses.id) AS linkedPayablesCount,
                (SELECT COALESCE(SUM(ap.paid_amount_cents), 0) FROM accounts_payable ap WHERE ap.expense_id = expenses.id) AS paidAmountCents
         FROM expenses
         ${whereSql}
         ORDER BY ${sortField} ${sortDirection}, id ASC
         LIMIT ?${values.length + 1} OFFSET ?${values.length + 2}`,
      )
      .bind(...rowsValues)
      .all<ListRow>();

    return jsonResponse({
      rows: rows.results ?? [],
      page,
      pageSize,
      total: Number(totalsRow?.count ?? 0),
      totals: {
        count: Number(totalsRow?.count ?? 0),
        originalCents: Number(totalsRow?.originalCents ?? 0),
      },
    });
  } catch (error) {
    console.error("Não foi possível carregar as despesas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS DESPESAS." }, 500);
  }
}

type ExpensePlanRow = {
  dueDate: string;
  competenceMonth: string;
  amountCents: number;
  installmentNumber: number;
  installmentTotal: number;
  recurrenceIndex: number;
};

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR DESPESAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");

  try {
    const body = (await request.json()) as JsonMap;
    const idempotencyKey = safeText(body.idempotencyKey, 120);
    if (!idempotencyKey) return jsonResponse({ error: "REQUISIÇÃO INVÁLIDA (SEM CHAVE DE IDEMPOTÊNCIA)." }, 400);

    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 160);
    if (!companyId) return jsonResponse({ error: "SELECIONE A EMPRESA/LOJA." }, 400);
    if (!allStores && companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ SÓ PODE CADASTRAR DESPESAS PARA A PRÓPRIA LOJA." }, 403);
    }

    const description = safeText(body.description, 200);
    if (description.length < 2) return jsonResponse({ error: "INFORME A DESCRIÇÃO DA DESPESA." }, 400);

    const financeItemId = safeText(body.financeItemId, 80);
    if (!financeItemId) return jsonResponse({ error: "SELECIONE A CATEGORIA/SUBCATEGORIA DA DESPESA." }, 400);

    const supplierId = safeText(body.supplierId, 80);
    const financeAccountId = safeText(body.financeAccountId, 80);
    const costCenter = safeText(body.costCenter, 120);
    const paymentMethod = safeText(body.paymentMethod, 40);
    const invoiceNumber = safeText(body.invoiceNumber, 60);
    const orderReference = safeText(body.orderReference, 60);
    const notes = safeText(body.notes, 2000);
    const cardId = safeText(body.cardId, 80);
    const bankReconciliationId = safeText(body.bankReconciliationId, 80);
    const issueDate = safeText(body.issueDate, 10);
    if (issueDate && !DATE_PATTERN.test(issueDate)) {
      return jsonResponse({ error: "DATA INVÁLIDA." }, 400);
    }

    const firstDueDate = safeText(body.dueDate, 10);
    if (!DATE_PATTERN.test(firstDueDate)) return jsonResponse({ error: "INFORME O VENCIMENTO." }, 400);

    const totalAmountCents = Number(body.originalAmountCents);
    if (!Number.isFinite(totalAmountCents) || !Number.isInteger(totalAmountCents) || totalAmountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
    }

    const rateioType = (safeText(body.rateioType, 20) || "single_store") as RateioType;
    if (!RATEIO_TYPES.includes(rateioType)) {
      return jsonResponse({ error: "CLASSIFICAÇÃO DE RATEIO INVÁLIDA." }, 400);
    }
    const rateioModel = safeText(body.rateioModel, 20) as RateioModel | "";
    if (rateioType === "rateio") {
      if (!rateioModel || !RATEIO_MODELS.includes(rateioModel)) {
        return jsonResponse({ error: "SELECIONE O MODELO DE RATEIO." }, 400);
      }
      // Rateio gera obrigações em outras lojas além da selecionada acima —
      // isso é esperado e faz parte da regra de negócio (o rateio existe
      // justamente pra dividir entre lojas). A trava de acesso é só
      // canManageFinance (ter permissão de Financeiro), verificada no topo
      // desta rota — o Financeiro é um módulo à parte cujo acesso já é
      // concedido pelo administrador principal a quem precisar, então não
      // faz sentido restringir rateio a quem "enxerga todas as lojas" em
      // outros módulos (ver [[estoque_modulo_despesas_rateio]]).
    }

    const kind = (safeText(body.kind, 20) || "single") as "single" | "installment" | "recurring";
    const database = await getD1();

    const item = await database
      .prepare("SELECT id FROM finance_items WHERE id=?1")
      .bind(financeItemId)
      .first<{ id: string }>();
    if (!item) return jsonResponse({ error: "ITEM DE DESPESA NÃO ENCONTRADO NO CATÁLOGO FINANCEIRO." }, 400);

    const accountError = await assertFinanceAccountBelongsToCompany(database, financeAccountId, companyId);
    if (accountError) return jsonResponse({ error: accountError }, 409);

    const existingByKey = await database
      .prepare("SELECT id FROM expenses WHERE idempotency_key=?1")
      .bind(idempotencyKey)
      .first<{ id: string }>();
    if (existingByKey) {
      return jsonResponse({ created: true, alreadyProcessed: true, id: existingByKey.id });
    }

    // dueDatesForPlan/recorrência/parcelamento são decididos uma vez só —
    // NÃO dependem do valor, então valem igual pra cada loja quando a
    // despesa é rateada (mesmas datas, valor de cada ocorrência
    // proporcional à fatia da loja). buildPlanForAmount() aplica um valor
    // (o total da despesa quando não é rateada, ou a fatia de cada loja
    // quando é) sobre essas mesmas datas.
    let dueDatesForPlan: string[];
    let recurrenceId: string | null = null;
    let installmentGroupId: string | null = null;
    let recurrenceFrequency = "";
    let recurrenceOccurrenceCount: number | null = null;
    let recurrenceEndDate = "";
    let installmentTotalPlan = 0;
    let singleCompetenceMonth = "";

    if (kind === "installment") {
      const installmentTotal = Math.trunc(Number(body.installmentTotal));
      if (!Number.isInteger(installmentTotal) || installmentTotal < 2 || installmentTotal > 360) {
        return jsonResponse({ error: "INFORME A QUANTIDADE DE PARCELAS (MÍNIMO 2)." }, 400);
      }
      installmentTotalPlan = installmentTotal;
      dueDatesForPlan = generateInstallmentDueDates(firstDueDate, installmentTotal);
      installmentGroupId = crypto.randomUUID();
    } else if (kind === "recurring") {
      const frequency = safeText(body.recurrenceFrequency, 20) as RecurrenceFrequency;
      if (!RECURRENCE_FREQUENCIES.includes(frequency)) {
        return jsonResponse({ error: "FREQUÊNCIA DE RECORRÊNCIA INVÁLIDA." }, 400);
      }
      const occurrenceCountRaw = body.recurrenceOccurrenceCount;
      const occurrenceCount =
        occurrenceCountRaw === undefined || occurrenceCountRaw === null || occurrenceCountRaw === ""
          ? null
          : Math.trunc(Number(occurrenceCountRaw));
      const endDate = safeText(body.recurrenceEndDate, 10);
      if (!occurrenceCount && !DATE_PATTERN.test(endDate)) {
        return jsonResponse(
          { error: "INFORME A QUANTIDADE DE OCORRÊNCIAS OU UMA DATA FINAL DA RECORRÊNCIA." },
          400,
        );
      }
      if (occurrenceCount !== null && (!Number.isInteger(occurrenceCount) || occurrenceCount < 1 || occurrenceCount > 260)) {
        return jsonResponse({ error: "QUANTIDADE DE OCORRÊNCIAS INVÁLIDA." }, 400);
      }
      dueDatesForPlan = generateRecurrenceDueDates({ firstDueDate, frequency, occurrenceCount, endDate });
      recurrenceId = crypto.randomUUID();
      recurrenceFrequency = frequency;
      recurrenceOccurrenceCount = occurrenceCount;
      recurrenceEndDate = endDate;
    } else {
      // Só a despesa avulsa aceita competência explícita (a mesma
      // possibilidade que Contas a Pagar já dá na edição) — parcelamento e
      // recorrência sempre derivam a competência de cada vencimento gerado,
      // pra cada ocorrência cair no mês certo da DRE.
      const competenceOverride = safeText(body.competenceMonth, 7);
      singleCompetenceMonth = MONTH_PATTERN.test(competenceOverride) ? competenceOverride : competenceMonthOf(firstDueDate);
      dueDatesForPlan = [firstDueDate];
    }

    function buildPlanForAmount(amountCents: number): ExpensePlanRow[] {
      if (kind === "installment") {
        const amounts = splitIntoInstallments(amountCents, installmentTotalPlan);
        return dueDatesForPlan.map((dueDate, index) => ({
          dueDate,
          competenceMonth: competenceMonthOf(dueDate),
          amountCents: amounts[index],
          installmentNumber: index + 1,
          installmentTotal: installmentTotalPlan,
          recurrenceIndex: 0,
        }));
      }
      if (kind === "recurring") {
        return dueDatesForPlan.map((dueDate, index) => ({
          dueDate,
          competenceMonth: competenceMonthOf(dueDate),
          amountCents,
          installmentNumber: 0,
          installmentTotal: 0,
          recurrenceIndex: index,
        }));
      }
      return [
        {
          dueDate: firstDueDate,
          competenceMonth: singleCompetenceMonth,
          amountCents,
          installmentNumber: 0,
          installmentTotal: 0,
          recurrenceIndex: 0,
        },
      ];
    }

    const primaryCompetenceMonth =
      kind === "single" ? singleCompetenceMonth : competenceMonthOf(dueDatesForPlan[0]);

    type ExpenseShare = { companyId: string; companyName: string; amountCents: number; percentBasisPoints: number };
    let shares: ExpenseShare[];
    if (rateioType === "rateio") {
      const customShares = Array.isArray(body.rateioShares)
        ? (body.rateioShares as JsonMap[]).map((entry) => ({
            companyId: safeText(entry.companyId, 80),
            percentBasisPoints: Math.round(Number(entry.percentBasisPoints)),
          }))
        : undefined;
      const rateioResult = await computeRateioShares(database, {
        model: rateioModel as RateioModel,
        competenceMonth: primaryCompetenceMonth,
        totalAmountCents,
        customShares,
      });
      if ("error" in rateioResult) return jsonResponse({ error: rateioResult.error }, 409);
      shares = rateioResult.shares;
    } else {
      shares = [{ companyId, companyName, amountCents: totalAmountCents, percentBasisPoints: 0 }];
    }

    const sharePlans = shares.map((share) => ({ share, plan: buildPlanForAmount(share.amountCents) }));

    const distinctSlots = new Set<string>();
    for (const { share, plan } of sharePlans) {
      for (const occurrence of plan) distinctSlots.add(share.companyId + "::" + occurrence.competenceMonth);
    }
    for (const slot of distinctSlots) {
      const [slotCompanyId, month] = slot.split("::");
      const conflict = await assertSlotAvailableForPayable(database, slotCompanyId, financeItemId, month);
      if (conflict) return jsonResponse({ error: conflict }, 409);
    }

    const expenseId = crypto.randomUUID();
    const actorName = actor.displayName || "Administrador";
    const statements: [string, unknown[]][] = [];

    statements.push([
      `INSERT INTO expenses
        (id, company_id, company_name, description, supplier_id, finance_item_id, finance_account_id,
         cost_center, original_amount_cents, issue_date, competence_month, due_date, payment_method,
         invoice_number, order_reference, notes, kind, installment_total,
         recurrence_frequency, recurrence_occurrence_count, recurrence_end_date,
         rateio_type, rateio_model, card_id, bank_reconciliation_id, idempotency_key,
         created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,CURRENT_TIMESTAMP,?27,?28,CURRENT_TIMESTAMP)`,
      [
        expenseId,
        companyId,
        companyName,
        description,
        supplierId,
        financeItemId,
        financeAccountId,
        costCenter,
        totalAmountCents,
        issueDate,
        primaryCompetenceMonth,
        firstDueDate,
        paymentMethod,
        invoiceNumber,
        orderReference,
        notes,
        kind,
        installmentGroupId ? installmentTotalPlan : 0,
        recurrenceFrequency,
        recurrenceOccurrenceCount,
        recurrenceEndDate,
        rateioType,
        rateioModel || "",
        cardId,
        bankReconciliationId,
        idempotencyKey,
        actor.id,
        actorName,
      ],
    ]);

    const createdPayableIds: string[] = [];
    for (let shareIndex = 0; shareIndex < sharePlans.length; shareIndex += 1) {
      const { share, plan } = sharePlans[shareIndex];
      if (rateioType === "rateio") {
        statements.push([
          `INSERT INTO expense_rateio_shares (id, expense_id, company_id, company_name, percent_basis_points, amount_cents, created_at)
           VALUES (?1,?2,?3,?4,?5,?6,CURRENT_TIMESTAMP)`,
          [
            crypto.randomUUID(),
            expenseId,
            share.companyId,
            share.companyName,
            share.percentBasisPoints,
            share.amountCents,
          ],
        ]);
      }
      for (const occurrence of plan) {
        const payableId = crypto.randomUUID();
        createdPayableIds.push(payableId);
        statements.push([
          `INSERT INTO accounts_payable
            (id, company_id, company_name, description, supplier_id, finance_item_id, finance_account_id,
             cost_center, original_amount_cents, paid_amount_cents, issue_date, competence_month, due_date, payment_method,
             invoice_number, order_reference, billing_code, notes, status,
             recurrence_id, recurrence_frequency, recurrence_occurrence_index, recurrence_occurrence_count, recurrence_end_date,
             installment_group_id, installment_number, installment_total, expense_id, idempotency_key,
             created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,0,?10,?11,?12,?13,?14,?15,'',?16,'open',
             ?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,CURRENT_TIMESTAMP,?27,?28,CURRENT_TIMESTAMP)`,
          [
            payableId,
            share.companyId,
            share.companyName,
            description,
            supplierId,
            financeItemId,
            financeAccountId,
            costCenter,
            occurrence.amountCents,
            issueDate,
            occurrence.competenceMonth,
            occurrence.dueDate,
            paymentMethod,
            invoiceNumber,
            orderReference,
            notes,
            recurrenceId,
            recurrenceFrequency,
            occurrence.recurrenceIndex,
            recurrenceOccurrenceCount,
            recurrenceEndDate,
            installmentGroupId,
            occurrence.installmentNumber,
            occurrence.installmentTotal,
            expenseId,
            // idempotencyKey própria por linha (loja + ocorrência) — não
            // colide com contas criadas direto em Contas a Pagar nem entre
            // lojas diferentes do mesmo rateio.
            `expense:${idempotencyKey}:${shareIndex}:${occurrence.recurrenceIndex}:${occurrence.installmentNumber}`,
            actor.id,
            actorName,
          ],
        ]);
      }
    }

    for (const slot of distinctSlots) {
      const [slotCompanyId, month] = slot.split(" ");
      const entryId = crypto.randomUUID();
      for (const [sql, sqlValues] of recalcPayableEntrySql(entryId, slotCompanyId, financeItemId, month, actor.id, actorName)) {
        statements.push([sql, sqlValues]);
      }
    }

    const prepared = statements.map(([sql, sqlValues]) => database.prepare(sql).bind(...sqlValues));
    await database.batch(prepared);

    return jsonResponse({ created: true, id: expenseId, payableIds: createdPayableIds }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a despesa.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A DESPESA." }, 500);
  }
}
