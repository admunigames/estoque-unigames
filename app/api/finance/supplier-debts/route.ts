import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { todayInTimezone } from "../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";
import { canManageSupplierDebts } from "./shared";
import { planSupplierDebtCreate } from "./create";

type ListRow = Record<string, unknown>;

// CASE de status de exibição escrita direto contra ap.status/ap.due_date
// (mesma precedência de app/lib/finance-status.ts#computeDisplayStatus) —
// não reaproveita displayStatusCaseSql (app/lib/payables-recurrence.ts)
// porque aquela função assume os nomes de coluna sem prefixo de tabela
// (pensada pra consultar accounts_payable diretamente), e aqui a tabela
// principal do SELECT é supplier_open_debts com accounts_payable em JOIN.
function debtDisplayStatusSql(todayParamIndex: number): string {
  const p = `?${todayParamIndex}`;
  return `CASE
    WHEN ap.status = 'canceled' THEN 'canceled'
    WHEN ap.status = 'paid' THEN 'paid'
    WHEN ap.due_date < ${p} THEN 'overdue'
    WHEN ap.due_date = ${p} THEN 'due_today'
    WHEN ap.status = 'partially_paid' THEN 'partially_paid'
    WHEN ap.status = 'scheduled' THEN 'scheduled'
    ELSE 'upcoming'
  END`;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageSupplierDebts(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR FORNECEDORES EM ABERTO." }, 403);
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

  // "__none__" = SEM LOJA (escritório / PF / outros).
  if (effectiveCompanyId === "__none__") addCondition("sod.company_id = ''");
  else if (effectiveCompanyId) addCondition("sod.company_id = ?", effectiveCompanyId);
  const supplierId = safeText(params.get("supplierId"), 80);
  if (supplierId) addCondition("sod.supplier_id = ?", supplierId);

  const search = safeText(params.get("search"), 120);
  if (search) {
    addCondition(
      "(sod.supplier_name ILIKE ? OR sod.description ILIKE ? OR sod.invoice_number ILIKE ? OR sod.order_reference ILIKE ?)",
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
    );
  }

  values.push(today);
  const todayIndex = values.length;
  const displayStatusSql = debtDisplayStatusSql(todayIndex);
  // Sem status/quickView escolhido, o parâmetro "hoje" pode ficar sem
  // referência no WHERE — mesma proteção usada em payables/route.ts.
  conditions.push(`?${todayIndex}::text IS NOT NULL`);

  const status = safeText(params.get("status"), 20);
  if (status) {
    values.push(status);
    conditions.push(`${displayStatusSql} = ?${values.length}`);
  } else {
    // "TODOS (EM ABERTO)" no front — exclui canceladas E quitadas, não só canceladas.
    conditions.push("sod.canceled = 0 AND ap.status != 'paid'");
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(params.get("pageSize")) || 20));

  try {
    const database = await getD1();

    const totalsRow = await database
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(ap.original_amount_cents), 0) AS originalCents,
                COALESCE(SUM(ap.paid_amount_cents), 0) AS paidCents,
                COALESCE(SUM(ap.original_amount_cents - ap.paid_amount_cents), 0) AS balanceCents
         FROM supplier_open_debts sod
         JOIN accounts_payable ap ON ap.id = sod.accounts_payable_id
         ${whereSql}`,
      )
      .bind(...values)
      .first<{ count: number; originalCents: number; paidCents: number; balanceCents: number }>();

    const rowsValues = [...values, pageSize, (page - 1) * pageSize];
    const rows = await database
      .prepare(
        `SELECT sod.id, sod.company_id AS companyId, sod.company_name AS companyName,
                sod.supplier_id AS supplierId, sod.supplier_name AS supplierName,
                sod.invoice_number AS invoiceNumber, sod.supplier_invoice_id AS supplierInvoiceId,
                sod.order_reference AS orderReference, sod.purchase_date AS purchaseDate,
                sod.description, sod.due_date AS dueDate, sod.notes,
                sod.accounts_payable_id AS accountsPayableId, sod.canceled, sod.payer_name AS payerName,
                sod.created_at AS createdAt, sod.updated_at AS updatedAt,
                ap.original_amount_cents AS originalAmountCents, ap.paid_amount_cents AS paidAmountCents,
                ap.status AS payableStatus,
                ${displayStatusSql} AS displayStatus
         FROM supplier_open_debts sod
         JOIN accounts_payable ap ON ap.id = sod.accounts_payable_id
         ${whereSql}
         ORDER BY sod.due_date ASC, sod.id ASC
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
    console.error("Não foi possível carregar as dívidas de fornecedores.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS DÍVIDAS DE FORNECEDORES." }, 500);
  }
}

// Cria a dívida avulsa (supplier_open_debts) e sua accounts_payable "gêmea"
// na MESMA transação — mesmo padrão de app/api/finance/invoices/[id]/installments/route.ts.
// financeItemId é opcional na requisição: quando ausente, usa o item genérico
// semeado pela migration 0034 (ver DEFAULT_SUPPLIER_DEBT_FINANCE_ITEM_ID).
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR DÍVIDAS DE FORNECEDORES." }, 403);
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
    const plan = await planSupplierDebtCreate(database, actor, scopeActor, allStores, body);
    if ("reply" in plan) return jsonResponse(plan.reply.payload, plan.reply.status);
    const { statements, debtId, payableId } = plan;

    await database.batch(statements.map(([sql, sqlValues]) => database.prepare(sql).bind(...sqlValues)));

    return jsonResponse({ created: true, id: debtId, accountsPayableId: payableId }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a dívida de fornecedor.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A DÍVIDA DE FORNECEDOR." }, 500);
  }
}
