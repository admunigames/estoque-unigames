import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  canManageFinance,
  identity,
  jsonResponse,
  loadCompanyList,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";
import {
  buildComparisonRow,
  buildRealizedOnlyRow,
  loadCategoryLabels,
  loadCompanyNameMap,
  loadCostCenterLabels,
  realizedCentsFor,
  type BudgetRow,
} from "./shared";

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const url = new URL(request.url);
  const month = safeText(url.searchParams.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }
  const companyId = safeText(url.searchParams.get("companyId"), 80);

  try {
    const database = await getD1();
    const [budgetsResult, categoryLabels, costCenterLabels, companyNames] = await Promise.all([
      database
        .prepare(
          `SELECT id, company_id AS companyId, company_name AS companyName, category_id AS categoryId,
                  cost_center_id AS costCenterId, month, amount_cents AS amountCents, notes,
                  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
                  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt
           FROM finance_budgets WHERE month=?1 AND company_id=?2
           ORDER BY category_id ASC, cost_center_id ASC`,
        )
        .bind(month, companyId)
        .all<BudgetRow>(),
      loadCategoryLabels(database),
      loadCostCenterLabels(database),
      loadCompanyNameMap(database),
    ]);

    const budgets = budgetsResult.results ?? [];
    const includeUnbudgeted = url.searchParams.get("includeUnbudgeted") !== "0";
    const comparisons = await Promise.all(
      budgets.map(async (budget) => {
        const realizedCents = await realizedCentsFor(
          database,
          budget.categoryId,
          budget.month,
          budget.companyId,
          budget.costCenterId,
        );
        return buildComparisonRow(
          budget,
          realizedCents,
          categoryLabels.get(budget.categoryId) ?? "(CATEGORIA EXCLUÍDA)",
          budget.costCenterId ? costCenterLabels.get(budget.costCenterId) ?? "(CENTRO DE CUSTO EXCLUÍDO)" : "",
        );
      }),
    );

    // Item 12: categorias de topo SEM orçamento cadastrado entram com só o
    // Realizado (quando houver movimento), sem travar a tela nem cobrar
    // cobertura total de orçamento.
    let unbudgeted: typeof comparisons = [];
    if (includeUnbudgeted) {
      const budgetedCategoryIds = new Set(budgets.map((budget) => budget.categoryId));
      const topCategoriesResult = await database
        .prepare("SELECT id, name FROM finance_categories WHERE parent_id IS NULL ORDER BY position ASC, name ASC")
        .all<{ id: string; name: string }>();
      const pending = (topCategoriesResult.results ?? []).filter(
        (category) => !budgetedCategoryIds.has(category.id),
      );
      const rows = await Promise.all(
        pending.map(async (category) => {
          const realizedCents = await realizedCentsFor(database, category.id, month, companyId, "");
          return { category, realizedCents };
        }),
      );
      unbudgeted = rows
        .filter((row) => row.realizedCents !== 0)
        .map((row) =>
          buildRealizedOnlyRow(
            row.category.id,
            companyId,
            companyId ? companyNames.get(companyId) ?? "" : "",
            month,
            row.realizedCents,
            categoryLabels.get(row.category.id) ?? row.category.name,
          ),
        );
    }

    return jsonResponse({
      month,
      companyId,
      companyName: companyId ? companyNames.get(companyId) ?? "" : "",
      budgets: [...comparisons, ...unbudgeted],
    });
  } catch (error) {
    console.error("Não foi possível carregar o orçamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O ORÇAMENTO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR ORÇAMENTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const companyId = safeText(body.companyId, 80);
    const categoryId = safeText(body.categoryId, 80);
    const costCenterId = safeText(body.costCenterId, 80);
    const month = safeText(body.month, 7);
    const notes = safeText(body.notes, 500);
    const amountCents = Math.round(Number(body.amountCents));

    if (!categoryId) return jsonResponse({ error: "SELECIONE A CATEGORIA." }, 400);
    if (!MONTH_PATTERN.test(month)) {
      return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
    }
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR ORÇADO MAIOR QUE ZERO." }, 400);
    }

    const database = await getD1();

    const category = await database
      .prepare("SELECT id FROM finance_categories WHERE id=?1")
      .bind(categoryId)
      .first<{ id: string }>();
    if (!category) return jsonResponse({ error: "CATEGORIA NÃO ENCONTRADA." }, 400);

    if (costCenterId) {
      const costCenter = await database
        .prepare("SELECT id FROM finance_cost_centers WHERE id=?1")
        .bind(costCenterId)
        .first<{ id: string }>();
      if (!costCenter) return jsonResponse({ error: "CENTRO DE CUSTO NÃO ENCONTRADO." }, 400);
    }

    let companyName = "";
    if (companyId) {
      const companies = await loadCompanyList(database);
      const company = companies.find((c) => c.id === companyId);
      if (!company) return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
      companyName = company.name;
    }

    const duplicate = await database
      .prepare(
        `SELECT id FROM finance_budgets
         WHERE company_id=?1 AND category_id=?2 AND cost_center_id=?3 AND month=?4 AND id<>?5`,
      )
      .bind(companyId, categoryId, costCenterId, month, editId || "")
      .first<{ id: string }>();
    if (duplicate) {
      return jsonResponse(
        {
          error:
            "JÁ EXISTE UM ORÇAMENTO CADASTRADO PARA ESSA COMBINAÇÃO DE LOJA/CATEGORIA/CENTRO DE CUSTO/MÊS.",
        },
        409,
      );
    }

    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM finance_budgets WHERE id=?1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "ORÇAMENTO NÃO ENCONTRADO." }, 404);
      await database
        .prepare(
          `UPDATE finance_budgets
           SET company_id=?1, company_name=?2, category_id=?3, cost_center_id=?4, month=?5,
               amount_cents=?6, notes=?7, updated_by=?8, updated_by_name=?9, updated_at=CURRENT_TIMESTAMP
           WHERE id=?10`,
        )
        .bind(companyId, companyName, categoryId, costCenterId, month, amountCents, notes, actor.id, actor.displayName || "Administrador", editId)
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_budgets
          (id, company_id, company_name, category_id, cost_center_id, month, amount_cents, notes,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CURRENT_TIMESTAMP, ?9, ?10, CURRENT_TIMESTAMP)`,
      )
      .bind(id, companyId, companyName, categoryId, costCenterId, month, amountCents, notes, actor.id, actor.displayName || "Administrador")
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar o orçamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR O ORÇAMENTO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR ORÇAMENTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "ORÇAMENTO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    await database.prepare("DELETE FROM finance_budgets WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o orçamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O ORÇAMENTO." }, 500);
  }
}
