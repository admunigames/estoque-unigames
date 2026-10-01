import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, resolveProductCodes, safeText } from "../shared";

type NativeItemRow = {
  orderId: string;
  orderDate: string;
  createdAt: string;
  status: string;
  expectedDate: string;
  canceled: number;
  supplierId: string;
  productCode: string;
  productName: string;
  quantity: number;
  receivedQuantity: number;
  unitPriceCents: number;
  targetStores: string;
};

type NotionOrderRow = {
  orderId: string;
  orderDate: string;
  createdAt: string;
  status: string;
  expectedDate: string;
  canceled: number;
  supplierId: string;
  supplierNameRaw: string;
  companyName: string;
};

type SupplierRow = { id: string; name: string };

type ResultRow = {
  orderId: string;
  origin: "native" | "notion_import";
  orderDate: string;
  status: string;
  expectedDate: string;
  canceled: number;
  supplierId: string;
  supplierName: string;
  storeNames: string[];
  productCode: string;
  productName: string;
  quantity: number | null;
  receivedQuantity: number | null;
  unitPriceCents: number | null;
};

const MAX_ROWS = 500;

// Aba "Pesquisa" do Compras nativo — filtros combináveis (AND) por loja,
// produto e fornecedor, 1 linha por ITEM de pedido nativo. Pedidos
// importados do Notion não têm itens (noItemsDetailed=1): entram como 1
// linha por pedido só quando não há filtro de produto.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O MÓDULO DE COMPRAS." }, 403);
  }

  const url = new URL(request.url);
  const loja = safeText(url.searchParams.get("loja"), 80);
  const produto = safeText(url.searchParams.get("produto"), 80);
  const fornecedor = safeText(url.searchParams.get("fornecedor"), 80);
  const includeCanceled = url.searchParams.get("includeCanceled") === "1";
  if (!loja && !produto && !fornecedor) {
    return jsonResponse({ error: "INFORME AO MENOS UM FILTRO." }, 400);
  }

  try {
    const database = await getD1();
    // sortKey fica fora da linha devolvida: order_date (vazia em nativos
    // antigos) com created_at como reserva.
    const entries: Array<{ sortKey: string; row: ResultRow }> = [];

    const conditions: string[] = [`po.origin='native'`];
    const values: unknown[] = [];
    if (!includeCanceled) conditions.push(`po.canceled=0`);
    if (fornecedor) {
      values.push(fornecedor);
      conditions.push(`po.supplier_id=?${values.length}`);
    }
    // Mesma resolução de código (Unigames/P.A Loja/nome) do "Por Produto" —
    // senão a busca perderia itens lançados com o código do outro sistema.
    if (produto) {
      const matchCodes = await resolveProductCodes(database, produto);
      const placeholders = matchCodes.map((_, index) => `?${values.length + index + 1}`).join(",");
      values.push(...matchCodes);
      conditions.push(`poi.product_code IN (${placeholders})`);
    }
    const itemsResult = await database
      .prepare(
        `SELECT po.id AS orderId, po.order_date AS orderDate, po.created_at AS createdAt, po.status,
                po.expected_date AS expectedDate, po.canceled, po.supplier_id AS supplierId,
                poi.product_code AS productCode, poi.product_name AS productName, poi.quantity,
                poi.received_quantity AS receivedQuantity, poi.unit_price_cents AS unitPriceCents,
                poi.target_stores AS targetStores
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.order_id
         WHERE ${conditions.join(" AND ")}`,
      )
      .bind(...values)
      .all<NativeItemRow>();
    const items = itemsResult.results ?? [];

    // Nomes de fornecedor dos nativos — 2 queries simples em vez de join,
    // mesmo padrão de GET /orders.
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

    // Loja fica no JSON target_stores de cada item ([{companyId, companyName}])
    // — filtrada aqui em JS (volume pequeno), parse tolerante a JSON inválido.
    for (const item of items) {
      let stores: Array<{ companyId?: unknown; companyName?: unknown }> = [];
      try {
        const parsed = JSON.parse(item.targetStores || "[]");
        if (Array.isArray(parsed)) stores = parsed;
      } catch {
        stores = [];
      }
      if (loja && !stores.some((store) => store && store.companyId === loja)) continue;
      const storeNames = Array.from(
        new Set(
          stores
            .map((store) => (store && typeof store.companyName === "string" ? store.companyName.trim() : ""))
            .filter(Boolean),
        ),
      );
      entries.push({
        sortKey: item.orderDate || item.createdAt || "",
        row: {
          orderId: item.orderId,
          origin: "native",
          orderDate: item.orderDate,
          status: item.status,
          expectedDate: item.expectedDate,
          canceled: Number(item.canceled),
          supplierId: item.supplierId,
          supplierName: supplierNameById.get(item.supplierId) || "",
          storeNames,
          productCode: item.productCode,
          productName: item.productName,
          quantity: Number(item.quantity),
          receivedQuantity: Number(item.receivedQuantity),
          unitPriceCents: Number(item.unitPriceCents),
        },
      });
    }

    // Notion: sem itens detalhados, então só entra sem filtro de produto.
    if (!produto) {
      const notionConditions: string[] = [`origin='notion_import'`];
      const notionValues: unknown[] = [];
      if (!includeCanceled) notionConditions.push(`canceled=0`);
      if (fornecedor) {
        notionValues.push(fornecedor);
        notionConditions.push(`supplier_id=?${notionValues.length}`);
      }
      if (loja) {
        notionValues.push(loja);
        notionConditions.push(`company_id=?${notionValues.length}`);
      }
      const notionResult = await database
        .prepare(
          `SELECT id AS orderId, order_date AS orderDate, created_at AS createdAt, status,
                  expected_date AS expectedDate, canceled, supplier_id AS supplierId,
                  supplier_name_raw AS supplierNameRaw, company_name AS companyName
           FROM purchase_orders
           WHERE ${notionConditions.join(" AND ")}`,
        )
        .bind(...notionValues)
        .all<NotionOrderRow>();
      for (const order of notionResult.results ?? []) {
        entries.push({
          sortKey: order.orderDate || order.createdAt || "",
          row: {
            orderId: order.orderId,
            origin: "notion_import",
            orderDate: order.orderDate,
            status: order.status,
            expectedDate: order.expectedDate,
            canceled: Number(order.canceled),
            supplierId: order.supplierId,
            supplierName: order.supplierNameRaw,
            storeNames: order.companyName ? [order.companyName] : [],
            productCode: "",
            productName: "SEM ITENS DETALHADOS",
            quantity: null,
            receivedQuantity: null,
            unitPriceCents: null,
          },
        });
      }
    }

    entries.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
    const truncated = entries.length > MAX_ROWS;
    const rows = entries.slice(0, MAX_ROWS).map((entry) => entry.row);
    return jsonResponse({ rows, truncated });
  } catch (error) {
    console.error("Não foi possível pesquisar as compras.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL PESQUISAR AS COMPRAS." }, 500);
  }
}
