import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../../shared";

type OrderRow = { id: string; origin: string; status: string };
type SupplierRow = { id: string; name: string };
type ItemRow = { id: string };
type QuoteRow = { unitPriceCents: number };

// Fase F: "Compra Efetuada" — define o fornecedor vencedor do pedido
// INTEIRO (não por item). Faz duas coisas ao mesmo tempo, como decidido no
// escopo da fase:
//  1. Marca o marco wonAt/wonBy/wonByName (badge "COMPRA EFETUADA",
//     separado do status).
//  2. Move status -> 'aguardando_chegada' (libera Divisão, recebimento e
//     mantém anexos/NF como já estavam).
// Também trava o preço de cada item: se existir uma cotação
// (purchase_order_item_quotes) desse item com o fornecedor vencedor, copia
// pro unit_price_cents do item — itens sem cotação do vencedor ficam
// unit_price_cents=0 ("não informado", já é o padrão existente).
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA DEFINIR O FORNECEDOR VENCEDOR." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id: orderId } = await context.params;

  try {
    const database = await getD1();
    const order = await database
      .prepare("SELECT id, origin, status FROM purchase_orders WHERE id=?1")
      .bind(orderId)
      .first<OrderRow>();
    if (!order) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);
    if (order.origin !== "native") {
      return jsonResponse({ error: "SÓ É POSSÍVEL DEFINIR VENCEDOR EM PEDIDOS NATIVOS." }, 400);
    }
    if (order.status !== "aberto") {
      return jsonResponse({ error: "ESTE PEDIDO JÁ TEM UM VENCEDOR DEFINIDO OU NÃO ESTÁ MAIS ABERTO." }, 409);
    }

    const body = (await request.json()) as JsonMap;
    const supplierId = safeText(body.supplierId, 80);
    if (!supplierId) return jsonResponse({ error: "INFORME O FORNECEDOR VENCEDOR." }, 400);

    const supplier = await database
      .prepare("SELECT id, name FROM finance_suppliers WHERE id=?1")
      .bind(supplierId)
      .first<SupplierRow>();
    if (!supplier) return jsonResponse({ error: "FORNECEDOR NÃO ENCONTRADO." }, 400);

    const itemsResult = await database
      .prepare("SELECT id FROM purchase_order_items WHERE order_id=?1")
      .bind(orderId)
      .all<ItemRow>();
    const items = itemsResult.results ?? [];

    const actorName = actor.displayName || "Administrador";
    const nowIso = new Date().toISOString();
    const statements: { sql: string; values: unknown[] }[] = [
      {
        sql: `UPDATE purchase_orders
              SET supplier_id=?1, supplier_name_raw=?2, won_at=?3, won_by=?4, won_by_name=?5,
                  status='aguardando_chegada', updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP
              WHERE id=?6`,
        values: [supplierId, supplier.name, nowIso, actor.id, actorName, orderId],
      },
    ];

    // Pra cada item, se o vencedor tiver cotado, trava o preço final nesse
    // valor — itens sem cotação do vencedor ficam com o preço que já
    // tinham (0 = não informado, por padrão).
    for (const item of items) {
      const quote = await database
        .prepare(
          "SELECT unit_price_cents AS unitPriceCents FROM purchase_order_item_quotes WHERE item_id=?1 AND supplier_id=?2",
        )
        .bind(item.id, supplierId)
        .first<QuoteRow>();
      if (quote) {
        statements.push({
          sql: `UPDATE purchase_order_items
                SET unit_price_cents=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP
                WHERE id=?4`,
          values: [quote.unitPriceCents, actor.id, actorName, item.id],
        });
      }
    }

    const prepared = statements.map((statement) => database.prepare(statement.sql).bind(...statement.values));
    await database.batch(prepared);

    return jsonResponse({ updated: true, id: orderId, status: "aguardando_chegada", supplierId, supplierName: supplier.name });
  } catch (error) {
    console.error("Não foi possível definir o fornecedor vencedor do pedido.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL DEFINIR O FORNECEDOR VENCEDOR." }, 500);
  }
}
