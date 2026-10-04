import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";

// Declaração de Vendas — ações em lote do histórico: { action, ids[] }.
// delete | mark-paid | unmark-paid (percentage_rent_paid). Todos os ids são
// conferidos antes; a gravação vai numa transação só.

const ACTIONS = new Set(["delete", "mark-paid", "unmark-paid"]);

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR DECLARAÇÕES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (!ACTIONS.has(action)) return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((id) => safeText(id, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA DECLARAÇÃO." }, 400);
    if (ids.length > 500) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 500)." }, 400);

    const database = await getD1();
    const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
    const found = await database
      .prepare(`SELECT id FROM finance_mall_declarations WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<{ id: string }>();
    if ((found.results ?? []).length !== ids.length) {
      return jsonResponse({ error: "ALGUMA DECLARAÇÃO SELECIONADA NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
    }

    if (action === "delete") {
      const attachments = await database
        .prepare(`SELECT r2_key AS r2Key FROM finance_mall_declaration_attachments WHERE declaration_id IN (${placeholders})`)
        .bind(...ids)
        .all<{ r2Key: string }>();
      await database.batch([
        database.prepare(`DELETE FROM finance_mall_declaration_attachments WHERE declaration_id IN (${placeholders})`).bind(...ids),
        database.prepare(`DELETE FROM finance_mall_declarations WHERE id IN (${placeholders})`).bind(...ids),
      ]);
      const keys = (attachments.results ?? []).map((a) => a.r2Key).filter(Boolean);
      if (keys.length) {
        try {
          const { documentsBucket } = await import("../../../documents/shared");
          await (await documentsBucket()).delete(keys);
        } catch (bucketError) {
          console.error("Falha ao remover anexos das declarações.", bucketError);
        }
      }
      return jsonResponse({ deleted: ids.length });
    }

    const who = actor.displayName || "Administrador";
    const n = ids.length;
    await database
      .prepare(
        `UPDATE finance_mall_declarations
         SET percentage_rent_paid=?${n + 1}, updated_by=?${n + 2}, updated_by_name=?${n + 3}, updated_at=CURRENT_TIMESTAMP
         WHERE id IN (${placeholders})`,
      )
      .bind(...ids, action === "mark-paid" ? 1 : 0, actor.id, who)
      .run();
    return jsonResponse({ updated: n });
  } catch (error) {
    console.error("Não foi possível aplicar a ação em lote nas declarações de vendas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A AÇÃO EM LOTE. NADA FOI ALTERADO." }, 500);
  }
}
