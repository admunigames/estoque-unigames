import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, newId, safeText, sameOrigin, type JsonMap } from "../../../shared";

type OrderRow = {
  id: string;
  origin: string;
  canceled: number;
  supplierId: string;
  supplierNameRaw: string;
  notes: string;
};

type CloneItemInput = { productCode: string; productName: string; quantity: number; unitPriceCents: number };

function safeCloneItems(value: unknown): CloneItemInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = entry && typeof entry === "object" ? (entry as JsonMap) : {};
      return {
        productCode: safeText(record.productCode, 80),
        productName: safeText(record.productName, 200),
        quantity: Number(record.quantity),
        unitPriceCents: Number(record.unitPriceCents) || 0,
      };
    })
    .filter((item) => item.productCode);
}

// Clonar pedido — caso de uso confirmado com o usuário: mesmo pedido (mesmo
// fornecedor, mesmos produtos) pra uma loja de destino diferente, sem
// precisar recriar tudo do zero. Decisões confirmadas:
//  - Só pedidos NATIVOS não cancelados, e só se já tiverem um vencedor
//    definido (supplier_id preenchido) — um pedido 'aberto' sem fornecedor
//    ainda não tem o que copiar como "já definido".
//  - O clone nasce direto com o MESMO fornecedor (supplierId/supplierNameRaw
//    copiados), status='aguardando_chegada', won_at/won_by preenchidos na
//    hora — sem repetir cotação/definição de vencedor.
//  - Loja de destino ÚNICA pro pedido clonado inteiro (aplicada a todos os
//    itens via target_stores) — não copia a loja original dos itens.
//  - Itens: produto/quantidade/preço vêm do formulário de revisão (o
//    usuário edita antes de confirmar) — não lê os itens originais direto
//    do banco, pra permitir remover/ajustar um item antes de salvar.
//  - candidateSupplierIds NÃO é copiado (fica vazio — sem uso nesse fluxo,
//    já que o clone não passa por cotação). receivedQuantity sempre 0.
//    Anexos, cotações, division/divisionStatus, expectedDate/receivedDate
//    do pedido original NUNCA são copiados — o clone começa do zero neles.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CLONAR PEDIDOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id: sourceOrderId } = await context.params;

  try {
    const database = await getD1();
    const source = await database
      .prepare(
        `SELECT id, origin, canceled, supplier_id AS supplierId, supplier_name_raw AS supplierNameRaw, notes
         FROM purchase_orders WHERE id=?1`,
      )
      .bind(sourceOrderId)
      .first<OrderRow>();
    if (!source) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);
    if (source.origin !== "native") {
      return jsonResponse({ error: "SÓ É POSSÍVEL CLONAR PEDIDOS NATIVOS." }, 400);
    }
    if (source.canceled) {
      return jsonResponse({ error: "NÃO É POSSÍVEL CLONAR UM PEDIDO CANCELADO." }, 400);
    }
    if (!source.supplierId) {
      return jsonResponse({ error: "DEFINA O FORNECEDOR VENCEDOR DESTE PEDIDO ANTES DE CLONAR." }, 400);
    }

    const body = (await request.json()) as JsonMap;
    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 160);
    if (!companyId) return jsonResponse({ error: "INFORME A LOJA DE DESTINO." }, 400);

    const items = safeCloneItems(body.items);
    if (!items.length) return jsonResponse({ error: "O PEDIDO CLONADO PRECISA DE PELO MENOS UM ITEM." }, 400);
    for (const item of items) {
      if (!Number.isFinite(item.quantity) || !Number.isInteger(item.quantity) || item.quantity <= 0) {
        return jsonResponse({ error: "INFORME UMA QUANTIDADE VÁLIDA PARA CADA ITEM (" + item.productCode + ")." }, 400);
      }
      if (!Number.isInteger(item.unitPriceCents) || item.unitPriceCents < 0) {
        return jsonResponse({ error: "INFORME UM PREÇO UNITÁRIO VÁLIDO PARA CADA ITEM." }, 400);
      }
    }

    const newOrderId = newId();
    const actorName = actor.displayName || "Administrador";
    const nowIso = new Date().toISOString();
    const targetStoresJson = JSON.stringify([{ companyId, companyName }]);
    const cloneNote = "Clonado do pedido " + (source.supplierNameRaw || sourceOrderId);

    const statements: { sql: string; values: unknown[] }[] = [
      {
        sql: `INSERT INTO purchase_orders (
                id, origin, notion_purchase_id, notion_purchase_url, supplier_id, supplier_name_raw,
                company_id, company_name, order_date, expected_date, received_date, division, division_status,
                status, no_items_detailed, notes, canceled, won_at, won_by, won_by_name,
                created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at
              ) VALUES (
                ?1, 'native', '', '', ?2, ?3,
                '', '', '', '', '', '', '',
                'aguardando_chegada', 0, ?4, 0, ?5, ?6, ?7,
                ?6, ?7, CURRENT_TIMESTAMP, ?6, ?7, CURRENT_TIMESTAMP
              )`,
        values: [newOrderId, source.supplierId, source.supplierNameRaw, cloneNote, nowIso, actor.id, actorName],
      },
    ];
    for (const item of items) {
      statements.push({
        sql: `INSERT INTO purchase_order_items
                (id, order_id, draft_item_id, product_code, product_name, quantity, received_quantity, unit_price_cents,
                 target_stores, candidate_supplier_ids, notes, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
              VALUES (?1, ?2, '', ?3, ?4, ?5, 0, ?6, ?7, '[]', '', ?8, ?9, CURRENT_TIMESTAMP, ?8, ?9, CURRENT_TIMESTAMP)`,
        values: [newId(), newOrderId, item.productCode, item.productName, item.quantity, item.unitPriceCents, targetStoresJson, actor.id, actorName],
      });
    }

    const prepared = statements.map((statement) => database.prepare(statement.sql).bind(...statement.values));
    await database.batch(prepared);

    return jsonResponse({ created: true, id: newOrderId }, 201);
  } catch (error) {
    console.error("Não foi possível clonar o pedido de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CLONAR O PEDIDO." }, 500);
  }
}
