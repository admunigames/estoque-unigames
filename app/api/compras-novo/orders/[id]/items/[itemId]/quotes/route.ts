import { getD1 } from "../../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, newId, safeText, sameOrigin, type JsonMap } from "../../../../../shared";

type OrderRow = { id: string; status: string };
type ItemRow = { id: string; orderId: string };
type SupplierRow = { id: string; name: string };
type QuoteRow = { id: string };

async function loadOrderAndItem(database: D1Database, orderId: string, itemId: string) {
  const order = await database
    .prepare("SELECT id, status FROM purchase_orders WHERE id=?1")
    .bind(orderId)
    .first<OrderRow>();
  const item = order
    ? await database
        .prepare("SELECT id, order_id AS orderId FROM purchase_order_items WHERE id=?1 AND order_id=?2")
        .bind(itemId, orderId)
        .first<ItemRow>()
    : null;
  return { order, item };
}

// POST (upsert) { supplierId, unitPriceCents, notes }: registra/atualiza a
// cotação de um fornecedor pra este item, ENQUANTO o pedido está 'aberto'
// (cotação é só um insumo pra escolher o vencedor — depois disso não faz
// mais sentido). Permite qualquer fornecedor válido do Financeiro, não só
// os pré-marcados como candidatos do item — pra não travar o comprador se
// esquecer de marcar um candidato antes de cotar.
export async function POST(request: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA COTAR ITENS DE PEDIDOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id: orderId, itemId } = await context.params;

  try {
    const database = await getD1();
    const { order, item } = await loadOrderAndItem(database, orderId, itemId);
    if (!order) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);
    if (!item) return jsonResponse({ error: "ITEM NÃO ENCONTRADO." }, 404);
    if (order.status !== "aberto") {
      return jsonResponse({ error: "SÓ É POSSÍVEL COTAR ITENS ENQUANTO O PEDIDO ESTÁ 'ABERTO'." }, 400);
    }

    const body = (await request.json()) as JsonMap;
    const supplierId = safeText(body.supplierId, 80);
    if (!supplierId) return jsonResponse({ error: "INFORME O FORNECEDOR." }, 400);
    const unitPriceCents = Number(body.unitPriceCents);
    if (!Number.isFinite(unitPriceCents) || !Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
      return jsonResponse({ error: "INFORME UM PREÇO UNITÁRIO VÁLIDO (EM CENTAVOS)." }, 400);
    }
    const notes = safeText(body.notes, 2000);

    const supplier = await database
      .prepare("SELECT id, name FROM finance_suppliers WHERE id=?1")
      .bind(supplierId)
      .first<SupplierRow>();
    if (!supplier) return jsonResponse({ error: "FORNECEDOR NÃO ENCONTRADO." }, 400);

    const actorName = actor.displayName || "Administrador";
    const existing = await database
      .prepare("SELECT id FROM purchase_order_item_quotes WHERE item_id=?1 AND supplier_id=?2")
      .bind(itemId, supplierId)
      .first<QuoteRow>();

    if (existing) {
      await database
        .prepare(
          `UPDATE purchase_order_item_quotes
           SET unit_price_cents=?1, notes=?2, updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP
           WHERE id=?5`,
        )
        .bind(unitPriceCents, notes, actor.id, actorName, existing.id)
        .run();
      return jsonResponse({ updated: true, id: existing.id });
    }

    const id = newId();
    await database
      .prepare(
        `INSERT INTO purchase_order_item_quotes
          (id, item_id, supplier_id, unit_price_cents, notes, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP, ?6, ?7, CURRENT_TIMESTAMP)`,
      )
      .bind(id, itemId, supplierId, unitPriceCents, notes, actor.id, actorName)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível registrar a cotação do item.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR A COTAÇÃO." }, 500);
  }
}

// DELETE ?supplierId=... : remove uma cotação errada — mesma checagem de
// status (só enquanto 'aberto').
export async function DELETE(request: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA COTAR ITENS DE PEDIDOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id: orderId, itemId } = await context.params;

  try {
    const database = await getD1();
    const { order, item } = await loadOrderAndItem(database, orderId, itemId);
    if (!order) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);
    if (!item) return jsonResponse({ error: "ITEM NÃO ENCONTRADO." }, 404);
    if (order.status !== "aberto") {
      return jsonResponse({ error: "SÓ É POSSÍVEL REMOVER COTAÇÕES ENQUANTO O PEDIDO ESTÁ 'ABERTO'." }, 400);
    }

    const url = new URL(request.url);
    const supplierId = safeText(url.searchParams.get("supplierId"), 80);
    if (!supplierId) return jsonResponse({ error: "INFORME O FORNECEDOR DA COTAÇÃO A REMOVER." }, 400);

    await database
      .prepare("DELETE FROM purchase_order_item_quotes WHERE item_id=?1 AND supplier_id=?2")
      .bind(itemId, supplierId)
      .run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível remover a cotação do item.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REMOVER A COTAÇÃO." }, 500);
  }
}
