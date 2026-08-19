import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  canManageFinance,
  identity,
  jsonResponse,
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
  itemId: string;
  entryType: string;
  amountCents: number | null;
  percentBasisPoints: number | null;
};

type DreItem = {
  id: string;
  name: string;
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
  const month = safeText(url.searchParams.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }

  if (scope !== "store") {
    return jsonResponse({ error: "ESCOPO DE DRE AINDA NÃO DISPONÍVEL." }, 400);
  }

  const storeId = safeText(url.searchParams.get("storeId"), 80);
  if (!storeId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);

  try {
    const database = await getD1();
    const [categories, items, entries, revenue] = await Promise.all([
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
      database
        .prepare(
          `SELECT item_id AS itemId, entry_type AS entryType,
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
        entryType: entry?.entryType ?? null,
        amountCents: entry?.amountCents ?? null,
        percentBasisPoints: entry?.percentBasisPoints ?? null,
      };
    }

    function itemTotal(item: DreItem): number {
      return item.entryType === "fixed" ? item.amountCents ?? 0 : 0;
    }

    const allCategories = categories.results ?? [];
    const allItems = items.results ?? [];
    const topCategories = allCategories.filter((category) => !category.parentId);
    const subcategoriesByParent = new Map<string, CategoryRow[]>();
    for (const category of allCategories) {
      if (!category.parentId) continue;
      const list = subcategoriesByParent.get(category.parentId) ?? [];
      list.push(category);
      subcategoriesByParent.set(category.parentId, list);
    }
    const itemsByCategory = new Map<string, ItemRow[]>();
    for (const item of allItems) {
      const list = itemsByCategory.get(item.categoryId) ?? [];
      list.push(item);
      itemsByCategory.set(item.categoryId, list);
    }

    const dreCategories: DreCategory[] = topCategories.map((category) => {
      const directItems = (itemsByCategory.get(category.id) ?? []).map(buildItem);
      const subgroups = (subcategoriesByParent.get(category.id) ?? []).map((subgroup) => {
        const subgroupItems = (itemsByCategory.get(subgroup.id) ?? []).map(buildItem);
        const totalCents = subgroupItems.reduce((sum, item) => sum + itemTotal(item), 0);
        return { id: subgroup.id, name: subgroup.name, totalCents, items: subgroupItems };
      });
      const totalCents =
        directItems.reduce((sum, item) => sum + itemTotal(item), 0) +
        subgroups.reduce((sum, subgroup) => sum + subgroup.totalCents, 0);
      return { id: category.id, name: category.name, totalCents, items: directItems, subgroups };
    });

    const revenueCents = revenue?.amountCents ?? 0;
    const expenseTotalCents = dreCategories.reduce((sum, category) => sum + category.totalCents, 0);
    const resultCents = revenueCents - expenseTotalCents;
    const marginBasisPoints = revenueCents > 0 ? Math.round((resultCents / revenueCents) * 10000) : 0;

    return jsonResponse({
      scope,
      storeId,
      month,
      revenueCents,
      expenseTotalCents,
      resultCents,
      marginBasisPoints,
      categories: dreCategories,
    });
  } catch (error) {
    console.error("Não foi possível montar a DRE.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MONTAR A DRE." }, 500);
  }
}
