import { getD1 } from "../../../../db";
import { loadCompanyList } from "../shared";
import { loadPayrollDreContribution } from "./payroll";

// Lógica de cálculo da DRE (por loja, consolidada, gerencial, comparativo
// entre unidades e série temporal) — extraída de route.ts pra poder ser
// reaproveitada pelo Dashboard Geral (Fase 2 do Financeiro) sem duplicar a
// fórmula de resultado/margem. route.ts continua exportando só os handlers
// HTTP (GET); toda a lógica de montagem mora aqui.

export type CategoryRow = {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
};

export type ItemRow = {
  id: string;
  categoryId: string;
  name: string;
  position: number;
};

export type EntryRow = {
  id?: string;
  itemId: string;
  entryType: string;
  amountCents: number | null;
  percentBasisPoints: number | null;
};

export type DreItem = {
  id: string;
  name: string;
  entryId: string | null;
  entryType: string | null;
  amountCents: number | null;
  percentBasisPoints: number | null;
  // Parte do total do item que veio do RH (Folha/Benefícios/Comissões),
  // quando esse item é destino de um bloco no mapeamento RH → DRE.
  payrollCents?: number | null;
};

export type DreCategory = {
  id: string;
  name: string;
  totalCents: number;
  items: DreItem[];
  subgroups: Array<{
    id: string;
    name: string;
    totalCents: number;
    items: DreItem[];
  }>;
};

export type ConsolidatedCategory = {
  id: string;
  name: string;
  totalCents: number;
};

export type ManagerialItem = {
  id: string;
  name: string;
  totalCents: number;
};

export type ManagerialCategory = {
  id: string;
  name: string;
  totalCents: number;
  items: ManagerialItem[];
  subgroups: Array<{
    id: string;
    name: string;
    totalCents: number;
    items: ManagerialItem[];
  }>;
};

export type StoreDreResult = {
  revenueCents: number;
  expenseTotalCents: number;
  resultCents: number;
  marginBasisPoints: number;
  categories: DreCategory[];
};

export type ConsolidatedDreResult = {
  revenueCents: number;
  expenseTotalCents: number;
  resultCents: number;
  marginBasisPoints: number;
  categories: ConsolidatedCategory[];
};

export type ManagerialDreResult = {
  revenueCents: number;
  expenseTotalCents: number;
  resultCents: number;
  marginBasisPoints: number;
  categories: ManagerialCategory[];
};

export type ByStoreDreResult = {
  stores: Array<{
    storeId: string;
    storeName: string;
    revenueCents: number;
    expenseTotalCents: number;
    resultCents: number;
    marginBasisPoints: number;
    categories: ConsolidatedCategory[];
  }>;
};

export function itemTotal(entry: EntryRow | undefined): number {
  return entry?.entryType === "fixed" ? entry.amountCents ?? 0 : 0;
}

export function groupCategories(allCategories: CategoryRow[]) {
  const topCategories = allCategories.filter((category) => !category.parentId);
  const subcategoriesByParent = new Map<string, CategoryRow[]>();
  for (const category of allCategories) {
    if (!category.parentId) continue;
    const list = subcategoriesByParent.get(category.parentId) ?? [];
    list.push(category);
    subcategoriesByParent.set(category.parentId, list);
  }
  return { topCategories, subcategoriesByParent };
}

export function groupItemsByCategory(allItems: ItemRow[]) {
  const itemsByCategory = new Map<string, ItemRow[]>();
  for (const item of allItems) {
    const list = itemsByCategory.get(item.categoryId) ?? [];
    list.push(item);
    itemsByCategory.set(item.categoryId, list);
  }
  return itemsByCategory;
}

export async function loadCatalog(database: Awaited<ReturnType<typeof getD1>>) {
  const [categories, items] = await Promise.all([
    database
      .prepare(
        "SELECT id, name, parent_id AS parentId, position FROM finance_categories ORDER BY position ASC, name ASC",
      )
      .all<CategoryRow>(),
    database
      .prepare(
        "SELECT id, category_id AS categoryId, name, position FROM finance_items ORDER BY position ASC, name ASC",
      )
      .all<ItemRow>(),
  ]);
  return { allCategories: categories.results ?? [], allItems: items.results ?? [] };
}

