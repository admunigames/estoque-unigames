import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { quickViewDueRange, todayInTimezone, type QuickView } from "../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, MONTH_PATTERN, type JsonMap } from "../shared";
import {
  DATE_PATTERN,
  RECURRENCE_FREQUENCIES,
  assertFinanceAccountBelongsToCompany,
  assertSlotAvailableForPayable,
  competenceMonthOf,
  displayStatusCaseSql,
  generateInstallmentDueDates,
  generateRecurrenceDueDates,
  recalcPayableEntrySql,
  splitIntoInstallments,
  type RecurrenceFrequency,
} from "./shared";

type ListRow = Record<string, unknown>;

const SORTABLE_COLUMNS: Record<string, string> = {
  dueDate: "due_date",
  competenceMonth: "competence_month",
  description: "description",
  originalAmountCents: "original_amount_cents",
  paidAmountCents: "paid_amount_cents",
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
  const today = todayInTimezone();

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
  const financeAccountId = safeText(params.get("financeAccountId"), 80);
  if (financeAccountId) addCondition("finance_account_id = ?", financeAccountId);
  const paymentMethod = safeText(params.get("paymentMethod"), 40);
  if (paymentMethod) addCondition("payment_method = ?", paymentMethod);
  const invoiceNumber = safeText(params.get("invoiceNumber"), 60);
  if (invoiceNumber) addCondition("invoice_number = ?", invoiceNumber);
  const orderReference = safeText(params.get("orderReference"), 60);
  if (orderReference) addCondition("order_reference = ?", orderReference);
  if (params.get("recurring") === "1") addCondition("recurrence_id IS NOT NULL");
  if (params.get("installment") === "1") addCondition("installment_group_id IS NOT NULL");

  const issueFrom = safeText(params.get("issueFrom"), 10);
  const issueTo = safeText(params.get("issueTo"), 10);
  if (DATE_PATTERN.test(issueFrom)) addCondition("issue_date >= ?", issueFrom);
  if (DATE_PATTERN.test(issueTo)) addCondition("issue_date <= ?", issueTo);

  const competenceFrom = safeText(params.get("competenceFrom"), 7);
  const competenceTo = safeText(params.get("competenceTo"), 7);
  if (MONTH_PATTERN.test(competenceFrom)) addCondition("competence_month >= ?", competenceFrom);
  if (MONTH_PATTERN.test(competenceTo)) addCondition("competence_month <= ?", competenceTo);

  const dueFrom = safeText(params.get("dueFrom"), 10);
  const dueTo = safeText(params.get("dueTo"), 10);
  if (DATE_PATTERN.test(dueFrom)) addCondition("due_date >= ?", dueFrom);
  if (DATE_PATTERN.test(dueTo)) addCondition("due_date <= ?", dueTo);

  const paymentFrom = safeText(params.get("paymentFrom"), 10);
  const paymentTo = safeText(params.get("paymentTo"), 10);
  if (DATE_PATTERN.test(paymentFrom) || DATE_PATTERN.test(paymentTo)) {
    const from = DATE_PATTERN.test(paymentFrom) ? paymentFrom : "0000-01-01";
    const to = DATE_PATTERN.test(paymentTo) ? paymentTo : "9999-12-31";
    addCondition(
      `EXISTS (SELECT 1 FROM accounts_payable_payments p WHERE p.payable_id = accounts_payable.id
        AND p.confirmed_at <> '' AND p.payment_date >= ? AND p.payment_date <= ?)`,
      from,
      to,
    );
  }

  const search = safeText(params.get("search"), 120);
  if (search) {
    addCondition(
      `(description ILIKE ? OR invoice_number ILIKE ? OR order_reference ILIKE ? OR billing_code ILIKE ?
        OR EXISTS (SELECT 1 FROM finance_suppliers s WHERE s.id = accounts_payable.supplier_id AND s.name ILIKE ?))`,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
    );
  }

  values.push(today);
  const todayIndex = values.length;
  const displayStatusSql = displayStatusCaseSql(todayIndex);
  // A query de totais não seleciona displayStatusSql (só a de linhas usa,
  // no SELECT) — sem essa condição neutra, quando nenhum filtro de status/
  // quickView está ativo, o parâmetro "hoje" fica sem nenhuma referência no
  // WHERE e o Postgres rejeita o bind ("supplies N parameters, but ...
  // requires N-1"). Mantém os dois SELECTs (totais e linhas) sempre com a
  // mesma contagem de parâmetros vinculados.
  // Cast explícito: um parâmetro bind sozinho (`?N IS NOT NULL`) sem
  // nenhum operador que dê contexto de tipo faz o Postgres recusar com
  // "could not determine data type of parameter" — o cast resolve isso.
  conditions.push(`?${todayIndex}::text IS NOT NULL`);

  const status = safeText(params.get("status"), 20);
  if (status) {
    values.push(status);
    conditions.push(`${displayStatusSql} = ?${values.length}`);
  }

  const quickView = safeText(params.get("quickView"), 20);
  if (quickView) {
    const range = quickViewDueRange(quickView as QuickView, today);
    if (range) {
      addCondition("due_date >= ?", range.from);
      addCondition("due_date <= ?", range.to);
      conditions.push(`${displayStatusSql} != 'canceled'`);
    } else if (quickView === "overdue") {
      values.push("overdue");
      conditions.push(`${displayStatusSql} = ?${values.length}`);
    } else if (quickView === "paid") {
      conditions.push("status = 'paid'");
    }
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
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(original_amount_cents), 0) AS originalCents,
                COALESCE(SUM(paid_amount_cents), 0) AS paidCents,
                COALESCE(SUM(original_amount_cents - paid_amount_cents), 0) AS balanceCents
         FROM accounts_payable ${whereSql}`,
      )
      .bind(...values)
      .first<{ count: number; originalCents: number; paidCents: number; balanceCents: number }>();

    const rowsValues = [...values, pageSize, (page - 1) * pageSize];
    const rows = await database
      .prepare(
        `SELECT id, company_id AS companyId, company_name AS companyName, description,
                supplier_id AS supplierId, finance_item_id AS financeItemId, finance_account_id AS financeAccountId,
                original_amount_cents AS originalAmountCents, paid_amount_cents AS paidAmountCents,
                issue_date AS issueDate, competence_month AS competenceMonth, due_date AS dueDate,
                payment_method AS paymentMethod, invoice_number AS invoiceNumber, order_reference AS orderReference,
                billing_code AS billingCode, notes, status,
                recurrence_id AS recurrenceId, recurrence_frequency AS recurrenceFrequency,
                installment_group_id AS installmentGroupId, installment_number AS installmentNumber,
                installment_total AS installmentTotal, expense_id AS expenseId, cost_center AS costCenter,
                ${displayStatusSql} AS displayStatus,
                created_at AS createdAt, updated_at AS updatedAt
         FROM accounts_payable
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
        paidCents: Number(totalsRow?.paidCents ?? 0),
        balanceCents: Number(totalsRow?.balanceCents ?? 0),
      },
      today,
    });
  } catch (error) {
    console.error("Não foi possível carregar as contas a pagar.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS CONTAS A PAGAR." }, 500);
  }
}

