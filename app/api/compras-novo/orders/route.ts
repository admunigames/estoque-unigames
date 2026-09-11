import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, safeText } from "../shared";

type OrderRow = {
  id: string;
  origin: string;
  notionPurchaseId: string;
  notionPurchaseUrl: string;
  supplierId: string;
  supplierNameRaw: string;
  companyId: string;
  companyName: string;
  orderDate: string;
  expectedDate: string;
  receivedDate: string;
  division: string;
  divisionStatus: string;
  status: string;
  noItemsDetailed: number;
  notes: string;
  canceled: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

type SupplierRow = { id: string; name: string };
type ItemCountRow = { orderId: string; itemCount: number };

// Fase B: lista pedidos nativos (origin='native') e importados do Notion
// (origin='notion_import') JUNTOS — a importação do Notion existe
// justamente para virar histórico consultável/editável dentro do mesmo
// módulo, ver decisão confirmada no escopo da Fase B.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O MÓDULO DE COMPRAS." }, 403);
  }

  const url = new URL(request.url);
  const status = safeText(url.searchParams.get("status"), 20);
  const origin = safeText(url.searchParams.get("origin"), 20);
  // Cancelado some da visão padrão (mesmo padrão do checkbox "mostrar
  // arquivados/convertidos" da aba Rascunhos) — só reaparece com
  // includeCanceled=1.
  const includeCanceled = url.searchParams.get("includeCanceled") === "1";

  try {
    const database = await getD1();
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (status) {
      values.push(status);
      conditions.push(`status=?${values.length}`);
    }
    if (origin) {
      values.push(origin);
      conditions.push(`origin=?${values.length}`);
    }
    if (!includeCanceled) {
      conditions.push(`canceled=0`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const ordersResult = await database
      .prepare(
        `SELECT id, origin, notion_purchase_id AS notionPurchaseId, notion_purchase_url AS notionPurchaseUrl,
                supplier_id AS supplierId, supplier_name_raw AS supplierNameRaw,
                company_id AS companyId, company_name AS companyName,
                order_date AS orderDate, expected_date AS expectedDate, received_date AS receivedDate,
                division, division_status AS divisionStatus, status, no_items_detailed AS noItemsDetailed, notes,
                canceled,
                created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
                updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt
         FROM purchase_orders
         ${where}
         ORDER BY created_at DESC`,
      )
      .bind(...values)
      .all<OrderRow>();
    const orders = ordersResult.results ?? [];

    // Nomes de fornecedor pra pedidos nativos (supplierNameRaw só é
    // preenchido nos importados do Notion) — 2 queries simples em vez de
    // um join pesado, como pedido no escopo.
    const nativeSupplierIds = Array.from(
      new Set(orders.filter((order) => order.origin === "native" && order.supplierId).map((order) => order.supplierId)),
    );
    const supplierNameById = new Map<string, string>();
    if (nativeSupplierIds.length) {
      const placeholders = nativeSupplierIds.map((_, index) => `?${index + 1}`).join(",");
      const suppliersResult = await database
        .prepare(`SELECT id, name FROM finance_suppliers WHERE id IN (${placeholders})`)
        .bind(...nativeSupplierIds)
        .all<SupplierRow>();
      for (const row of suppliersResult.results ?? []) supplierNameById.set(row.id, row.name);
    }

    const orderIds = orders.map((order) => order.id);
    const itemCountByOrderId = new Map<string, number>();
    if (orderIds.length) {
      const placeholders = orderIds.map((_, index) => `?${index + 1}`).join(",");
      const countsResult = await database
        .prepare(
          `SELECT order_id AS orderId, COUNT(*) AS itemCount
           FROM purchase_order_items WHERE order_id IN (${placeholders}) GROUP BY order_id`,
        )
        .bind(...orderIds)
        .all<ItemCountRow>();
      for (const row of countsResult.results ?? []) itemCountByOrderId.set(row.orderId, Number(row.itemCount));
    }

    const enriched = orders.map((order) => ({
      ...order,
      supplierName: order.origin === "native" ? supplierNameById.get(order.supplierId) || "" : order.supplierNameRaw,
      itemCount: itemCountByOrderId.get(order.id) || 0,
    }));

    return jsonResponse({ orders: enriched });
  } catch (error) {
    console.error("Não foi possível carregar os pedidos de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS PEDIDOS." }, 500);
  }
}
