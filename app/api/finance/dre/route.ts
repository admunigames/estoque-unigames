import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  canManageFinance,
  identity,
  jsonResponse,
  loadCompanyList,
  MONTH_PATTERN,
  safeText,
} from "../shared";

type CategoryRow = {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
};

type ItemRow = {
  id: string;
  categoryId: string;
  name: string;
  position: number;
};

type EntryRow = {
  id?: string;
  itemId: string;
  entryType: string;
  amountCents: number | null;
  percentBasisPoints: number | null;
};

type DreItem = {
  id: string;
  name: string;
  entryId: string | null;
  entryType: string | null;
  amountCents: number | null;
  percentBasisPoints: number | null;
};

type DreCategory = {
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

type ConsolidatedCategory = {
  id: string;
  name: string;
  totalCents: number;
};

type ManagerialItem = {
  id: string;
  name: string;
  totalCents: number;
};

type ManagerialCategory = {
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

function itemTotal(entry: EntryRow | undefined): number {
  return entry?.entryType === "fixed" ? entry.amountCents ?? 0 : 0;
}

function groupCategories(allCategories: CategoryRow[]) {
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

function groupItemsByCategory(allItems: ItemRow[]) {
  const itemsByCategory = new Map<string, ItemRow[]>();
  for (const item of allItems) {
    const list = itemsByCategory.get(item.categoryId) ?? [];
    list.push(item);
    itemsByCategory.set(item.categoryId, list);
  }
  return itemsByCategory;
}

async function loadCatalog(database: Awaited<ReturnType<typeof getD1>>) {
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

async function buildStoreDre(
  database: Awaited<ReturnType<typeof getD1>>,
  storeId: string,
  month: string,
) {
  const [{ allCategories, allItems }, entries, revenue] = await Promise.all([
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
  ]);

  const entryByItem = new Map<string, EntryRow>();
  for (const entry of entries.results ?? []) entryByItem.set(entry.itemId, entry);

  function buildItem(item: ItemRow): DreItem {
    const entry = entryByItem.get(item.id);
    return {
      id: item.id,
      name: item.name,
      entryId: entry?.id ?? null,
      entryType: entry?.entryType ?? null,
      amountCents: entry?.amountCents ?? null,
      percentBasisPoints: entry?.percentBasisPoints ?? null,
    };
  }

  const { topCategories, subcategoriesByParent } = groupCategories(allCategories);
  const itemsByCategory = groupItemsByCategory(allItems);

  const dreCategories: DreCategory[] = topCategories.map((category) => {
    const directItems = (itemsByCategory.get(category.id) ?? []).map(buildItem);
    const subgroups = (subcategoriesByParent.get(category.id) ?? []).map((subgroup) => {
      const subgroupItems = (itemsByCategory.get(subgroup.id) ?? []).map(buildItem);
      const totalCents = subgroupItems.reduce(
        (sum, item) => sum + itemTotal(entryByItem.get(item.id)),
        0,
      );
      return { id: subgroup.id, name: subgroup.name, totalCents, items: subgroupItems };
    });
    const totalCents =
      directItems.reduce((sum, item) => sum + itemTotal(entryByItem.get(item.id)), 0) +
      subgroups.reduce((sum, subgroup) => sum + subgroup.totalCents, 0);
    return { id: category.id, name: category.name, totalCents, items: directItems, subgroups };
  });

  const revenueCents = revenue?.amountCents ?? 0;
  const expenseTotalCents = dreCategories.reduce((sum, category) => sum + category.totalCents, 0);
  const resultCents = revenueCents - expenseTotalCents;
  const marginBasisPoints = revenueCents > 0 ? Math.round((resultCents / revenueCents) * 10000) : 0;

  return { revenueCents, expenseTotalCents, resultCents, marginBasisPoints, categories: dreCategories };
}

async function loadMonthWideTotals(database: Awaited<ReturnType<typeof getD1>>, month: string) {
  const [{ allCategories, allItems }, entries, revenue] = await Promise.all([
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
  ]);

  // Soma todos os lançamentos de todas as lojas por item (sem manter a
  // quebra por loja) — usado tanto pela DRE Consolidada (só total por
  // categoria) quanto pela Gerencial (total por item, dentro da categoria).
  const totalByItem = new Map<string, number>();
  for (const entry of entries.results ?? []) {
    totalByItem.set(entry.itemId, (totalByItem.get(entry.itemId) ?? 0) + itemTotal(entry));
  }
  const revenueCents = (revenue.results ?? []).reduce((sum, row) => sum + (row.amountCents ?? 0), 0);

  return { allCategories, allItems, totalByItem, revenueCents };
}

async function buildConsolidatedDre(database: Awaited<ReturnType<typeof getD1>>, month: string) {
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

async function buildManagerialDre(database: Awaited<ReturnType<typeof getD1>>, month: string) {
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
// olhar lado a lado, não editar).
async function buildByStoreDre(database: Awaited<ReturnType<typeof getD1>>, month: string) {
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

function monthsBetween(monthFrom: string, monthTo: string): string[] {
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
async function buildDreSeries(
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

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." },
      403,
    );
  }

  const url = new URL(request.url);
  const scope = safeText(url.searchParams.get("scope"), 20) || "store";

  const VALID_SCOPES = new Set(["store", "consolidated", "managerial", "by-store", "series"]);
  if (!VALID_SCOPES.has(scope)) {
    return jsonResponse({ error: "ESCOPO DE DRE AINDA NÃO DISPONÍVEL." }, 400);
  }

  try {
    const database = await getD1();

    if (scope === "series") {
      const seriesScope = safeText(url.searchParams.get("seriesScope"), 20) === "store" ? "store" : "consolidated";
      const monthFrom = safeText(url.searchParams.get("monthFrom"), 7);
      const monthTo = safeText(url.searchParams.get("monthTo"), 7);
      if (!MONTH_PATTERN.test(monthFrom) || !MONTH_PATTERN.test(monthTo)) {
        return jsonResponse({ error: "INFORME UM PERÍODO VÁLIDO (AAAA-MM ATÉ AAAA-MM)." }, 400);
      }
      if (monthFrom > monthTo) {
        return jsonResponse({ error: "O MÊS INICIAL NÃO PODE SER DEPOIS DO MÊS FINAL." }, 400);
      }
      const storeId = safeText(url.searchParams.get("storeId"), 80);
      if (seriesScope === "store" && !storeId) {
        return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
      }
      const result = await buildDreSeries(database, seriesScope, storeId, monthFrom, monthTo);
      return jsonResponse({ scope, seriesScope, storeId: seriesScope === "store" ? storeId : null, ...result });
    }

    const month = safeText(url.searchParams.get("month"), 7);
    if (!MONTH_PATTERN.test(month)) {
      return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
    }

    if (scope === "by-store") {
      const result = await buildByStoreDre(database, month);
      return jsonResponse({ scope, month, ...result });
    }

    if (scope === "consolidated") {
      const result = await buildConsolidatedDre(database, month);
      return jsonResponse({ scope, month, ...result });
    }

    if (scope === "managerial") {
      const result = await buildManagerialDre(database, month);
      return jsonResponse({ scope, month, ...result });
    }

    const storeId = safeText(url.searchParams.get("storeId"), 80);
    if (!storeId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
    const result = await buildStoreDre(database, storeId, month);
    return jsonResponse({ scope, storeId, month, ...result });
  } catch (error) {
    console.error("Não foi possível montar a DRE.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MONTAR A DRE." }, 500);
  }
}
