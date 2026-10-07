import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { documentsBucket } from "../../documents/shared";
import { OBRA_STATUSES, actorName, canManageWorks, identity, isOneOf, jsonResponse, safeText, sameOrigin } from "../shared";

// Ações em lote de OBRAS (Financeiro 9/9): { action, ids, fields }
// - status: ALTERAR STATUS (fields.status, um dos status da obra);
// - delete: EXCLUIR — mesma regra do DELETE individual (apaga a obra, os
//   lançamentos e os anexos no armazenamento).
// Mesma permissão da tela (works:manage ou finance:manage). Ids conferidos
// antes (404); uma transação.

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageWorks(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA GERENCIAR OBRAS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = safeText(body.action, 20);
    if (action !== "status" && action !== "delete") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((value) => safeText(value, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA OBRA." }, 400);
    if (ids.length > 500) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 500)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as Record<string, unknown>;
    const status = safeText(fields.status, 20);
    if (action === "status" && !isOneOf(OBRA_STATUSES, status)) return jsonResponse({ error: "STATUS DE OBRA INVÁLIDO." }, 400);

    const database = await getD1();
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
    const found = await database
      .prepare(`SELECT id, title, status FROM obras WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<{ id: string; title: string; status: string }>();
    const obras = found.results ?? [];
    if (obras.length !== ids.length) return jsonResponse({ error: "ALGUMA OBRA SELECIONADA NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);

    const skipped: Array<{ id: string; description: string; reason: string }> = [];
    if (action === "status") {
      const statements = obras
        .filter((obra) => {
          if (obra.status === status) skipped.push({ id: obra.id, description: obra.title, reason: "JÁ ESTÁ COM ESSE STATUS" });
          return obra.status !== status;
        })
        .map((obra) =>
          database
            .prepare("UPDATE obras SET status=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4")
            .bind(status, actor.id, actorName(actor), obra.id),
        );
      if (statements.length) await database.batch(statements);
      return jsonResponse({ applied: obras.length - skipped.length, skipped });
    }

    const attachments = await database
      .prepare(`SELECT attachment_r2_key AS attachmentR2Key FROM obra_entries WHERE obra_id IN (${placeholders}) AND attachment_r2_key <> ''`)
      .bind(...ids)
      .all<{ attachmentR2Key: string }>();
    await database.batch(
      ids.flatMap((id) => [
        database.prepare("DELETE FROM obra_entries WHERE obra_id=?1").bind(id),
        database.prepare("DELETE FROM obras WHERE id=?1").bind(id),
      ]),
    );
    const keys = (attachments.results ?? []).map((row) => row.attachmentR2Key).filter(Boolean);
    if (keys.length) {
      const bucket = await documentsBucket();
      await bucket.delete(keys).catch(() => undefined);
    }
    return jsonResponse({ applied: obras.length, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar o lote de obras.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A AÇÃO EM LOTE. NADA FOI ALTERADO." }, 500);
  }
}