export async function buildStoreDre(
  database: Awaited<ReturnType<typeof getD1>>,
  storeId: string,
  month: string,
): Promise<StoreDreResult> {
  const [{ allCategories, allItems }, entries, revenue, payroll] = await Promise.all([
    loadCatalog(database),
    database
      .prepare(
        `SELECT id, item_id AS itemId, entry_type AS entryType,
                amount_cents AS amountCents, percent_basis_points AS percentBasisPoints
         FROM finance_store_entries WHERE store_id=?1 AND month=?2`,
      )
      .bind(storeId, month)
      .all<EntryRow>(),
    database
      .prepare(
        "SELECT amount_cents AS amountCents FROM finance_store_revenue WHERE store_id=?1 AND month=?2",
      )
      .bind(storeId, month)
      .first<{ amountCents: number }>(),
    loadPayrollDreContribution(database, { companyId: storeId }, month),
  ]);

  const entryByItem = new Map<string, EntryRow>();
  for (const entry of entries.results ?? []) entryByItem.set(entry.itemId, entry);

  // Total efetivo de um item na DRE: lançamento manual/despesa + contribuição
  // do RH mapeada para esse item (item 13).
  const itemCents = (itemId: string) =>
    itemTotal(entryByItem.get(itemId)) + (payroll.byItem.get(itemId) ?? 0);

  function buildItem(item: ItemRow): DreItem {
    const entry = entryByItem.get(item.id);
    const payrollCents = payroll.byItem.get(item.id) ?? 0;
    return {
      id: item.id,
      name: item.name,
      entryId: entry?.id ?? null,
      entryType: entry?.entryType ?? null,
      amountCents: entry?.amountCents ?? (payrollCents ? payrollCents : null),
      percentBasisPoints: entry?.percentBasisPoints ?? null,
      payrollCents: payrollCents || null,
    };
  }

  const { topCategories, subcategoriesByParent } = groupCategories(allCategories);
  const itemsByCategory = groupItemsByCategory(allItems);

  const dreCategories: DreCategory[] = topCategories.map((category) => {
    const directItems = (itemsByCategory.get(category.id) ?? []).map(buildItem);
    const subgroups = (subcategoriesByParent.get(category.id) ?? []).map((subgroup) => {
      const subgroupItems = (itemsByCategory.get(subgroup.id) ?? []).map(buildItem);
      const totalCents = subgroupItems.reduce((sum, item) => sum + itemCents(item.id), 0);
      return { id: subgroup.id, name: subgroup.name, totalCents, items: subgroupItems };
    });
    const totalCents =
      directItems.reduce((sum, item) => sum + itemCents(item.id), 0) +
      subgroups.reduce((sum, subgroup) => sum + subgroup.totalCents, 0);
    return { id: category.id, name: category.name, totalCents, items: directItems, subgroups };
  });

  const revenueCents = revenue?.amountCents ?? 0;
  const expenseTotalCents = dreCategories.reduce((sum, category) => sum + category.totalCents, 0);
  const resultCents = revenueCents - expenseTotalCents;
  const marginBasisPoints = revenueCents > 0 ? Math.round((resultCents / revenueCents) * 10000) : 0;

  return { revenueCents, expenseTotalCents, resultCents, marginBasisPoints, categories: dreCategories };
}

export async function loadMonthWideTotals(database: Awaited<ReturnType<typeof getD1>>, month: string) {
  const [{ allCategories, allItems }, entries, revenue, payroll] = await Promise.all([
    loadCatalog(database),
    database
      .prepare(
        `SELECT item_id AS itemId, entry_type AS entryType,
                amount_cents AS amountCents, percent_basis_points AS percentBasisPoints
         FROM finance_store_entries WHERE month=?1`,
      )
      .bind(month)
      .all<EntryRow>(),
    database
      .prepare("SELECT amount_cents AS amountCents FROM finance_store_revenue WHERE month=?1")
      .bind(month)
      .all<{ amountCents: number }>(),
    loadPayrollDreContribution(database, "stores", month),
  ]);

  // Soma todos os lançamentos de todas as lojas por item (sem manter a
  // quebra por loja) — usado tanto pela DRE Consolidada (só total por
  // categoria) quanto pela Gerencial (total por item, dentro da categoria).
  const totalByItem = new Map<string, number>();
  for (const entry of entries.results ?? []) {
    totalByItem.set(entry.itemId, (totalByItem.get(entry.itemId) ?? 0) + itemTotal(entry));
  }
  for (const [itemId, cents] of payroll.byItem) {
    totalByItem.set(itemId, (totalByItem.get(itemId) ?? 0) + cents);
  }
  const revenueCents = (revenue.results ?? []).reduce((sum, row) => sum + (row.amountCents ?? 0), 0);

  return { allCategories, allItems, totalByItem, revenueCents };
}

export async function buildConsolidatedDre(
  database: Awaited<ReturnType<typeof getD1>>,
  month: string,
): Promise<ConsolidatedDreResult> {
  const { allCategories, allItems, totalByItem, revenueCents } = await loadMonthWideTotals(
    database,
    month,
  );

  const { topCategories, subcategoriesByParent } = groupCategories(allCategories);
  const itemsByCategory = groupItemsByCategory(allItems);

  const dreCategories: ConsolidatedCategory[] = topCategories.map((category) => {
    const directTotal = (itemsByCategory.get(category.id) ?? []).reduce(
      (sum, item) => sum + (totalByItem.get(item.id) ?? 0),
      0,
    );
    const subgroupsTotal = (subcategoriesByParent.get(category.id) ?? []).reduce(
      (sum, subgroup) =>
        sum +
        (itemsByCategory.get(subgroup.id) ?? []).reduce(
          (subSum, item) => subSum + (totalByItem.get(item.id) ?? 0),
          0,
        ),
      0,
    );
    return { id: category.id, name: category.name, totalCents: directTotal + subgroupsTotal };
  });

  const expenseTotalCents = dreCategories.reduce((sum, category) => sum + category.totalCents, 0);
  const resultCents = revenueCents - expenseTotalCents;
  const marginBasisPoints = revenueCents > 0 ? Math.round((resultCents / revenueCents) * 10000) : 0;

  return { revenueCents, expenseTotalCents, resultCents, marginBasisPoints, categories: dreCategories };
}

