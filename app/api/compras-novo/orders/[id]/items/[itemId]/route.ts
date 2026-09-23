import { getD1 } from "../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../../../shared";

type OrderRow = { id: string; status: string; receivedDate: string; noItemsDetailed: number; canceled: number };
type ItemRow = {
  id: string;
  orderId: string;
  productCode: string;
  productName: string;
  quantity: number;
  receivedQuantity: number;
  unitPriceCents: number;
  targetStores: string;
  notes: string;
  candidateSupplierIds: string;
};

type TargetStore = { companyId?: unknown; companyName?: unknown };

function safeTargetStores(value: unknown): string {
  if (!Array.isArray(value)) return "[]";
  const stores = value
    .map((entry): TargetStore => (entry && typeof entry === "object" ? (entry as TargetStore) : {}))
    .map((entry) => ({
      companyId: safeText(entry.companyId, 80),
      companyName: safeText(entry.companyName, 120),
    }))
    .filter((entry) => entry.companyId);
  return JSON.stringify(stores);
}

function safeSupplierIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => safeText(entry, 80)).filter((entry) => entry)));
}

async function loadItem(database: D1Database, orderId: string, itemId: string) {
  return database
    .prepare(
      `SELECT id, order_id AS orderId, product_code AS productCode, product_name AS productName,
              quantity, received_quantity AS receivedQuantity, unit_price_cents AS unitPriceCents,
              target_stores AS targetStores, notes, candidate_supplier_ids AS candidateSupplierIds
       FROM purchase_order_items WHERE id=?1 AND order_id=?2`,
    )
    .bind(itemId, orderId)
    .first<ItemRow>();
}

