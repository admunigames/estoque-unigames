import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import {
  allStoresFor,
  can,
  identity,
  ITEM_COLUMNS,
  jsonResponse,
  normalizeItem,
  safeText,
  type ItemRow,
} from "../shared";

type InventoryRow = ItemRow & { companyId: string; companyName: string; requestCreatedAt: string };

// Aba INVENTÁRIO: itens ANOTADO PARA INVENTÁRIO ainda não inventariados
// (view=active) ou já marcados INVENTARIADO (view=history), por loja.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "divergencias:inventory")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER O INVENTÁRIO DE DIVERGÊNCIAS." }, 403);
  }
  try {
    const url = new URL(request.url);
    const allStores = allStoresFor(actor, "divergencias:inventory");
    if (!allStores && !hasCompany(actor.companyId)) {
      return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
    }
    const history = url.searchParams.get("view") === "history";
    const requestedCompany = safeText(url.searchParams.get("companyId"), 80);
    const companyFilter = allStores ? (hasCompany(requestedCompany) ? requestedCompany : "") : actor.companyId;
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT ${ITEM_COLUMNS}, r.company_id AS companyId, r.company_name AS companyName,
                r.created_at AS requestCreatedAt
         FROM divergence_items i
         JOIN divergence_requests r ON r.id=i.request_id
         WHERE i.status='inventario' AND ${history ? "i.inventoried_at<>''" : "i.inventoried_at=''"}
           ${companyFilter ? "AND r.company_id=?1" : ""}
         ORDER BY ${history ? "i.inventoried_at DESC" : "r.company_name, i.product_name"}
         LIMIT 1000`,
      )
      .bind(...(companyFilter ? [companyFilter] : []))
      .all<InventoryRow>();
    return jsonResponse({
      allStores,
      view: history ? "history" : "active",
      items: (result.results ?? []).map((row) => ({ ...row, ...normalizeItem(row) })),
    });
  } catch (error) {
    console.error("Não foi possível carregar o inventário de divergências.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O INVENTÁRIO." }, 500);
  }
}
