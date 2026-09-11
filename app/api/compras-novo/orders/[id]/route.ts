import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";

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

type OrderItemRow = {
  id: string;
  orderId: string;
  draftItemId: string;
  productCode: string;
  productName: string;
  quantity: number;
  receivedQuantity: number;
  targetStores: string;
  notes: string;
};

type SupplierRow = { id: string; name: string };

type LinkedInvoiceRow = {
  id: string;
  invoiceNumber: string;
  series: string;
  totalAmountCents: number;
  financialStatus: string;
};

const VALID_STATUSES = new Set(["pendente", "em_andamento", "concluido"]);

async function loadOrder(database: D1Database, id: string) {
  return database
    .prepare(
      `SELECT id, origin, notion_purchase_id AS notionPurchaseId, notion_purchase_url AS notionPurchaseUrl,
              supplier_id AS supplierId, supplier_name_raw AS supplierNameRaw,
              company_id AS companyId, company_name AS companyName,
              order_date AS orderDate, expected_date AS expectedDate, received_date AS receivedDate,
              division, division_status AS divisionStatus, status, no_items_detailed AS noItemsDetailed, notes,
              canceled,
              created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
              updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt
       FROM purchase_orders WHERE id=?1`,
    )
    .bind(id)
    .first<OrderRow>();
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O MÓDULO DE COMPRAS." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const order = await loadOrder(database, id);
    if (!order) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);

    let supplierName = order.supplierNameRaw;
    if (order.origin === "native" && order.supplierId) {
      const supplier = await database
        .prepare("SELECT id, name FROM finance_suppliers WHERE id=?1")
        .bind(order.supplierId)
        .first<SupplierRow>();
      supplierName = supplier?.name || "";
    }

    let items: OrderItemRow[] = [];
    if (!order.noItemsDetailed) {
      const itemsResult = await database
        .prepare(
          `SELECT id, order_id AS orderId, draft_item_id AS draftItemId, product_code AS productCode,
                  product_name AS productName, quantity, received_quantity AS receivedQuantity,
                  target_stores AS targetStores, notes
           FROM purchase_order_items WHERE order_id=?1 ORDER BY created_at ASC`,
        )
        .bind(id)
        .all<OrderItemRow>();
      items = itemsResult.results ?? [];
    }

    // NF já vinculada a este pedido nativo (Fase C, item 2) — usada pela UI
    // pra decidir entre mostrar o resumo da NF ou os botões de criar/vincular.
    const linkedInvoice = await database
      .prepare(
        `SELECT id, invoice_number AS invoiceNumber, series, total_amount_cents AS totalAmountCents,
                financial_status AS financialStatus
         FROM supplier_invoices WHERE purchase_order_id=?1 LIMIT 1`,
      )
      .bind(id)
      .first<LinkedInvoiceRow>();

    return jsonResponse({ order: { ...order, supplierName }, items, linkedInvoice: linkedInvoice || null });
  } catch (error) {
    console.error("Não foi possível carregar o pedido de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O PEDIDO." }, 500);
  }
}

// PATCH: só notes, status (manual — útil pra pedidos importados do Notion,
// que não têm itens pra calcular status automaticamente), expectedDate e
// receivedDate. origin/notionPurchaseId/supplierId não são editáveis nesta
// fase.
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR PEDIDOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const order = await loadOrder(database, id);
    if (!order) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);

    const body = (await request.json()) as JsonMap;
    const notes = body.notes === undefined ? order.notes : safeText(body.notes, 2000);
    const expectedDate = body.expectedDate === undefined ? order.expectedDate : safeText(body.expectedDate, 20);
    const receivedDate = body.receivedDate === undefined ? order.receivedDate : safeText(body.receivedDate, 20);
    const status = body.status === undefined ? order.status : safeText(body.status, 20);
    if (!VALID_STATUSES.has(status)) {
      return jsonResponse({ error: "STATUS INVÁLIDO." }, 400);
    }
    // Cancelar/reabrir (Fase C, item 4) — ação explícita, independente do
    // status operacional. A confirmação extra pra cancelar um pedido já
    // 'concluido' é feita no client (confirm()); aqui só gravamos o que
    // veio no corpo.
    const canceled = body.canceled === undefined ? Boolean(order.canceled) : Boolean(body.canceled);

    const actorName = actor.displayName || "Administrador";
    await database
      .prepare(
        `UPDATE purchase_orders
         SET notes=?1, expected_date=?2, received_date=?3, status=?4, canceled=?5, updated_by=?6, updated_by_name=?7, updated_at=CURRENT_TIMESTAMP
         WHERE id=?8`,
      )
      .bind(notes, expectedDate, receivedDate, status, canceled ? 1 : 0, actor.id, actorName, id)
      .run();

    return jsonResponse({ updated: true, id, canceled });
  } catch (error) {
    console.error("Não foi possível editar o pedido de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR O PEDIDO." }, 500);
  }
}
