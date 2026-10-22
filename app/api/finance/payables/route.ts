import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { quickViewDueRange, todayInTimezone, type QuickView } from "../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, MONTH_PATTERN, type JsonMap } from "../shared";
import { DATE_PATTERN, displayStatusCaseSql } from "./shared";
import { planPayableCreate } from "./create";

// Filtro "SEM LOJA" (escritório / PF / outros) da listagem.
const NO_COMPANY_FILTER = "__none__";

type ListRow = Record<string, unknown>;
type PayableUnit = {
  key: string;
  expenseId?: string;
  dueDate?: string;
  slices: Array<{ id: string; status: string; originalCents: number; paidCents: number }>;
};

const LIST_COLUMNS = `id, company_id AS companyId, company_name AS companyName, description,
  supplier_id AS supplierId, finance_item_id AS financeItemId, finance_account_id AS financeAccountId,
  original_amount_cents AS originalAmountCents, paid_amount_cents AS paidAmountCents,
  dre_amount_cents AS dreAmountCents,
  issue_date AS issueDate, competence_month AS competenceMonth, due_date AS dueDate,
  payment_method AS paymentMethod, invoice_number AS invoiceNumber, order_reference AS orderReference,
  billing_code AS billingCode, notes, status,
  recurrence_id AS recurrenceId, recurrence_frequency AS recurrenceFrequency,
  installment_group_id AS installmentGroupId, installment_number AS installmentNumber,
  installment_total AS installmentTotal, expense_id AS expenseId, cost_center AS costCenter,
  cost_center_id AS costCenterId, dre_target AS dreTarget, payer_name AS payerName,
  created_at AS createdAt, updated_at AS updatedAt`;

/**
 * Linha agrupada de uma despesa rateada (mesmo vencimento): descrição e loja
 * da DESPESA, soma das fatias e situação do conjunto — CANCELADO se todas
 * canceladas; PAGO se todas (não canceladas) pagas; PARCIALMENTE PAGO se
 * misto; senão a situação mais urgente das fatias.
 */
