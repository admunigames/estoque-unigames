import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";
import { DATE_PATTERN, EXPENSE_SELECT_COLUMNS, MONTH_PATTERN, planExpense } from "./shared";

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
  const costCenterId = safeText(params.get("costCenterId"), 80);
  if (costCenterId) addCondition("cost_center_id = ?", costCenterId);
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
    const database = await getD1();
    const plan = await planExpense(database, actor, { allStores, companyId: scopeActor.companyId }, body);
    if ("reply" in plan) return jsonResponse(plan.reply.payload, plan.reply.status);
    const { expenseId, statements, payableIds: createdPayableIds, dreWarning } = plan;
    const prepared = statements.map(([sql, sqlValues]) => database.prepare(sql).bind(...sqlValues));
    await database.batch(prepared);

    return jsonResponse({ created: true, id: expenseId, payableIds: createdPayableIds, dreWarning }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a despesa.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A DESPESA." }, 500);
  }
}
