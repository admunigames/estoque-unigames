import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse } from "../../shared";

type ItemRow = {
  supplierId: string;
  orderDate: string;
  quantity: number;
  unitPriceCents: number;
};

type SupplierRow = { id: string; name: string };

// Fase D, item 3: "Compras por Produto" — busca (não varredura de todos os
// produtos) por productCode, olhando só purchase_order_items de pedidos
// NATIVOS (origin='native') não cancelados. Pedidos importados do Notion
// não têm purchase_order_items (noItemsDetailed=1), então já ficam de fora
// naturalmente, sem precisar de filtro extra além do JOIN.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O MÓDULO DE COMPRAS." }, 403);
  }

  const url = new URL(request.url);
  const produto = (url.searchParams.get("produto") || "").trim();
  if (!produto) return jsonResponse({ error: "INFORME O CÓDIGO DO PRODUTO." }, 400);

  try {
    const database = await getD1();
    const itemsResult = await database
      .prepare(
        `SELECT po.supplier_id AS supplierId, po.order_date AS orderDate,
                poi.quantity AS quantity, poi.unit_price_cents AS unitPriceCents
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.order_id
         WHERE poi.product_code=?1 AND po.origin='native' AND po.canceled=0
         ORDER BY po.order_date DESC`,
      )
      .bind(produto)
      .all<ItemRow>();
    const items = itemsResult.results ?? [];

    const supplierIds = Array.from(new Set(items.filter((item) => item.supplierId).map((item) => item.supplierId)));
    const supplierNameById = new Map<string, string>();
    if (supplierIds.length) {
      const placeholders = supplierIds.map((_, index) => `?${index + 1}`).join(",");
      const suppliersResult = await database
        .prepare(`SELECT id, name FROM finance_suppliers WHERE id IN (${placeholders})`)
        .bind(...supplierIds)
        .all<SupplierRow>();
      for (const row of suppliersResult.results ?? []) supplierNameById.set(row.id, row.name);
    }

    // Agrupa por fornecedor — items já vem ordenado por orderDate DESC, então
    // o primeiro item de cada grupo é o mais recente (preço mais recente
    // informado e data do pedido mais recente).
    type SupplierAgg = {
      supplierId: string;
      supplierName: string;
      totalQuantity: number;
      lastOrderDate: string;
      lastUnitPriceCents: number;
    };
    const bySupplier = new Map<string, SupplierAgg>();
    let totalQuantity = 0;
    let lastPurchaseDate = "";

    for (const item of items) {
      const supplierId = item.supplierId || "";
      totalQuantity += Number(item.quantity) || 0;
      if (item.orderDate && (!lastPurchaseDate || item.orderDate > lastPurchaseDate)) lastPurchaseDate = item.orderDate;

      let agg = bySupplier.get(supplierId);
      if (!agg) {
        agg = {
          supplierId,
          supplierName: supplierNameById.get(supplierId) || "",
          totalQuantity: 0,
          lastOrderDate: item.orderDate || "",
          lastUnitPriceCents: 0,
        };
        bySupplier.set(supplierId, agg);
      }
      agg.totalQuantity += Number(item.quantity) || 0;
      // Primeiro item com preço > 0 encontrado (na ordem DESC por data) é o
      // preço mais recente informado por esse fornecedor.
      if (!agg.lastUnitPriceCents && Number(item.unitPriceCents) > 0) {
        agg.lastUnitPriceCents = Number(item.unitPriceCents);
      }
    }

    // Número de pedidos distintos: conta pelas datas de pedido únicas só
    // como aproximação seria frágil (duas ordens no mesmo dia) — em vez
    // disso, reconsulta contando order_id distinto.
    const orderCountResult = await database
      .prepare(
        `SELECT COUNT(DISTINCT poi.order_id) AS total
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.order_id
         WHERE poi.product_code=?1 AND po.origin='native' AND po.canceled=0`,
      )
      .bind(produto)
      .first<{ total: number }>();

    // Fase F: "em andamento" (a caminho) e "atrasado" — só olham pedidos
    // NATIVOS já com vencedor definido (status='aguardando_chegada'), que é
    // quando o item efetivamente está "a caminho".
    const inProgressResult = await database
      .prepare(
        `SELECT COALESCE(SUM(poi.quantity - poi.received_quantity), 0) AS total
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.order_id
         WHERE poi.product_code=?1 AND po.origin='native' AND po.canceled=0 AND po.status='aguardando_chegada'`,
      )
      .bind(produto)
      .first<{ total: number }>();

    // Mesma regra de atraso que comprasOrderIsLate() usa no cliente:
    // expectedDate preenchida, anterior a hoje, pedido não concluído/cancelado.
    const today = new Date().toISOString().slice(0, 10);
    const lateResult = await database
      .prepare(
        `SELECT COALESCE(SUM(poi.quantity - poi.received_quantity), 0) AS total
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.order_id
         WHERE poi.product_code=?1 AND po.origin='native' AND po.canceled=0
           AND po.status != 'concluido' AND po.expected_date != '' AND po.expected_date < ?2`,
      )
      .bind(produto, today)
      .first<{ total: number }>();

    const suppliers = Array.from(bySupplier.values()).sort((a, b) => b.totalQuantity - a.totalQuantity);

    return jsonResponse({
      produto,
      totalQuantity,
      distinctOrderCount: Number(orderCountResult?.total) || 0,
      lastPurchaseDate,
      inProgressQuantity: Number(inProgressResult?.total) || 0,
      lateQuantity: Number(lateResult?.total) || 0,
      suppliers,
    });
  } catch (error) {
    console.error("Não foi possível carregar o histórico de compras do produto.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O HISTÓRICO." }, 500);
  }
}