type PayablePlanRow = {
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
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR CONTAS A PAGAR." }, 403);
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
      return jsonResponse({ error: "VOCÊ SÓ PODE CADASTRAR CONTAS PARA A PRÓPRIA LOJA." }, 403);
    }

    const description = safeText(body.description, 200);
    if (description.length < 2) return jsonResponse({ error: "INFORME A DESCRIÇÃO DA CONTA." }, 400);

    const financeItemId = safeText(body.financeItemId, 80);
    if (!financeItemId) return jsonResponse({ error: "SELECIONE A CATEGORIA/ITEM DA DESPESA." }, 400);

    const supplierId = safeText(body.supplierId, 80);
    const financeAccountId = safeText(body.financeAccountId, 80);
    const paymentMethod = safeText(body.paymentMethod, 40);
    const invoiceNumber = safeText(body.invoiceNumber, 60);
    const orderReference = safeText(body.orderReference, 60);
    const billingCode = safeText(body.billingCode, 80);
    const notes = safeText(body.notes, 2000);
    const issueDate = safeText(body.issueDate, 10);
    if (issueDate && !DATE_PATTERN.test(issueDate)) {
      return jsonResponse({ error: "DATA DE EMISSÃO INVÁLIDA." }, 400);
    }

    const firstDueDate = safeText(body.dueDate, 10);
    if (!DATE_PATTERN.test(firstDueDate)) return jsonResponse({ error: "INFORME O VENCIMENTO." }, 400);

    const totalAmountCents = Number(body.originalAmountCents);
    if (!Number.isFinite(totalAmountCents) || !Number.isInteger(totalAmountCents) || totalAmountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
    }

    const kind = safeText(body.kind, 20) || "single"; // 'single' | 'installment' | 'recurring'
    const database = await getD1();

    const item = await database
      .prepare("SELECT id FROM finance_items WHERE id=?1")
      .bind(financeItemId)
      .first<{ id: string }>();
    if (!item) return jsonResponse({ error: "ITEM DE DESPESA NÃO ENCONTRADO NO CATÁLOGO FINANCEIRO." }, 400);

    const accountError = await assertFinanceAccountBelongsToCompany(database, financeAccountId, companyId);
    if (accountError) return jsonResponse({ error: accountError }, 409);

    const existingByKey = await database
      .prepare("SELECT id FROM accounts_payable WHERE idempotency_key=?1")
      .bind(idempotencyKey)
      .first<{ id: string }>();
    if (existingByKey) {
      return jsonResponse({ created: true, alreadyProcessed: true, ids: [existingByKey.id] });
    }

    let plan: PayablePlanRow[];
    let recurrenceId: string | null = null;
    let installmentGroupId: string | null = null;
    let recurrenceFrequency = "";
    let recurrenceOccurrenceCount: number | null = null;
    let recurrenceEndDate = "";

    if (kind === "installment") {
      const installmentTotal = Math.trunc(Number(body.installmentTotal));
      if (!Number.isInteger(installmentTotal) || installmentTotal < 2 || installmentTotal > 360) {
        return jsonResponse({ error: "INFORME A QUANTIDADE DE PARCELAS (MÍNIMO 2)." }, 400);
      }
      const amounts = splitIntoInstallments(totalAmountCents, installmentTotal);
      const dueDates = generateInstallmentDueDates(firstDueDate, installmentTotal);
      installmentGroupId = crypto.randomUUID();
      plan = dueDates.map((dueDate, index) => ({
        dueDate,
        competenceMonth: competenceMonthOf(dueDate),
        amountCents: amounts[index],
        installmentNumber: index + 1,
        installmentTotal,
        recurrenceIndex: 0,
      }));
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
      const dueDates = generateRecurrenceDueDates({
        firstDueDate,
        frequency,
        occurrenceCount,
        endDate,
      });
      recurrenceId = crypto.randomUUID();
      recurrenceFrequency = frequency;
      recurrenceOccurrenceCount = occurrenceCount;
      recurrenceEndDate = endDate;
      plan = dueDates.map((dueDate, index) => ({
        dueDate,
        competenceMonth: competenceMonthOf(dueDate),
        amountCents: totalAmountCents,
        installmentNumber: 0,
        installmentTotal: 0,
        recurrenceIndex: index,
      }));
    } else {
      plan = [
        {
          dueDate: firstDueDate,
          competenceMonth: competenceMonthOf(firstDueDate),
          amountCents: totalAmountCents,
          installmentNumber: 0,
          installmentTotal: 0,
          recurrenceIndex: 0,
        },
      ];
    }

    // Confere ANTES de escrever se algum slot loja+item+mês da série já é
    // ocupado por um lançamento manual da DRE — falha tudo, sem criar nada
    // pela metade (parcelamento/recorrência é tudo ou nada).
    const distinctMonths = [...new Set(plan.map((entry) => entry.competenceMonth))];
    for (const month of distinctMonths) {
      const conflict = await assertSlotAvailableForPayable(database, companyId, financeItemId, month);
      if (conflict) return jsonResponse({ error: conflict }, 409);
    }

    const statements: [string, unknown[]][] = [];
    const createdIds: string[] = [];
    const actorName = actor.displayName || "Administrador";

    for (const occurrence of plan) {
      const id = crypto.randomUUID();
      createdIds.push(id);
      statements.push([
        `INSERT INTO accounts_payable
          (id, company_id, company_name, description, supplier_id, finance_item_id, finance_account_id,
           original_amount_cents, paid_amount_cents, issue_date, competence_month, due_date, payment_method,
           invoice_number, order_reference, billing_code, notes, status,
           recurrence_id, recurrence_frequency, recurrence_occurrence_index, recurrence_occurrence_count, recurrence_end_date,
           installment_group_id, installment_number, installment_total, idempotency_key,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?9,?10,?11,?12,?13,?14,?15,?16,'open',
           ?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,CURRENT_TIMESTAMP,?26,?27,CURRENT_TIMESTAMP)`,
        [
          id,
          companyId,
          companyName,
          description,
          supplierId,
          financeItemId,
          financeAccountId,
          occurrence.amountCents,
          issueDate,
          occurrence.competenceMonth,
          occurrence.dueDate,
          paymentMethod,
          invoiceNumber,
          orderReference,
          billingCode,
          notes,
          recurrenceId,
          recurrenceFrequency,
          occurrence.recurrenceIndex,
          recurrenceOccurrenceCount,
          recurrenceEndDate,
          installmentGroupId,
          occurrence.installmentNumber,
          occurrence.installmentTotal,
          // idempotencyKey único por linha: a chave enviada pelo cliente vale
          // pra 1ª ocorrência; as demais recebem uma derivada determinística,
          // então reenviar a mesma requisição nunca duplica a série inteira.
          occurrence.recurrenceIndex === 0 && occurrence.installmentNumber <= 1
            ? idempotencyKey
            : `${idempotencyKey}:${occurrence.recurrenceIndex}:${occurrence.installmentNumber}`,
          actor.id,
          actorName,
        ],
      ]);
    }

    for (const month of distinctMonths) {
      const entryId = crypto.randomUUID();
      for (const [sql, sqlValues] of recalcPayableEntrySql(entryId, companyId, financeItemId, month, actor.id, actorName)) {
        statements.push([sql, sqlValues]);
      }
    }

    const prepared = statements.map(([sql, sqlValues]) => database.prepare(sql).bind(...sqlValues));
    await database.batch(prepared);

    return jsonResponse({ created: true, ids: createdIds }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a conta a pagar.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A CONTA A PAGAR." }, 500);
  }
}
