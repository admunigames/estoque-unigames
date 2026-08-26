import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { todayInTimezone } from "../../../lib/finance-status";
import { assertFinanceAccountBelongsToCompany, DATE_PATTERN, recalcPayableEntrySql } from "../payables/shared";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";
import { canManageSupplierDebts, DEFAULT_SUPPLIER_DEBT_FINANCE_ITEM_ID } from "./shared";

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
      fragment = fragment.replace("?", `?${values.length}`);
    }
    conditions.push(fragment);
  }

  if (effectiveCompanyId) addCondition("sod.company_id = ?", effectiveCompanyId);
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
                sod.accounts_payable_id AS accountsPayableId, sod.canceled,
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
    const idempotencyKey = safeText(body.idempotencyKey, 120);
    if (!idempotencyKey) return jsonResponse({ error: "REQUISIÇÃO INVÁLIDA (SEM CHAVE DE IDEMPOTÊNCIA)." }, 400);

    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 160);
    if (!companyId) return jsonResponse({ error: "SELECIONE A EMPRESA/LOJA." }, 400);
    if (!allStores && companyId !== scopeActor.companyId) {
      return jsonResponse({ error: "VOCÊ SÓ PODE CADASTRAR DÍVIDAS PARA A PRÓPRIA LOJA." }, 403);
    }

    const supplierId = safeText(body.supplierId, 80);
    if (!supplierId) return jsonResponse({ error: "SELECIONE O FORNECEDOR." }, 400);

    const description = safeText(body.description, 200);
    if (description.length < 2) return jsonResponse({ error: "INFORME A DESCRIÇÃO DA DÍVIDA." }, 400);

    const dueDate = safeText(body.dueDate, 10);
    if (!DATE_PATTERN.test(dueDate)) return jsonResponse({ error: "INFORME A DATA PREVISTA DE PAGAMENTO." }, 400);

    const purchaseDate = safeText(body.purchaseDate, 10);
    if (purchaseDate && !DATE_PATTERN.test(purchaseDate)) {
      return jsonResponse({ error: "DATA DA COMPRA INVÁLIDA." }, 400);
    }

    const originalAmountCents = Number(body.originalAmountCents);
    if (!Number.isFinite(originalAmountCents) || !Number.isInteger(originalAmountCents) || originalAmountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR VÁLIDO EM CENTAVOS." }, 400);
    }

    const invoiceNumber = safeText(body.invoiceNumber, 60);
    const supplierInvoiceId = safeText(body.supplierInvoiceId, 80);
    const orderReference = safeText(body.orderReference, 60);
    const notes = safeText(body.notes, 2000);
    const financeItemId = safeText(body.financeItemId, 80) || DEFAULT_SUPPLIER_DEBT_FINANCE_ITEM_ID;
    const financeAccountId = safeText(body.financeAccountId, 80);

    const database = await getD1();

    const [supplier, item] = await Promise.all([
      database.prepare("SELECT id, name FROM finance_suppliers WHERE id=?1").bind(supplierId).first<{ id: string; name: string }>(),
      database.prepare("SELECT id FROM finance_items WHERE id=?1").bind(financeItemId).first<{ id: string }>(),
    ]);
    if (!supplier) return jsonResponse({ error: "FORNECEDOR NÃO ENCONTRADO NO CADASTRO." }, 400);
    if (!item) return jsonResponse({ error: "ITEM FINANCEIRO NÃO ENCONTRADO NO CATÁLOGO." }, 400);

    const accountError = await assertFinanceAccountBelongsToCompany(database, financeAccountId, companyId);
    if (accountError) return jsonResponse({ error: accountError }, 409);

    if (supplierInvoiceId) {
      const invoice = await database
        .prepare("SELECT id FROM supplier_invoices WHERE id=?1")
        .bind(supplierInvoiceId)
        .first<{ id: string }>();
      if (!invoice) return jsonResponse({ error: "NOTA FISCAL VINCULADA NÃO ENCONTRADA." }, 400);
    }

    const existingPayable = await database
      .prepare("SELECT id FROM accounts_payable WHERE idempotency_key=?1")
      .bind(`supplier-debt:${idempotencyKey}`)
      .first<{ id: string }>();
    if (existingPayable) {
      const existingDebt = await database
        .prepare("SELECT id FROM supplier_open_debts WHERE accounts_payable_id=?1")
        .bind(existingPayable.id)
        .first<{ id: string }>();
      return jsonResponse({ created: true, alreadyProcessed: true, id: existingDebt?.id ?? "", accountsPayableId: existingPayable.id });
    }

    const debtId = crypto.randomUUID();
    const payableId = crypto.randomUUID();
    const actorName = actor.displayName || "Administrador";
    const competenceMonth = dueDate.slice(0, 7);

    const statements: [string, unknown[]][] = [
      [
        `INSERT INTO accounts_payable
          (id, company_id, company_name, description, supplier_id, finance_item_id, finance_account_id,
           original_amount_cents, paid_amount_cents, dre_amount_cents, issue_date, competence_month, due_date, payment_method,
           invoice_number, order_reference, billing_code, notes, status,
           idempotency_key, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,NULL,?9,?10,?11,?12,?13,?14,'',?15,'open',
           ?16,?17,?18,CURRENT_TIMESTAMP,?17,?18,CURRENT_TIMESTAMP)`,
        [
          payableId,
          companyId,
          companyName,
          description,
          supplierId,
          financeItemId,
          financeAccountId,
          originalAmountCents,
          purchaseDate,
          competenceMonth,
          dueDate,
          "",
          invoiceNumber,
          orderReference,
          notes,
          `supplier-debt:${idempotencyKey}`,
          actor.id,
          actorName,
        ],
      ],
      [
        `INSERT INTO supplier_open_debts
          (id, company_id, company_name, supplier_id, supplier_name, invoice_number, supplier_invoice_id,
           order_reference, purchase_date, description, original_amount_cents, paid_amount_cents, due_date, notes,
           accounts_payable_id, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,?12,?13,?14,?15,?16,CURRENT_TIMESTAMP,?15,?16,CURRENT_TIMESTAMP)`,
        [
          debtId,
          companyId,
          companyName,
          supplierId,
          supplier.name,
          invoiceNumber,
          supplierInvoiceId,
          orderReference,
          purchaseDate,
          description,
          originalAmountCents,
          dueDate,
          notes,
          payableId,
          actor.id,
          actorName,
        ],
      ],
    ];

    const entryId = crypto.randomUUID();
    for (const [sql, sqlValues] of recalcPayableEntrySql(entryId, companyId, financeItemId, competenceMonth, actor.id, actorName)) {
      statements.push([sql, sqlValues]);
    }

    await database.batch(statements.map(([sql, sqlValues]) => database.prepare(sql).bind(...sqlValues)));

    return jsonResponse({ created: true, id: debtId, accountsPayableId: payableId }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a dívida de fornecedor.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A DÍVIDA DE FORNECEDOR." }, 500);
  }
}
