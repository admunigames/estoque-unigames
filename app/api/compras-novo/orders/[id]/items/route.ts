import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, newId, safeText, sameOrigin, type JsonMap } from "../../../shared";

// targetStores: [{ companyId, companyName }] — candidateSupplierIds: [supplierId, ...].
function safeStoreList(value: unknown): { companyId: string; companyName: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = entry && typeof entry === "object" ? (entry as JsonMap) : {};
      return {
        companyId: safeText(record.companyId, 80),
        companyName: safeText(record.companyName, 160),
      };
    })
    .filter((entry) => entry.companyId);
}

function safeSupplierIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => safeText(entry, 80)).filter((entry) => entry)));
}

// Fase F: adiciona item diretamente ao pedido (antes era só possível num
// rascunho, convertido depois) — só permitido enquanto o pedido está
// 'aberto' (sem vencedor definido ainda).
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR PEDIDOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id: orderId } = await context.params;

  try {
    const database = await getD1();
    const order = await database
      .prepare("SELECT id, status, no_items_detailed AS noItemsDetailed FROM purchase_orders WHERE id=?1")
      .bind(orderId)
      .first<{ id: string; status: string; noItemsDetailed: number }>();
    if (!order) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);
    if (order.noItemsDetailed) {
      return jsonResponse({ error: "ESTE PEDIDO FOI IMPORTADO DO NOTION E NÃO ACEITA ITENS DETALHADOS." }, 400);
    }
    if (order.status !== "aberto") {
      return jsonResponse({ error: "SÓ É POSSÍVEL ADICIONAR ITENS ENQUANTO O PEDIDO ESTÁ 'ABERTO' (SEM VENCEDOR DEFINIDO)." }, 400);
    }

    const body = (await request.json()) as JsonMap;
    const productCode = safeText(body.productCode, 80);
    let productName = safeText(body.productName, 200);
    // Se o código já está no catálogo geral de produtos, o nome oficial de
    // lá prevalece sobre o que veio do formulário (mesmo padrão do upload:
    // o catálogo geral é a autoridade sobre o nome do produto).
    const catalogMatch = productCode
      ? await database
          .prepare(`SELECT name FROM product_catalog WHERE code_unigames=?1 OR code_pa=?1 LIMIT 1`)
          .bind(productCode)
          .first<{ name: string }>()
      : null;
    if (catalogMatch?.name) productName = catalogMatch.name;
    const quantity = Number(body.quantity);
    const notes = safeText(body.notes, 2000);
    const targetStores = safeStoreList(body.targetStores);
    const candidateSupplierIds = safeSupplierIdList(body.candidateSupplierIds);

    if (!productCode) return jsonResponse({ error: "INFORME O CÓDIGO DO PRODUTO." }, 400);
    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 0) {
      return jsonResponse({ error: "INFORME UMA QUANTIDADE VÁLIDA." }, 400);
    }

    const id = newId();
    const actorName = actor.displayName || "Administrador";
    await database
      .prepare(
        `INSERT INTO purchase_order_items
          (id, order_id, draft_item_id, product_code, product_name, quantity, received_quantity, unit_price_cents,
           target_stores, candidate_supplier_ids, notes, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, '', ?3, ?4, ?5, 0, 0, ?6, ?7, ?8, ?9, ?10, CURRENT_TIMESTAMP, ?9, ?10, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        orderId,
        productCode,
        productName,
        quantity,
        JSON.stringify(targetStores),
        JSON.stringify(candidateSupplierIds),
        notes,
        actor.id,
        actorName,
      )
      .run();

    await database
      .prepare("UPDATE purchase_orders SET updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?3")
      .bind(actor.id, actorName, orderId)
      .run();

    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível adicionar o item ao pedido de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ADICIONAR O ITEM." }, 500);
  }
}
