import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, parseJsonArray, safeText, sameOrigin, type JsonMap } from "../../../shared";

type ItemRow = { id: string; candidateSupplierIds: string };

// Mapa de cotação (pedido 'aberto'): cada fornecedor é uma COLUNA que vale
// para todos os produtos do pedido. { supplierId, action:'add' } coloca o
// fornecedor como candidato em todos os itens; action:'remove' tira dos itens
// e apaga as cotações dele neste pedido. Tudo numa transação.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR PEDIDOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const { id: orderId } = await context.params;

  try {
    const database = await getD1();
    const order = await database
      .prepare("SELECT id, status FROM purchase_orders WHERE id=?1")
      .bind(orderId)
      .first<{ id: string; status: string }>();
    if (!order) return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);
    if (order.status !== "aberto") {
      return jsonResponse({ error: "SÓ É POSSÍVEL MEXER NA COTAÇÃO ENQUANTO O PEDIDO ESTÁ 'ABERTO'." }, 400);
    }

    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const supplierId = safeText(body.supplierId, 80);
    const action = body.action === "remove" ? "remove" : body.action === "add" ? "add" : "";
    if (!supplierId || !action) return jsonResponse({ error: "DADOS INVÁLIDOS." }, 400);
    if (action === "add") {
      const supplier = await database
        .prepare("SELECT id FROM finance_suppliers WHERE id=?1")
        .bind(supplierId)
        .first<{ id: string }>();
      if (!supplier) return jsonResponse({ error: "FORNECEDOR NÃO ENCONTRADO." }, 404);
    }

    const items = (
      await database
        .prepare("SELECT id, candidate_supplier_ids AS candidateSupplierIds FROM purchase_order_items WHERE order_id=?1")
        .bind(orderId)
        .all<ItemRow>()
    ).results ?? [];
    if (!items.length) return jsonResponse({ error: "ADICIONE UM PRODUTO ANTES DO FORNECEDOR." }, 400);

    const actorName = actor.displayName || "Administrador";
    const statements = items.map((item) => {
      const current = parseJsonArray(item.candidateSupplierIds).filter((id): id is string => typeof id === "string");
      const next = action === "add"
        ? Array.from(new Set([...current, supplierId]))
        : current.filter((id) => id !== supplierId);
      return database
        .prepare(
          `UPDATE purchase_order_items SET candidate_supplier_ids=?1, updated_by=?2, updated_by_name=?3,
             updated_at=CURRENT_TIMESTAMP WHERE id=?4`,
        )
        .bind(JSON.stringify(next), actor.id, actorName, item.id);
    });
    if (action === "remove") {
      statements.push(
        database
          .prepare(
            `DELETE FROM purchase_order_item_quotes
             WHERE supplier_id=?1 AND item_id IN (SELECT id FROM purchase_order_items WHERE order_id=?2)`,
          )
          .bind(supplierId, orderId),
      );
    }
    statements.push(
      database
        .prepare("UPDATE purchase_orders SET updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?3")
        .bind(actor.id, actorName, orderId),
    );
    await database.batch(statements);
    return jsonResponse({ updated: true, supplierId, action, items: items.length });
  } catch (error) {
    console.error("Não foi possível atualizar os fornecedores da cotação.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR OS FORNECEDORES DA COTAÇÃO." }, 500);
  }
}
