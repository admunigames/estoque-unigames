import { getD1 } from "../../../../db";
import { loadCompanyList } from "../shared";
import { itemTotal, type EntryRow } from "../dre/shared";
import { loadPayrollDreContribution } from "../dre/payroll";

// Orçamento (Financeiro Fase 4) — comparação Orçado x Realizado.
//
// O Realizado é calculado de DUAS formas diferentes, dependendo se o
// orçamento tem centro de custo definido, porque finance_store_entries (a
// tabela que a DRE usa pra Realizado) NÃO guarda centro de custo — só
// accounts_payable/expenses guardam (cost_center_id, ver migration 0033):
//
// - SEM centro de custo: soma finance_store_entries (entry_type='fixed'),
//   exatamente a mesma fonte/regra que app/api/finance/dre/shared.ts usa
//   (buildStoreDre/buildConsolidatedDre) — zero risco de divergir da DRE.
// - COM centro de custo: soma accounts_payable diretamente
//   (COALESCE(dre_amount_cents, original_amount_cents), status <> 'canceled'),
//   a mesma regra de app/lib/payables-recurrence.ts#recalcPayableEntrySql,
//   só que agrupando também por cost_center_id (dimensão que
//   finance_store_entries não preserva). Lançamentos manuais digitados
//   direto na tela de DRE (sem centro de custo) nunca entram nesse total —
//   decisão confirmada com o usuário.
//
// Em ambos os casos, "os itens da categoria" seguem a mesma regra da DRE:
// categoria de topo = itens diretos + itens de todos os subgrupos dela;
// subcategoria = só os itens dela mesma (só 1 nível de subgrupo existe).