export async function buildManagerialDre(
  database: Awaited<ReturnType<typeof getD1>>,
  month: string,
): Promise<ManagerialDreResult> {
  const { allCategories, allItems, totalByItem, revenueCents } = await loadMonthWideTotals(
    database,
    month,
  );

  const { topCategories, subcategoriesByParent } = groupCategories(allCategories);
  const itemsByCategory = groupItemsByCategory(allItems);

  function buildManagerialItem(item: ItemRow): ManagerialItem {
    return { id: item.id, name: item.name, totalCents: totalByItem.get(item.id) ?? 0 };
  }

  const dreCategories: ManagerialCategory[] = topCategories.map((category) => {
    const directItems = (itemsByCategory.get(category.id) ?? []).map(buildManagerialItem);
    const subgroups = (subcategoriesByParent.get(category.id) ?? []).map((subgroup) => {
      const subgroupItems = (itemsByCategory.get(subgroup.id) ?? []).map(buildManagerialItem);
      const totalCents = subgroupItems.reduce((sum, item) => sum + item.totalCents, 0);
      return { id: subgroup.id, name: subgroup.name, totalCents, items: subgroupItems };
    });
    const totalCents =
      directItems.reduce((sum, item) => sum + item.totalCents, 0) +
      subgroups.reduce((sum, subgroup) => sum + subgroup.totalCents, 0);
    return { id: category.id, name: category.name, totalCents, items: directItems, subgroups };
  });

  const expenseTotalCents = dreCategories.reduce((sum, category) => sum + category.totalCents, 0);
  const resultCents = revenueCents - expenseTotalCents;
  const marginBasisPoints = revenueCents > 0 ? Math.round((resultCents / revenueCents) * 10000) : 0;

  return { revenueCents, expenseTotalCents, resultCents, marginBasisPoints, categories: dreCategories };
}

// Comparativo entre unidades: mesma DRE "Por Loja" rodada pra cada loja
// cadastrada, mas só o total por categoria de topo (o detalhe de
// subgrupo/item continua exclusivo da aba Por Loja — aqui o objetivo é
// olhar lado a lado, não editar). Também reaproveitado pelo indicador
// "Gastos por unidade" do Dashboard Geral.
export async function buildByStoreDre(
  database: Awaited<ReturnType<typeof getD1>>,
  month: string,
): Promise<ByStoreDreResult> {
  const companies = await loadCompanyList(database);
  const stores = await Promise.all(
    companies.map(async (company) => {
      const result = await buildStoreDre(database, company.id, month);
      return {
        storeId: company.id,
        storeName: company.name,
        revenueCents: result.revenueCents,
        expenseTotalCents: result.expenseTotalCents,
        resultCents: result.resultCents,
        marginBasisPoints: result.marginBasisPoints,
        categories: result.categories.map((category) => ({
          id: category.id,
          name: category.name,
          totalCents: category.totalCents,
        })),
      };
    }),
  );
  return { stores };
}

export function monthsBetween(monthFrom: string, monthTo: string): string[] {
  const [fromYear, fromMonth] = monthFrom.split("-").map(Number);
  const [toYear, toMonth] = monthTo.split("-").map(Number);
  const months: string[] = [];
  let year = fromYear;
  let monthIndex = fromMonth;
  // Limite de 36 meses (3 anos) — cobre com folga tanto "comparativo
  // mensal" (poucos meses) quanto "comparativo anual" (12 meses), sem
  // deixar um range absurdo travar a rota com centenas de queries.
  let guard = 0;
  while ((year < toYear || (year === toYear && monthIndex <= toMonth)) && guard < 36) {
    months.push(`${year}-${String(monthIndex).padStart(2, "0")}`);
    monthIndex += 1;
    if (monthIndex > 12) {
      monthIndex = 1;
      year += 1;
    }
    guard += 1;
  }
  return months;
}

// Comparativo mensal E anual usam a mesma série — a diferença é só o
// tamanho do range que o front-end pede (poucos meses vs. 12).
export async function buildDreSeries(
  database: Awaited<ReturnType<typeof getD1>>,
  seriesScope: "store" | "consolidated",
  storeId: string,
  monthFrom: string,
  monthTo: string,
) {
  const months = monthsBetween(monthFrom, monthTo);
  const series = await Promise.all(
    months.map(async (month) => {
      const result =
        seriesScope === "store" ? await buildStoreDre(database, storeId, month) : await buildConsolidatedDre(database, month);
      return {
        month,
        revenueCents: result.revenueCents,
        expenseTotalCents: result.expenseTotalCents,
        resultCents: result.resultCents,
        marginBasisPoints: result.marginBasisPoints,
        categories: result.categories.map((category) => ({
          id: category.id,
          name: category.name,
          totalCents: category.totalCents,
        })),
      };
    }),
  );
  return { months, series };
}
