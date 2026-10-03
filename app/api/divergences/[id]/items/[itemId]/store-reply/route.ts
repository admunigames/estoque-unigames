import { getD1 } from "../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../lib/notion";
import { divergenceLabel } from "../../../../../../lib/divergences";
import {
  can,
  eventStatement,
  identity,
  inScope,
  jsonResponse,
  loadItem,
  loadRequest,
  quantity,
  recalcStatement,
  routeParam,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../../../shared";

type Context = { params: Promise<{ id: string; itemId: string }> };

// Retorno da loja num item em VERIFICAÇÃO DA LOJA: observação obrigatória
// e, se quiser, físico/sistema corrigidos. O item volta sozinho para EM
// VERIFICAÇÃO (o estoque continua a análise).
export async function POST(request: Request, context: Context) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "divergencias:edit")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA RESPONDER COMO LOJA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  try {
    const params = await context.params;
    const id = routeParam(params.id);
    const itemId = routeParam(params.itemId);
    const body = (await request.json()) as JsonMap;
    const reply = safeText(body.reply, 2000);
    if (reply.length < 2) return jsonResponse({ error: "ESCREVA O RETORNO DA LOJA." }, 400);
    const database = await getD1();
    const row = await loadRequest(database, id);
    if (!row || !inScope(actor, "divergencias:edit", row.companyId)) {
      return jsonResponse({ error: "PEDIDO NÃO ENCONTRADO." }, 404);
    }
    const item = await loadItem(database, id, itemId);
    if (!item) return jsonResponse({ error: "ITEM NÃO ENCONTRADO." }, 404);
    if (item.status !== "verificacao_loja") {
      return jsonResponse({ error: "ESTE ITEM NÃO ESTÁ AGUARDANDO VERIFICAÇÃO DA LOJA." }, 409);
    }
    const physicalQty = body.physicalQty === undefined || body.physicalQty === "" ? item.physicalQty : quantity(body.physicalQty);
    const systemQty = body.systemQty === undefined || body.systemQty === "" ? item.systemQty : quantity(body.systemQty);
    if (physicalQty === null || systemQty === null) {
      return jsonResponse({ error: "QUANTIDADES INVÁLIDAS (NÚMERO INTEIRO, 0 OU MAIS)." }, 400);
    }
    const corrected = physicalQty !== item.physicalQty || systemQty !== item.systemQty;
    const at = new Date().toISOString();
    const text = corrected
      ? `${reply} · CORRIGIDO: FÍSICO ${item.physicalQty} → ${physicalQty} · SISTEMA ${item.systemQty} → ${systemQty} (${divergenceLabel(physicalQty, systemQty)})`
      : reply;
    await database.batch([
      database
        .prepare(
          `UPDATE divergence_items
           SET status='em_verificacao', store_reply=?1, store_reply_by=?2, store_reply_by_name=?3,
               store_reply_at=?4, physical_qty=?5, system_qty=?6,
               updated_by=?2, updated_by_name=?3, updated_at=?4
           WHERE id=?7 AND status='verificacao_loja'`,
        )
        .bind(reply, actor.id, actor.displayName, at, physicalQty, systemQty, item.id),
      eventStatement(database, {
        itemId: item.id, requestId: id, kind: "store_reply", fromStatus: item.status,
        toStatus: "em_verificacao", text, actor, at,
      }),
      recalcStatement(database, id, actor, at),
    ]);
    return jsonResponse({ updated: true, status: "em_verificacao" });
  } catch (error) {
    console.error("Não foi possível registrar o retorno da loja.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR O RETORNO DA LOJA." }, 500);
  }
}
