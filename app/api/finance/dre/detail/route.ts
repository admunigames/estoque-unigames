import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { effectiveDreAmountCents } from "../../../../lib/payables-recurrence";
import { canManageFinance, identity, jsonResponse, MONTH_PATTERN, safeText } from "../../shared";
import { loadPayrollDreContribution, PAYROLL_BLOCK_LABELS } from "../payroll";

type EntryRow = {
  id: string;
  storeId: string;
  itemId: string;
  entryType: string;
  amountCents: number | null;
  percentBasisPoints: number | null;
  source: string;
};

type PayableDetailRow = {
  id: string;
  dueDate: string;
  issueDate: string;
  companyName: string;
  supplierName: string | null;
  itemName: string;
  categoryName: string;
  parentCategoryName: string | null;
  costCenterName: string | null;
  costCenterText: string;
  description: string;
  originalAmountCents: number;
  dreAmountCents: number | null;
  paymentMethod: string;
  financeAccountLabel: string | null;
  notes: string;
};

/**
 * Detalha os lançamentos por trás de uma célula da DRE (item ou categoria
 * inteira, num mês, opcionalmente restrito a uma loja) — hoje clicar numa
 * linha só permite editar/excluir o valor manual; isto é o "ver o que
 * compõe esse número". Uma célula 'payable' soma N contas a pagar
 * (accounts_payable.company_id+finance_item_id+competence_month); uma
 * célula 'manual' é só o próprio valor digitado, sem lançamentos por trás.
 */
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
  const itemId = safeText(url.searchParams.get("itemId"), 80);
  const categoryId = safeText(url.searchParams.get("categoryId"), 80);
  if (!itemId && !categoryId) {
    return jsonResponse({ error: "INFORME O ITEM OU A CATEGORIA." }, 400);
  }
  const storeId = safeText(url.searchParams.get("storeId"), 80);

  try {
    const database = await getD1();

    let itemIds: string[];
    if (itemId) {
      itemIds = [itemId];
    } else {
      const categories = await database
        .prepare("SELECT id, parent_id AS parentId FROM finance_categories WHERE id=?1 OR parent_id=?1")
        .bind(categoryId)
        .all<{ id: string; parentId: string | null }>();
      const categoryIds = (categories.results ?? []).map((row) => row.id);
      if (!categoryIds.length) return jsonResponse({ error: "CATEGORIA NÃO ENCONTRADA." }, 404);
      const items = await database
        .prepare(
          `SELECT id FROM finance_items WHERE category_id IN (${categoryIds.map((_, i) => `?${i + 1}`).join(",")})`,
        )
        .bind(...categoryIds)
        .all<{ id: string }>();
      itemIds = (items.results ?? []).map((row) => row.id);
    }
    if (!itemIds.length) return jsonResponse({ entries: [], manualEntries: [] });

    const placeholders = itemIds.map((_, i) => `?${i + 2}`).join(",");
    const entries = await database
      .prepare(
        `SELECT id, store_id AS storeId, item_id AS itemId, entry_type AS entryType,
                amount_cents AS amountCents, percent_basis_points AS percentBasisPoints, source
         FROM finance_store_entries
         WHERE month=?1 AND item_id IN (${placeholders})${storeId ? ` AND store_id=?${itemIds.length + 2}` : ""}`,
      )
      .bind(month, ...itemIds, ...(storeId ? [storeId] : []))
      .all<EntryRow>();

    const manualEntries = (entries.results ?? []).filter((entry) => entry.source === "manual");
    const hasPayableCells = (entries.results ?? []).some((entry) => entry.source === "payable");

    let payableRows: PayableDetailRow[] = [];
    if (hasPayableCells || !manualEntries.length) {
      // Sempre tenta buscar as contas a pagar por trás — mesmo sem nenhuma
      // linha 'payable' na tabela de entries ainda pode haver payables sem
      // recálculo feito (não deveria acontecer, mas não custa ser
      // defensivo aqui, é só leitura).
      const companyFilter = storeId ? "AND ap.company_id=?" + (itemIds.length + 2) : "";
      const rows = await database
        .prepare(
          `SELECT ap.id, ap.due_date AS dueDate, ap.issue_date AS issueDate, ap.company_name AS companyName,
                  s.name AS supplierName, fi.name AS itemName, fc.name AS categoryName, pfc.name AS parentCategoryName,
                  fcc.name AS costCenterName, ap.cost_center AS costCenterText,
                  ap.description, ap.original_amount_cents AS originalAmountCents, ap.dre_amount_cents AS dreAmountCents,
                  ap.payment_method AS paymentMethod, fa.name AS financeAccountLabel, ap.notes
           FROM accounts_payable ap
           LEFT JOIN finance_suppliers s ON s.id = ap.supplier_id
           LEFT JOIN finance_items fi ON fi.id = ap.finance_item_id
           LEFT JOIN finance_categories fc ON fc.id = fi.category_id
           LEFT JOIN finance_categories pfc ON pfc.id = fc.parent_id
           LEFT JOIN finance_cost_centers fcc ON fcc.id = ap.cost_center_id
           LEFT JOIN finance_accounts fa ON fa.id = ap.finance_account_id
           WHERE ap.competence_month=?1 AND ap.status<>'canceled'
             AND ap.finance_item_id IN (${placeholders})
             ${companyFilter}
           ORDER BY ap.due_date ASC, ap.id ASC`,
        )
        .bind(month, ...itemIds, ...(storeId ? [storeId] : []))
        .all<PayableDetailRow>();
      payableRows = rows.results ?? [];
    }

    const entryDetails = payableRows.map((row) => ({
      kind: "payable" as const,
      id: row.id,
      date: row.issueDate || row.dueDate,
      dueDate: row.dueDate,
      companyName: row.companyName,
      supplierName: row.supplierName || "",
      itemName: row.itemName || "",
      categoryName: row.categoryName || "",
      parentCategoryName: row.parentCategoryName || "",
      costCenter: row.costCenterName || row.costCenterText || "",
      description: row.description,
      amountCents: effectiveDreAmountCents(row.dreAmountCents, row.originalAmountCents),
      originalAmountCents: row.originalAmountCents,
      paymentMethod: row.paymentMethod || "",
      financeAccount: row.financeAccountLabel || "",
      notes: row.notes || "",
    }));

    // Item 13: contribuição do RH mapeada para os itens desta célula.
    const payroll = await loadPayrollDreContribution(
      database,
      storeId ? { companyId: storeId } : "stores",
      month,
    );
    const itemIdSet = new Set(itemIds);
    const payrollDetails = payroll.blocks
      .filter((entry) => itemIdSet.has(entry.financeItemId))
      .map((entry) => ({
        kind: "payroll" as const,
        id: `payroll:${entry.block}`,
        description: PAYROLL_BLOCK_LABELS[entry.block],
        amountCents: entry.amountCents,
      }));

    const manualDetails = manualEntries.map((entry) => ({
      kind: "manual" as const,
      id: entry.id,
      storeId: entry.storeId,
      entryType: entry.entryType,
      amountCents: entry.amountCents,
      percentBasisPoints: entry.percentBasisPoints,
    }));

    return jsonResponse({
      entries: [...entryDetails, ...payrollDetails],
      manualEntries: manualDetails,
    });
  } catch (error) {
    console.error("Não foi possível carregar o detalhamento da DRE.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O DETALHAMENTO." }, 500);
  }
}
