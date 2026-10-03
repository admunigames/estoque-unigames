import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import {
  can,
  eventStatement,
  identity,
  inScope,
  jsonResponse,
  loadRequest,
  routeParam,
  sameOrigin,
} from "../../../shared";

type Context = { params: Promise<{ itemId: string }> };

// Botão INVENTARIADO: tira o item da lista ativa e leva para o histórico
// (data + quem marcou). O status do item continua ANOTADO PARA INVENTÁRIO,
// então o status do pedido não muda.
export async function POST(request: Request, context: Context) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "divergencias:inventory")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA MARCAR ITENS COMO INVENTARIADOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  try {
    const itemId = routeParam((await context.params).itemId);
    const database = await getD1();
    const item = await database
      .prepare("SELECT request_id AS requestId, status, inventoried_at AS inventoriedAt FROM divergence_items WHERE id=?1 LIMIT 1")
      .bind(itemId)
      .first<{ requestId: string; status: string; inventoriedAt: string }>();
    const row = item ? await loadRequest(database, item.requestId) : null;
    if (!item || !row || !inScope(actor, "divergencias:inventory", row.companyId)) {
      return jsonResponse({ error: "ITEM NÃO ENCONTRADO." }, 404);
    }
    if (item.status !== "inventario") {
      return jsonResponse({ error: "ESTE ITEM NÃO ESTÁ ANOTADO PARA INVENTÁRIO." }, 409);
    }
    if (item.inventoriedAt) {
      return jsonResponse({ error: "ESTE ITEM JÁ FOI INVENTARIADO." }, 409);
    }
    const at = new Date().toISOString();
    await database.batch([
      database
        .prepare(
          `UPDATE divergence_items
           SET inventoried_at=?1, inventoried_by=?2, inventoried_by_name=?3,
               updated_by=?2, updated_by_name=?3, updated_at=?1
           WHERE id=?4 AND status='inventario' AND inventoried_at=''`,
        )
        .bind(at, actor.id, actor.displayName, itemId),
      eventStatement(database, {
        itemId, requestId: item.requestId, kind: "inventoried", fromStatus: "inventario",
        toStatus: "inventario", text: "INVENTARIADO", actor, at,
      }),
    ]);
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível marcar o item como inventariado.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MARCAR O ITEM COMO INVENTARIADO." }, 500);
  }
}