// PATCH { receivedQuantity?, unitPriceCents?, candidateSupplierIds?,
// productCode?, productName?, quantity?, notes?, targetStores? }: os campos
// são independentes e opcionais (pelo menos um precisa vir no corpo).
// receivedQuantity é valor ABSOLUTO (não incremento) — evita race condition
// entre duas pessoas registrando recebimento do mesmo item ao mesmo tempo.
// Fase F: receivedQuantity só é aceito a partir de 'aguardando_chegada'
// (recebimento libera só depois do vencedor definido); os demais campos
// (incluindo productCode/productName/quantity/targetStores — correção de um
// item cadastrado errado) continuam editáveis em QUALQUER status, inclusive
// depois de "Compra Efetuada" — bug real reportado pelo usuário: não existia
// como corrigir um produto errado num pedido que já tinha vencedor definido.
// quantity não pode ficar abaixo do que já foi recebido. Depois de gravar
// receivedQuantity, recalcula o status do pedido pai: todo item com
// receivedQuantity >= quantity => 'concluido' (e receivedDate preenchido
// com hoje, se ainda vazio); senão mantém o status atual (não regride pra
// 'em_andamento'/'aguardando_chegada' automaticamente).
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
    const hasReceivedQuantity = body.receivedQuantity !== undefined;
    const hasUnitPriceCents = body.unitPriceCents !== undefined;
    const hasCandidateSupplierIds = body.candidateSupplierIds !== undefined;
    const hasProductCode = body.productCode !== undefined;
    const hasProductName = body.productName !== undefined;
    const hasQuantity = body.quantity !== undefined;
    const hasNotes = body.notes !== undefined;
    const hasTargetStores = body.targetStores !== undefined;
    if (
      !hasReceivedQuantity && !hasUnitPriceCents && !hasCandidateSupplierIds &&
      !hasProductCode && !hasProductName && !hasQuantity && !hasNotes && !hasTargetStores
    ) {
      return jsonResponse({ error: "NENHUM CAMPO INFORMADO PARA ATUALIZAR." }, 400);
    }
    if (hasReceivedQuantity && order.status === "aberto") {
      return jsonResponse({ error: "SÓ É POSSÍVEL REGISTRAR RECEBIMENTO A PARTIR DE 'AGUARDANDO CHEGADA'." }, 400);
    }

    let quantity = item.quantity;
    if (hasQuantity) {
      quantity = Number(body.quantity);
      if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 0) {
        return jsonResponse({ error: "INFORME UMA QUANTIDADE VÁLIDA." }, 400);
      }
      if (quantity < item.receivedQuantity) {
        return jsonResponse({ error: "A QUANTIDADE NÃO PODE FICAR ABAIXO DO QUE JÁ FOI RECEBIDO." }, 400);
      }
    }

    let receivedQuantity = item.receivedQuantity;
    if (hasReceivedQuantity) {
      receivedQuantity = Number(body.receivedQuantity);
      if (!Number.isFinite(receivedQuantity) || !Number.isInteger(receivedQuantity) || receivedQuantity < 0) {
        return jsonResponse({ error: "INFORME UMA QUANTIDADE RECEBIDA VÁLIDA." }, 400);
      }
      if (receivedQuantity > quantity) {
        return jsonResponse({ error: "A QUANTIDADE RECEBIDA NÃO PODE SER MAIOR QUE A QUANTIDADE DO ITEM." }, 400);
      }
    }

    let unitPriceCents = item.unitPriceCents;
    if (hasUnitPriceCents) {
      unitPriceCents = Number(body.unitPriceCents);
      if (!Number.isFinite(unitPriceCents) || !Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
        return jsonResponse({ error: "INFORME UM PREÇO UNITÁRIO VÁLIDO (EM CENTAVOS)." }, 400);
      }
    }

    let productCode = item.productCode;
    if (hasProductCode) {
      productCode = safeText(body.productCode, 80);
      if (!productCode) return jsonResponse({ error: "INFORME O CÓDIGO DO PRODUTO." }, 400);
    }
    const productName = hasProductName ? safeText(body.productName, 200) : item.productName;
    const notes = hasNotes ? safeText(body.notes, 2000) : item.notes;
    const targetStores = hasTargetStores ? safeTargetStores(body.targetStores) : item.targetStores;

    const candidateSupplierIds = hasCandidateSupplierIds
      ? JSON.stringify(safeSupplierIdList(body.candidateSupplierIds))
      : item.candidateSupplierIds;

    const actorName = actor.displayName || "Administrador";
    await database
      .prepare(
        `UPDATE purchase_order_items
         SET product_code=?1, product_name=?2, quantity=?3, notes=?4, target_stores=?5,
             received_quantity=?6, unit_price_cents=?7, candidate_supplier_ids=?8,
             updated_by=?9, updated_by_name=?10, updated_at=CURRENT_TIMESTAMP
         WHERE id=?11`,
      )
      .bind(
        productCode, productName, quantity, notes, targetStores,
        receivedQuantity, unitPriceCents, candidateSupplierIds,
        actor.id, actorName, itemId,
      )
      .run();

    const allItemsResult = await database
      .prepare("SELECT quantity, received_quantity AS receivedQuantity FROM purchase_order_items WHERE order_id=?1")
      .bind(orderId)
      .all<{ quantity: number; receivedQuantity: number }>();
    const allItems = allItemsResult.results ?? [];
    const allReceived = allItems.length > 0 && allItems.every((row) => row.receivedQuantity >= row.quantity);
    // Só promove pra 'concluido' quando tudo foi recebido — não regride o
    // status se ainda faltar item (mantém 'aguardando_chegada'/'em_andamento').
    const newStatus = allReceived ? "concluido" : order.status;
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

// DELETE: remove um item do pedido — só permitido enquanto 'aberto' (depois
// do vencedor definido, remover item exigiria reavaliar cotações/preço
// travado, então fica bloqueado).
export async function DELETE(request: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR PEDIDOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id: orderId, itemId } = await context.params;

  try {
    const database = await getD1();
    const order = await database
      .prepare("SELECT id, status FROM purchase_orders WHERE id=?1")
      .bind(orderId)
      .first<{ id: string; status: string }>();
    if (!order) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);
    if (order.status !== "aberto") {
      return jsonResponse({ error: "SÓ É POSSÍVEL EXCLUIR ITENS ENQUANTO O PEDIDO ESTÁ 'ABERTO'." }, 400);
    }

    const item = await loadItem(database, orderId, itemId);
    if (!item) return jsonResponse({ error: "ITEM NÃO ENCONTRADO." }, 404);

    await database.prepare("DELETE FROM purchase_order_item_quotes WHERE item_id=?1").bind(itemId).run();
    await database.prepare("DELETE FROM purchase_order_items WHERE id=?1").bind(itemId).run();
    const actorName = actor.displayName || "Administrador";
    await database
      .prepare("UPDATE purchase_orders SET updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?3")
      .bind(actor.id, actorName, orderId)
      .run();

    return jsonResponse({ deleted: true, id: itemId });
  } catch (error) {
    console.error("Não foi possível remover o item do pedido de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REMOVER O ITEM." }, 500);
  }
}
