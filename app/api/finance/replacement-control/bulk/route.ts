import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { SECTORS } from "../shared";

// Ações em lote do CONTROLE DE REPOSIÇÃO (Financeiro 9/9): { action, ids, fields }
// - update: ALTERAR SETOR/MOTIVO (só o que vier em fields.sector / fields.reason);
// - delete: EXCLUIR — mesma regra do DELETE individual: o que já virou Despesa
//   é pulado com o motivo.
// Mesmo escopo das rotas atuais do módulo (finance:manage). Ids conferidos
// antes (404); uma transação.

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR O CONTROLE DE REPOSIÇÃO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (action !== "update" && action !== "delete") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((value) => safeText(value, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM LANÇAMENTO." }, 400);
    if (ids.length > 1000) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 1000)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;
    const sector = safeText(fields.sector, 20);
    const hasReason = fields.reason !== undefined;
    if (action === "update") {
      if (!sector && !hasReason) return jsonResponse({ error: "ESCOLHA O SETOR OU INFORME O MOTIVO." }, 400);
      if (sector && !SECTORS.has(sector)) return jsonResponse({ error: "SELECIONE O SETOR RESPONSÁVEL." }, 400);
    }

    const database = await getD1();
    const found = await database
      .prepare(
        `SELECT id, product, sector, reason, expense_id AS expenseId FROM finance_replacement_entries
         WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...ids)
      .all<{ id: string; product: string; sector: string; reason: string; expenseId: string }>();
    const rows = found.results ?? [];
    if (rows.length !== ids.length) return jsonResponse({ error: "ALGUM LANÇAMENTO SELECIONADO NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);

    const who = actor.displayName || "Administrador";
    const statements: [string, unknown[]][] = [];
    const skipped: Array<{ id: string; description: string; reason: string }> = [];
    for (const row of rows) {
      if (action === "delete") {
        if (row.expenseId) {
          skipped.push({ id: row.id, description: row.product, reason: "JÁ VIROU DESPESA — REMOVA A DESPESA PRIMEIRO" });
          continue;
        }
        statements.push(["DELETE FROM finance_replacement_entries WHERE id=?1", [row.id]]);
        continue;
      }
      statements.push([
        `UPDATE finance_replacement_entries SET sector=?1, reason=?2, updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP WHERE id=?5`,
        [sector || row.sector, hasReason ? safeText(fields.reason, 500) : row.reason, actor.id, who, row.id],
      ]);
    }
    if (statements.length) await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ applied: rows.length - skipped.length, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar o lote do controle de reposição.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A AÇÃO EM LOTE. NADA FOI ALTERADO." }, 500);
  }
}
