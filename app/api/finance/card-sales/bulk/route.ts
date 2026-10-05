import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { runStatements, scopeActorOf, type Statement } from "../../card-fees/shared";

// Ações em lote nas vendas de cartão (aba CONFERÊNCIA, Financeiro 5/9):
// { action: 'review' | 'delete', ids, fields: { note } }. review = MARCAR
// COMO REVISADA (reviewed_* + recon_status 'reviewed', como o PATCH de uma
// venda). Todos os ids conferidos antes (404/403); numa transação.

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR VENDAS DE CARTÃO." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (action !== "review" && action !== "delete") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((v) => safeText(v, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA VENDA." }, 400);
    if (ids.length > 1000) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 1000)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;
    const note = safeText(fields.note, 300);

    const database = await getD1();
    const found = await database
      .prepare(
        `SELECT id, company_id AS companyId FROM finance_card_sales
         WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...ids)
      .all<{ id: string; companyId: string }>();
    const rows = found.results ?? [];
    if (rows.length !== ids.length) {
      return jsonResponse({ error: "ALGUMA VENDA SELECIONADA NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
    }
    if (!allStores && rows.some((row) => row.companyId !== scopeActor.companyId)) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ALGUMA VENDA SELECIONADA." }, 403);
    }

    const reviewedAt = new Date().toISOString();
    const statements: Statement[] = ids.map((id) =>
      action === "delete"
        ? ["DELETE FROM finance_card_sales WHERE id=?1", [id]]
        : [
            `UPDATE finance_card_sales SET recon_status='reviewed', reviewed_at=?1, reviewed_by=?2,
               reviewed_by_name=?3, reviewed_note=?4 WHERE id=?5`,
            [reviewedAt, actor.id, actor.displayName || "Administrador", note, id],
          ],
    );
    await runStatements(database, statements);
    return jsonResponse({ applied: statements.length, skipped: [] });
  } catch (error) {
    console.error("Não foi possível aplicar o lote de vendas de cartão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL APLICAR O LOTE DE VENDAS DE CARTÃO." }, 500);
  }
}