export type BudgetRow = {
  id: string;
  companyId: string;
  companyName: string;
  categoryId: string;
  costCenterId: string;
  month: string;
  amountCents: number;
  notes: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

export type BudgetComparisonRow = BudgetRow & {
  categoryName: string;
  costCenterName: string;
  realizedCents: number;
  differenceCents: number;
  balanceCents: number;
  usedPercentBasisPoints: number;
  alertLevel: "ok" | "warning" | "over";
  // false quando a categoria não tem orçamento cadastrado — a tela mostra
  // só o Realizado, sem cobrar 100% de cobertura de orçamento (item 12).
  hasBudget: boolean;
};

const ITEMS_FOR_CATEGORY_SQL = `
  SELECT id FROM finance_items
  WHERE category_id=?CAT
     OR category_id IN (SELECT id FROM finance_categories WHERE parent_id=?CAT)
`;

async function realizedNoCostCenter(
  database: Awaited<ReturnType<typeof getD1>>,
  categoryId: string,
  month: string,
  companyId: string,
): Promise<number> {
  const storeCondition = companyId ? "AND store_id=?3" : "";
  const params = companyId ? [month, categoryId, companyId] : [month, categoryId];
  const [result, categoryItems, payroll] = await Promise.all([
    database
      .prepare(
        `SELECT entry_type AS entryType, amount_cents AS amountCents
         FROM finance_store_entries
         WHERE month=?1
           AND item_id IN (${ITEMS_FOR_CATEGORY_SQL.replaceAll("?CAT", "?2")})
           ${storeCondition}`,
      )
      .bind(...params)
      .all<EntryRow>(),
    database
      .prepare(`SELECT id FROM finance_items WHERE ${ITEMS_FOR_CATEGORY_SQL.replaceAll("?CAT", "?1")}`)
      .bind(categoryId)
      .all<{ id: string }>(),
    // Item 13: o Realizado da DRE inclui o custo de pessoal mapeado — o
    // Orçado x Realizado precisa refletir a mesma base.
    loadPayrollDreContribution(database, companyId ? { companyId } : "stores", month),
  ]);
  const entriesTotal = (result.results ?? []).reduce((sum, entry) => sum + itemTotal(entry), 0);
  const categoryItemIds = new Set((categoryItems.results ?? []).map((row) => row.id));
  let payrollTotal = 0;
  for (const [itemId, cents] of payroll.byItem) {
    if (categoryItemIds.has(itemId)) payrollTotal += cents;
  }
  return entriesTotal + payrollTotal;
}

async function realizedWithCostCenter(
  database: Awaited<ReturnType<typeof getD1>>,
  categoryId: string,
  month: string,
  companyId: string,
  costCenterId: string,
): Promise<number> {
  const companyCondition = companyId ? "AND company_id=?4" : "";
  const params = companyId
    ? [month, costCenterId, categoryId, companyId]
    : [month, costCenterId, categoryId];
  const row = await database
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(dre_amount_cents, original_amount_cents)), 0) AS total
       FROM accounts_payable
       WHERE competence_month=?1
         AND status <> 'canceled'
         AND cost_center_id=?2
         AND finance_item_id IN (${ITEMS_FOR_CATEGORY_SQL.replaceAll("?CAT", "?3")})
         ${companyCondition}`,
    )
    .bind(...params)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export async function realizedCentsFor(
  database: Awaited<ReturnType<typeof getD1>>,
  categoryId: string,
  month: string,
  companyId: string,
  costCenterId: string,
): Promise<number> {
  return costCenterId
    ? realizedWithCostCenter(database, categoryId, month, companyId, costCenterId)
    : realizedNoCostCenter(database, categoryId, month, companyId);
}

// >=100% do orçado usado = estourado; >=80% = próximo de estourar.
const WARNING_THRESHOLD_BASIS_POINTS = 8000;
const OVER_THRESHOLD_BASIS_POINTS = 10000;

export function alertLevelFor(usedPercentBasisPoints: number): "ok" | "warning" | "over" {
  if (usedPercentBasisPoints >= OVER_THRESHOLD_BASIS_POINTS) return "over";
  if (usedPercentBasisPoints >= WARNING_THRESHOLD_BASIS_POINTS) return "warning";
  return "ok";
}

type CategoryNameRow = { id: string; name: string; parentId: string | null };
type CostCenterNameRow = { id: string; name: string };

export async function loadCategoryLabels(
  database: Awaited<ReturnType<typeof getD1>>,
): Promise<Map<string, string>> {
  const result = await database
    .prepare("SELECT id, name, parent_id AS parentId FROM finance_categories")
    .all<CategoryNameRow>();
  const rows = result.results ?? [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const labels = new Map<string, string>();
  for (const row of rows) {
    const parent = row.parentId ? byId.get(row.parentId) : null;
    labels.set(row.id, parent ? `${parent.name} › ${row.name}` : row.name);
  }
  return labels;
}

export async function loadCostCenterLabels(
  database: Awaited<ReturnType<typeof getD1>>,
): Promise<Map<string, string>> {
  const result = await database.prepare("SELECT id, name FROM finance_cost_centers").all<CostCenterNameRow>();
  return new Map((result.results ?? []).map((row) => [row.id, row.name]));
}

export async function loadCompanyNameMap(
  database: Awaited<ReturnType<typeof getD1>>,
): Promise<Map<string, string>> {
  const companies = await loadCompanyList(database);
  return new Map(companies.map((company) => [company.id, company.name]));
}

export function buildComparisonRow(
  budget: BudgetRow,
  realizedCents: number,
  categoryName: string,
  costCenterName: string,
): BudgetComparisonRow {
  const differenceCents = budget.amountCents - realizedCents;
  const balanceCents = Math.max(differenceCents, 0);
  const usedPercentBasisPoints =
    budget.amountCents > 0 ? Math.round((realizedCents / budget.amountCents) * 10000) : realizedCents > 0 ? 10001 : 0;
  return {
    ...budget,
    categoryName,
    costCenterName,
    realizedCents,
    differenceCents,
    balanceCents,
    usedPercentBasisPoints,
    alertLevel: alertLevelFor(usedPercentBasisPoints),
    hasBudget: true,
  };
}

/**
 * Linha de uma categoria SEM orçamento cadastrado: só o Realizado, sem
 * alerta de estouro (item 12 — a tela não exige 100% de cobertura de
 * orçamento).
 */
export function buildRealizedOnlyRow(
  categoryId: string,
  companyId: string,
  companyName: string,
  month: string,
  realizedCents: number,
  categoryName: string,
): BudgetComparisonRow {
  return {
    id: `realized:${categoryId}`,
    companyId,
    companyName,
    categoryId,
    costCenterId: "",
    month,
    amountCents: 0,
    notes: "",
    createdBy: "",
    createdByName: "",
    createdAt: "",
    updatedBy: "",
    updatedByName: "",
    updatedAt: "",
    categoryName,
    costCenterName: "",
    realizedCents,
    differenceCents: -realizedCents,
    balanceCents: 0,
    usedPercentBasisPoints: 0,
    alertLevel: "ok",
    hasBudget: false,
  };
}
