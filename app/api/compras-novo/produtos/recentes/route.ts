import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse } from "../../shared";

type RecentRow = {
  productCode: string;
  productName: string;
  quantity: number;
  supplierId: string;
  supplierNameRaw: string;
  orderStatus: string;
  createdAt: string;
};

type SupplierRow = { id: string; name: string };

// "Últimos produtos comprados" — tela inicial da aba Compras (item 1 do
// pedido original, nunca tinha sido implementado de verdade: só existia o
// histórico POR produto, sob busca). Sem filtro nenhum, ordenado pelos
// itens de pedido nativos criados mais recentemente (não usa order_date,
// que costuma ficar vazio em pedido nativo antes de "aguardando_chegada").
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O MÓDULO DE COMPRAS." }, 403);
  }

  try {
    const database = await getD1();
    const rowsResult = await database
      .prepare(
        `SELECT poi.product_code AS productCode, poi.product_name AS productName, poi.quantity AS quantity,
                po.supplier_id AS supplierId, po.supplier_name_raw AS supplierNameRaw,
                po.status AS orderStatus, poi.created_at AS createdAt
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.order_id
         WHERE po.origin='native' AND po.canceled=0
         ORDER BY poi.created_at DESC
         LIMIT 15`,
      )
      .all<RecentRow>();
    const rows = rowsResult.results ?? [];

    const supplierIds = Array.from(new Set(rows.filter((row) => row.supplierId).map((row) => row.supplierId)));
    const supplierNameById = new Map<string, string>();
    if (supplierIds.length) {
      const placeholders = supplierIds.map((_, index) => `?${index + 1}`).join(",");
      const suppliersResult = await database
        .prepare(`SELECT id, name FROM finance_suppliers WHERE id IN (${placeholders})`)
        .bind(...supplierIds)
        .all<SupplierRow>();
      for (const row of suppliersResult.results ?? []) supplierNameById.set(row.id, row.name);
    }

    const items = rows.map((row) => ({
      productCode: row.productCode,
      productName: row.productName,
      quantity: row.quantity,
      supplierName: row.supplierId ? supplierNameById.get(row.supplierId) || row.supplierNameRaw : "",
      orderStatus: row.orderStatus,
      createdAt: row.createdAt,
    }));

    return jsonResponse({ items });
  } catch (error) {
    console.error("Não foi possível carregar os produtos comprados recentemente.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS ÚLTIMOS PRODUTOS COMPRADOS." }, 500);
  }
}
