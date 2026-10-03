import { getD1 } from "../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../lib/notion";
import { ITEM_STATUS_LABELS, RESPOND_STATUSES, isItemStatus } from "../../../../../../lib/divergences";
import {
  can,
  eventStatement,
  identity,
  inScope,
  jsonResponse,
  loadItem,
  loadRequest,
  recalcStatement,
  routeParam,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../../../shared";

type Context = { params: Promise<{ id: string; itemId: string }> };

// Estoque/fiscal responde UM item: novo status + resposta em texto. A
// resposta é obrigatória, menos ao só marcar EM VERIFICAÇÃO.
export async function POST(request: Request, context: Context) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "divergencias:respond")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA RESPONDER DIVERGÊNCIAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  try {
    const params = await context.params;
    const id = routeParam(params.id);
    const itemId = routeParam(params.itemId);
    const body = (await request.json()) as JsonMap;
    const status = body.status;
    if (!isItemStatus(status) || !RESPOND_STATUSES.includes(status)) {
      return jsonResponse({ error: "ESCOLHA O STATUS DA RESPOSTA." }, 400);
    }
    const response = safeText(body.response, 2000);
    if (status !== "em_verificacao" && response.length < 2) {
      return jsonResponse({ error: "ESCREVA A RESPOSTA PARA A LOJA." }, 400);
    }
    const database = await getD1();
    const row = await loadRequest(database, id);
    if (!row || !inScope(actor, "divergencias:respond", row.companyId)) {
      return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);
    }
    const item = await loadItem(database, id, itemId);
    if (!item) return jsonResponse({ error: "ITEM NÃO ENCONTRADO." }, 404);

    const at = new Date().toISOString();
    // Ao sair de ANOTADO PARA INVENTÁRIO o item deixa de ser pendência (e
    // de constar como inventariado).
    const keepInventory = status === "inventario" && item.status === "inventario";
    await database.batch([
      database
        .prepare(
          `UPDATE divergence_items
           SET status=?1, stock_response=?2, responded_by=?3, responded_by_name=?4, responded_at=?5,
               ${keepInventory ? "" : "inventoried_at='', inventoried_by='', inventoried_by_name='',"}
               updated_by=?3, updated_by_name=?4, updated_at=?5
           WHERE id=?6`,
        )
        .bind(status, response || item.stockResponse, actor.id, actor.displayName, at, item.id),
      eventStatement(database, {
        itemId: item.id, requestId: id, kind: "respond", fromStatus: item.status, toStatus: status,
        text: response, actor, at,
      }),
      recalcStatement(database, id, actor, at),
    ]);
    return jsonResponse({ updated: true, status, label: ITEM_STATUS_LABELS[status] });
  } catch (error) {
    console.error("Não foi possível responder o item da divergência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL RESPONDER O ITEM." }, 500);
  }
}
