import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { todayInTimezone } from "../../../../lib/finance-status";
import {
  computeDreAnchorAssignments,
  displayStatusCaseSql,
  effectiveDreAmountCents,
  prorateDreAmountByShare,
  recalcPayableEntrySql,
} from "../../../../lib/payables-recurrence";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { assertExpenseAccess, loadExpense } from "../shared";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const { id } = await context.params;
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };

  try {
    const database = await getD1();
    const expense = await loadExpense(database, id);
    if (!expense) return jsonResponse({ error: "DESPESA NÃO ENCONTRADA." }, 404);

    const accessError = assertExpenseAccess(scopeActor, expense);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const today = todayInTimezone();
    const payables = await database
      .prepare(
        `SELECT id, company_id AS companyId, company_name AS companyName,
                original_amount_cents AS originalAmountCents, paid_amount_cents AS paidAmountCents,
                dre_amount_cents AS dreAmountCents,
                competence_month AS competenceMonth, due_date AS dueDate, status,
                installment_number AS installmentNumber, installment_total AS installmentTotal,
                recurrence_frequency AS recurrenceFrequency,
                ${displayStatusCaseSql(1)} AS displayStatus
         FROM accounts_payable WHERE expense_id=?2 ORDER BY company_id ASC, due_date ASC, id ASC`,
      )
      .bind(today, id)
      .all<{
        id: string;
        companyId: string;
        originalAmountCents: number;
        dreAmountCents: number | null;
      }>();

    const rateioShares =
      expense.rateioType === "rateio"
        ? await database
            .prepare(
              `SELECT company_id AS companyId, company_name AS companyName,
                      percent_basis_points AS percentBasisPoints, amount_cents AS amountCents
               FROM expense_rateio_shares WHERE expense_id=?1 ORDER BY company_id ASC`,
            )
            .bind(id)
            .all()
        : null;

    const payableRows = payables.results ?? [];
    // Estado do toggle "Incluir na DRE?" em nível de despesa: soma do
    // impacto EFETIVO de cada linha (customizado ou original), não
    // depende de qual linha é a âncora — reflete exatamente o que está
    // batendo na DRE agora, inclusive numa despesa rateada entre lojas.
    const totalDreImpact = payableRows.reduce(
      (sum, row) => sum + effectiveDreAmountCents(row.dreAmountCents, row.originalAmountCents),
      0,
    );
    const isCustomized = payableRows.some((row) => row.dreAmountCents !== null && row.dreAmountCents !== undefined);
    const dre = { included: !isCustomized || totalDreImpact > 0, amountCents: totalDreImpact, isCustomized };

    return jsonResponse({
      expense,
      payables: payableRows,
      rateioShares: rateioShares?.results ?? [],
      dre,
    });
  } catch (error) {
    console.error("Não foi possível carregar a despesa.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A DESPESA." }, 500);
  }
}

/**
 * Edição só da decisão de DRE (Incluir?/valor) de uma despesa já criada —
 * ainda não existe um PATCH geral de edição de despesa neste módulo, então
 * este handler cobre só o escopo desta feature (ver
 * estoque_modulo_despesas_rateio para o resto do CRUD). Aplica a mesma
 * lógica de âncora + prorateio por loja usada na criação (POST ../route.ts),
 * reescrevendo TODAS as linhas de accounts_payable da despesa na mesma
 * transação e recalculando toda célula da DRE afetada.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR DESPESAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const expense = await loadExpense(database, id);
    if (!expense) return jsonResponse({ error: "DESPESA NÃO ENCONTRADA." }, 404);

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertExpenseAccess(scopeActor, expense);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const body = (await request.json()) as JsonMap;
    if (body.dreIncluded === undefined) {
      return jsonResponse({ error: "INFORME dreIncluded PARA ATUALIZAR A INCLUSÃO NA DRE." }, 400);
    }
    const dreIncluded = Boolean(body.dreIncluded);
    const dreAmountCentsRaw = Number(body.dreAmountCents);
    if (!Number.isFinite(dreAmountCentsRaw) || !Number.isInteger(dreAmountCentsRaw) || dreAmountCentsRaw < 0) {
      return jsonResponse({ error: "INFORME UM VALOR VÁLIDO (EM CENTAVOS, NÃO NEGATIVO) PARA A DRE." }, 400);
    }

    const rows = await database
      .prepare(
        `SELECT id, company_id AS companyId, finance_item_id AS financeItemId,
                original_amount_cents AS originalAmountCents, competence_month AS competenceMonth
         FROM accounts_payable WHERE expense_id=?1
         ORDER BY company_id ASC, installment_number ASC, recurrence_occurrence_index ASC, created_at ASC, id ASC`,
      )
      .bind(id)
      .all<{
        id: string;
        companyId: string;
        financeItemId: string;
        originalAmountCents: number;
        competenceMonth: string;
      }>();
    const groupRows = rows.results ?? [];
    if (!groupRows.length) {
      return jsonResponse({ error: "ESTA DESPESA NÃO TEM CONTAS A PAGAR VINCULADAS." }, 409);
    }

    const totalOriginal = groupRows.reduce((sum, row) => sum + row.originalAmountCents, 0);
    let dreWarning: string | null = null;
    if (dreIncluded && dreAmountCentsRaw > totalOriginal) {
      dreWarning = "O VALOR INFORMADO PARA A DRE É MAIOR QUE O VALOR TOTAL DA DESPESA.";
    }

    // Agrupa por loja (rateio) preservando a ordem já vinda do ORDER BY.
    const byCompany = new Map<string, typeof groupRows>();
    for (const row of groupRows) {
      const list = byCompany.get(row.companyId) ?? [];
      list.push(row);
      byCompany.set(row.companyId, list);
    }
    const shareTotals = prorateDreAmountByShare(
      [...byCompany.entries()].map(([companyId, companyRows]) => ({
        key: companyId,
        originalAmountCents: companyRows.reduce((sum, row) => sum + row.originalAmountCents, 0),
      })),
      dreIncluded ? dreAmountCentsRaw : 0,
    );

    const actorName = actor.displayName || "Administrador";
    const statements: [string, unknown[]][] = [];
    const slotKeySet = new Map<string, { companyId: string; financeItemId: string; month: string }>();

    for (const [companyId, companyRows] of byCompany) {
      const orderedIds = companyRows.map((row) => row.id);
      const assignments = computeDreAnchorAssignments(orderedIds, true, shareTotals.get(companyId) ?? 0);
      for (const row of companyRows) {
        statements.push([
          `UPDATE accounts_payable SET dre_amount_cents=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4`,
          [assignments.get(row.id) ?? 0, actor.id, actorName, row.id],
        ]);
        slotKeySet.set(`${row.companyId}::${row.financeItemId}::${row.competenceMonth}`, {
          companyId: row.companyId,
          financeItemId: row.financeItemId,
          month: row.competenceMonth,
        });
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
    console.error("Não foi possível editar a inclusão na DRE da despesa.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR A INCLUSÃO NA DRE DA DESPESA." }, 500);
  }
}
