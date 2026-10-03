import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { hasCompany } from "../../../lib/access-scope";
import {
  divergenceOf,
  isDateOnly,
  isOverdueUnseen,
  productKey,
  recifeDayStartIso,
  recifeNextDayStartIso,
} from "../../../lib/divergences";
import {
  allStoresForAny,
  canAny,
  identity,
  jsonResponse,
  READ_PERMISSIONS,
  safeText,
} from "../shared";

type Row = {
  requestId: string;
  requestStatus: string;
  companyId: string;
  companyName: string;
  itemId: string | null;
  productCode: string | null;
  productName: string | null;
  physicalQty: number | null;
  systemQty: number | null;
  itemStatus: string | null;
  itemCreatedAt: string | null;
};

type StoreStats = {
  companyId: string;
  companyName: string;
  requests: number;
  items: number;
  missing: number;
  surplus: number;
  pending: number;
};

type ProductStats = {
  productCode: string;
  productName: string;
  occurrences: number;
  totalAbs: number;
  stores: Map<string, { companyName: string; divergence: number; items: number }>;
};

// Números do DASHBOARD, sempre no escopo do usuário (loja própria ou todas)
// e no período de criação do pedido (datas de Recife).
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAny(actor, READ_PERMISSIONS)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VISUALIZAR AS DIVERGÊNCIAS." }, 403);
  }
  try {
    const url = new URL(request.url);
    // O DASHBOARD é só para quem tem acesso geral (todas as lojas) — regra
    // do usuário (03/10/2026); a loja vê apenas os próprios pedidos.
    const allStores = allStoresForAny(actor, READ_PERMISSIONS);
    if (!allStores) {
      return jsonResponse({ error: "O DASHBOARD É SÓ PARA QUEM TEM ACESSO GERAL." }, 403);
    }
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (condition: string, value: unknown) => {
      params.push(value);
      conditions.push(condition.replace("?", `?${params.length}`));
    };
    const requestedCompany = safeText(url.searchParams.get("companyId"), 80);
    if (hasCompany(requestedCompany)) add("r.company_id=?", requestedCompany);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (isDateOnly(from)) add("r.created_at>=?", recifeDayStartIso(from));
    if (isDateOnly(to)) add("r.created_at<?", recifeNextDayStartIso(to));
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";

    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT r.id AS requestId, r.status AS requestStatus, r.company_id AS companyId,
                r.company_name AS companyName, i.id AS itemId, i.product_code AS productCode,
                i.product_name AS productName, i.physical_qty AS physicalQty, i.system_qty AS systemQty,
                i.status AS itemStatus, i.created_at AS itemCreatedAt
         FROM divergence_requests r
         LEFT JOIN divergence_items i ON i.request_id=r.id${where}`,
      )
      .bind(...params)
      .all<Row>();

    const requestsByStatus: Record<string, number> = { aberto: 0, verificacao: 0, finalizado: 0 };
    const itemsByStatus: Record<string, number> = {
      nao_visto: 0, em_verificacao: 0, verificacao_loja: 0, concluido: 0, inventario: 0,
    };
    const seenRequests = new Set<string>();
    const stores = new Map<string, StoreStats>();
    const products = new Map<string, ProductStats>();
    let items = 0;
    let totalAbs = 0;
    let overdue = 0;
    const now = new Date();
    for (const row of result.results ?? []) {
      const store = stores.get(row.companyId) || {
        companyId: row.companyId, companyName: row.companyName, requests: 0, items: 0, missing: 0, surplus: 0, pending: 0,
      };
      if (!seenRequests.has(row.requestId)) {
        seenRequests.add(row.requestId);
        requestsByStatus[row.requestStatus] = (requestsByStatus[row.requestStatus] || 0) + 1;
        store.requests += 1;
      }
      stores.set(row.companyId, store);
      if (!row.itemId) continue;
      const status = row.itemStatus || "nao_visto";
      const diff = divergenceOf(Number(row.physicalQty), Number(row.systemQty));
      items += 1;
      totalAbs += Math.abs(diff);
      itemsByStatus[status] = (itemsByStatus[status] || 0) + 1;
      if (isOverdueUnseen(status, row.itemCreatedAt || "", now)) overdue += 1;
      store.items += 1;
      if (diff < 0) store.missing += -diff;
      if (diff > 0) store.surplus += diff;
      if (status !== "concluido" && status !== "inventario") store.pending += 1;

      const key = productKey(row.productCode || "", row.productName || "");
      const product = products.get(key) || {
        productCode: row.productCode || "", productName: row.productName || "", occurrences: 0, totalAbs: 0, stores: new Map(),
      };
      product.occurrences += 1;
      product.totalAbs += Math.abs(diff);
      const perStore = product.stores.get(row.companyId) || { companyName: row.companyName, divergence: 0, items: 0 };
      perStore.divergence += diff;
      perStore.items += 1;
      product.stores.set(row.companyId, perStore);
      products.set(key, product);
    }

    const topProducts = [...products.values()]
      .map((product) => ({
        productCode: product.productCode,
        productName: product.productName,
        occurrences: product.occurrences,
        totalAbs: product.totalAbs,
        storeCount: product.stores.size,
        multiStore: product.stores.size > 1,
        stores: [...product.stores.values()].sort((a, b) => a.companyName.localeCompare(b.companyName, "pt-BR")),
      }))
      .sort((a, b) => b.storeCount - a.storeCount || b.occurrences - a.occurrences || b.totalAbs - a.totalAbs ||
        a.productName.localeCompare(b.productName, "pt-BR"))
      .slice(0, 15);

    return jsonResponse({
      allStores,
      totals: { requests: seenRequests.size, items, totalAbs, overdue },
      requestsByStatus,
      itemsByStatus,
      byStore: [...stores.values()].sort((a, b) =>
        b.missing + b.surplus - (a.missing + a.surplus) || a.companyName.localeCompare(b.companyName, "pt-BR")),
      topProducts,
    });
  } catch (error) {
    console.error("Não foi possível carregar o dashboard de divergências.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O DASHBOARD DE DIVERGÊNCIAS." }, 500);
  }
}