function buildPayableGroupRow(
  key: string,
  expense: { description: string; companyId: string; companyName: string } | undefined,
  slices: ListRow[],
): ListRow {
  const first = slices[0] ?? {};
  const live = slices.filter((slice) => slice.status !== "canceled");
  const counted = live.length ? live : slices;
  const sum = (field: string) => counted.reduce((total, slice) => total + Number(slice[field] || 0), 0);
  let displayStatus: string;
  if (!live.length) displayStatus = "canceled";
  else if (live.every((slice) => slice.status === "paid")) displayStatus = "paid";
  else if (live.some((slice) => Number(slice.paidAmountCents || 0) > 0)) displayStatus = "partially_paid";
  else {
    const order = ["overdue", "due_today", "scheduled", "upcoming"];
    displayStatus = order.find((status) => live.some((slice) => slice.displayStatus === status)) ?? String(live[0].displayStatus);
  }
  return {
    ...first,
    id: key,
    isGroup: true,
    groupIds: slices.map((slice) => slice.id),
    description: expense?.description ?? first.description,
    companyId: expense?.companyId ?? first.companyId,
    companyName: expense?.companyName ?? first.companyName,
    originalAmountCents: sum("originalAmountCents"),
    paidAmountCents: sum("paidAmountCents"),
    status: displayStatus === "canceled" ? "canceled" : displayStatus === "paid" ? "paid" : "open",
    displayStatus,
    shares: slices.map((slice) => ({
      id: slice.id,
      companyId: slice.companyId,
      companyName: slice.companyName,
      originalAmountCents: slice.originalAmountCents,
      paidAmountCents: slice.paidAmountCents,
      status: slice.status,
      displayStatus: slice.displayStatus,
    })),
  };
}

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
      // Só o "?" ainda sem número (um fragmento pode ter mais de um).
      fragment = fragment.replace(/\?(?!\d)/, `?${values.length}`);
    }
    conditions.push(fragment);
  }

  // Despesa rateada (visão agrupada): com a loja filtrada, a despesa aparece
  // se a loja for a da despesa OU uma das lojas do rateio. Login de loja
  // continua vendo só as fatias da própria loja.
  if (effectiveCompanyId === NO_COMPANY_FILTER && allStores) {
    addCondition("company_id = ''");
  } else if (effectiveCompanyId && allStores) {
    addCondition(
      "(company_id = ? OR expense_id IN (SELECT id FROM expenses WHERE rateio_type = 'rateio' AND company_id = ?))",
      effectiveCompanyId,
      effectiveCompanyId,
    );
  } else if (effectiveCompanyId) {
    addCondition("company_id = ?", effectiveCompanyId);
  }
  const supplierId = safeText(params.get("supplierId"), 80);
  if (supplierId) addCondition("supplier_id = ?", supplierId);
  const financeItemId = safeText(params.get("financeItemId"), 80);
  if (financeItemId) addCondition("finance_item_id = ?", financeItemId);
  const financeAccountId = safeText(params.get("financeAccountId"), 80);
  if (financeAccountId) addCondition("finance_account_id = ?", financeAccountId);
  const costCenterId = safeText(params.get("costCenterId"), 80);
  if (costCenterId) addCondition("cost_center_id = ?", costCenterId);
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
      `(LOWER(description) LIKE LOWER(?) OR LOWER(invoice_number) LIKE LOWER(?) OR LOWER(order_reference) LIKE LOWER(?)
        OR LOWER(billing_code) LIKE LOWER(?) OR LOWER(payer_name) LIKE LOWER(?)
        OR EXISTS (SELECT 1 FROM finance_suppliers s WHERE s.id = accounts_payable.supplier_id AND LOWER(s.name) LIKE LOWER(?)))`,
      `%${search}%`,
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
  conditions.push(`CAST(?${todayIndex} AS TEXT) IS NOT NULL`);

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

    // Visão agrupada (despesa rateada = UMA linha por despesa + vencimento,
    // com as fatias por loja em shares[]); o banco e a DRE continuam por loja.
    // ponytail: lê id/valores de TODAS as contas do filtro para paginar por
    // linha agrupada; paginar no SQL se passar de dezenas de milhares.
    const matched = await database
      .prepare(
        `SELECT id, due_date AS dueDate, status, original_amount_cents AS originalCents, paid_amount_cents AS paidCents,
                (SELECT e.id FROM expenses e WHERE e.id = accounts_payable.expense_id AND e.rateio_type = 'rateio') AS rateioExpenseId
         FROM accounts_payable ${whereSql}
         ORDER BY ${sortField} ${sortDirection}, id ASC
         LIMIT 20000`,
      )
      .bind(...values)
      .all<{ id: string; dueDate: string; status: string; originalCents: number; paidCents: number; rateioExpenseId: string | null }>();
    const units: PayableUnit[] = [];
    const unitByKey = new Map<string, PayableUnit>();
    for (const row of matched.results ?? []) {
      const key = row.rateioExpenseId ? `grp:${row.rateioExpenseId}:${row.dueDate}` : row.id;
      if (unitByKey.has(key)) continue;
      const unit: PayableUnit = row.rateioExpenseId
        ? { key, expenseId: row.rateioExpenseId, dueDate: row.dueDate, slices: [] }
        : { key, slices: [row] };
      unitByKey.set(key, unit);
      units.push(unit);
    }
    // Fatias de cada grupo: todas as da despesa no mesmo vencimento (dentro do escopo do login).
    const groupExpenseIds = [...new Set(units.filter((unit) => unit.expenseId).map((unit) => unit.expenseId as string))];
    const scopeSql = allStores ? "" : " AND company_id = ?1";
    const scopeValues = allStores ? [] : [scopeActor.companyId];
    for (let index = 0; index < groupExpenseIds.length; index += 500) {
      const chunk = groupExpenseIds.slice(index, index + 500);
      const offset = scopeValues.length;
      const sliceRows = await database
        .prepare(
          `SELECT id, expense_id AS expenseId, due_date AS dueDate, status, original_amount_cents AS originalCents,
                  paid_amount_cents AS paidCents
           FROM accounts_payable WHERE expense_id IN (${chunk.map((_, i) => `?${i + offset + 1}`).join(",")})${scopeSql}`,
        )
        .bind(...scopeValues, ...chunk)
        .all<{ id: string; expenseId: string; dueDate: string; status: string; originalCents: number; paidCents: number }>();
      for (const slice of sliceRows.results ?? []) unitByKey.get(`grp:${slice.expenseId}:${slice.dueDate}`)?.slices.push(slice);
    }

    // Totais sem as canceladas: CONTAS = linhas (agrupadas) com algo não
    // cancelado; CANCELADAS = linhas inteiramente canceladas.
    const totals = { count: 0, canceledCount: 0, originalCents: 0, paidCents: 0, balanceCents: 0 };
    for (const unit of units) {
      const live = unit.slices.filter((slice) => slice.status !== "canceled");
      if (!live.length) { totals.canceledCount += 1; continue; }
      totals.count += 1;
      for (const slice of live) {
        totals.originalCents += Number(slice.originalCents);
        totals.paidCents += Number(slice.paidCents);
        totals.balanceCents += Number(slice.originalCents) - Number(slice.paidCents);
      }
    }

    const pageUnits = units.slice((page - 1) * pageSize, page * pageSize);
    const pageIds = pageUnits.flatMap((unit) => unit.slices.map((slice) => slice.id));
    const fullRows = pageIds.length
      ? await database
          .prepare(
            `SELECT ${LIST_COLUMNS}, ${displayStatusCaseSql(1)} AS displayStatus
             FROM accounts_payable WHERE id IN (${pageIds.map((_, i) => `?${i + 2}`).join(",")})`,
          )
          .bind(today, ...pageIds)
          .all<ListRow>()
      : { results: [] as ListRow[] };
    const rowById = new Map((fullRows.results ?? []).map((row) => [String(row.id), row]));
    const pageExpenseIds = [...new Set(pageUnits.filter((unit) => unit.expenseId).map((unit) => unit.expenseId as string))];
    const expenses = pageExpenseIds.length
      ? await database
          .prepare(
            `SELECT id, description, company_id AS companyId, company_name AS companyName FROM expenses
             WHERE id IN (${pageExpenseIds.map((_, i) => `?${i + 1}`).join(",")})`,
          )
          .bind(...pageExpenseIds)
          .all<{ id: string; description: string; companyId: string; companyName: string }>()
      : { results: [] };
    const expenseById = new Map((expenses.results ?? []).map((row) => [row.id, row]));
    const rows = pageUnits.map((unit) => {
      const slices = unit.slices.map((slice) => rowById.get(slice.id)).filter((row): row is ListRow => Boolean(row));
      if (!unit.expenseId) return slices[0];
      return buildPayableGroupRow(unit.key, expenseById.get(unit.expenseId), slices);
    });

    return jsonResponse({
      rows,
      page,
      pageSize,
      total: units.length,
      totals,
      today,
    });
  } catch (error) {
    console.error("Não foi possível carregar as contas a pagar.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS CONTAS A PAGAR." }, 500);
  }
}


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
    const database = await getD1();
    const plan = await planPayableCreate(database, actor, scopeActor, allStores, body);
    if ("reply" in plan) return jsonResponse(plan.reply.payload, plan.reply.status);
    const { statements, ids: createdIds, dreWarning } = plan;

    const prepared = statements.map(([sql, sqlValues]) => database.prepare(sql).bind(...sqlValues));
    await database.batch(prepared);

    return jsonResponse({ created: true, ids: createdIds, dreWarning }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a conta a pagar.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A CONTA A PAGAR." }, 500);
  }
}
