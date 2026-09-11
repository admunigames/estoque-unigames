import { getD1 } from "../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, sameOrigin, type JsonMap } from "../../../../shared";

type OrderRow = { id: string; status: string; receivedDate: string; noItemsDetailed: number; canceled: number };
type ItemRow = { id: string; orderId: string; quantity: number; receivedQuantity: number };

async function loadItem(database: D1Database, orderId: string, itemId: string) {
  return database
    .prepare(
      `SELECT id, order_id AS orderId, quantity, received_quantity AS receivedQuantity
       FROM purchase_order_items WHERE id=?1 AND order_id=?2`,
    )
    .bind(itemId, orderId)
    .first<ItemRow>();
}

// PATCH { receivedQuantity }: valor ABSOLUTO (não incremento) — evita race
// condition entre duas pessoas registrando recebimento do mesmo item ao
// mesmo tempo. Depois de gravar, recalcula o status do pedido pai: todo
// item com receivedQuantity >= quantity => 'concluido' (e receivedDate
// preenchido com hoje, se ainda vazio); senão 'em_andamento'.
export async function PATCH(request: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA REGISTRAR RECEBIMENTO DE PEDIDOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id: orderId, itemId } = await context.params;

  try {
    const database = await getD1();
    const order = await database
      .prepare("SELECT id, status, received_date AS receivedDate, no_items_detailed AS noItemsDetailed, canceled FROM purchase_orders WHERE id=?1")
      .bind(orderId)
      .first<OrderRow>();
    if (!order) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);
    if (order.noItemsDetailed) {
      return jsonResponse({ error: "ESTE PEDIDO NÃO TEM ITENS DETALHADOS PARA RECEBER." }, 409);
    }
    // Fase C, item 4: pedido cancelado não recebe mais itens.
    if (order.canceled) {
      return jsonResponse({ error: "ESTE PEDIDO ESTÁ CANCELADO E NÃO PODE RECEBER ITENS." }, 400);
    }

    const item = await loadItem(database, orderId, itemId);
    if (!item) return jsonResponse({ error: "ITEM NÃO ENCONTRADO." }, 404);

    const body = (await request.json()) as JsonMap;
    const receivedQuantity = Number(body.receivedQuantity);
    if (!Number.isFinite(receivedQuantity) || !Number.isInteger(receivedQuantity) || receivedQuantity < 0) {
      return jsonResponse({ error: "INFORME UMA QUANTIDADE RECEBIDA VÁLIDA." }, 400);
    }
    if (receivedQuantity > item.quantity) {
      return jsonResponse({ error: "A QUANTIDADE RECEBIDA NÃO PODE SER MAIOR QUE A QUANTIDADE DO ITEM." }, 400);
    }

    const actorName = actor.displayName || "Administrador";
    await database
      .prepare(
        `UPDATE purchase_order_items
         SET received_quantity=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP
         WHERE id=?4`,
      )
      .bind(receivedQuantity, actor.id, actorName, itemId)
      .run();

    const allItemsResult = await database
      .prepare("SELECT quantity, received_quantity AS receivedQuantity FROM purchase_order_items WHERE order_id=?1")
      .bind(orderId)
      .all<{ quantity: number; receivedQuantity: number }>();
    const allItems = allItemsResult.results ?? [];
    const allReceived = allItems.length > 0 && allItems.every((row) => row.receivedQuantity >= row.quantity);
    const newStatus = allReceived ? "concluido" : "em_andamento";
    const newReceivedDate = allReceived && !order.receivedDate ? new Date().toISOString().slice(0, 10) : order.receivedDate;

    await database
      .prepare(
        `UPDATE purchase_orders
         SET status=?1, received_date=?2, updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP
         WHERE id=?5`,
      )
      .bind(newStatus, newReceivedDate, actor.id, actorName, orderId)
      .run();

    return jsonResponse({ updated: true, id: itemId, orderStatus: newStatus });
  } catch (error) {
    console.error("Não foi possível registrar o recebimento do item.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR O RECEBIMENTO." }, 500);
  }
}
