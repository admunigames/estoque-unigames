import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { resolveCashFlowScope } from "../../cash-flow/shared";

// Ações em lote no histórico de saldos semanais: { action: 'delete', ids[] }.
// Todos os ids conferidos antes (404 se algum sumiu, 403 se for de outra
// loja); exclusão numa transação. O saldo "atual" (finance_account_balances)
// não é mexido.
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR SALDOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scope = resolveCashFlowScope(request, "");
  if (scope.error) return scope.error;

  try {
    const body = (await request.json()) as JsonMap;
    if (safeText(body.action, 20) !== "delete") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((value) => safeText(value, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UM SALDO." }, 400);
    if (ids.length > 500) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 500)." }, 400);

    const database = await getD1();
    const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
    const found = await database
      .prepare(`SELECT id, company_id AS companyId FROM finance_account_weekly_balances WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<{ id: string; companyId: string }>();
    const rows = found.results ?? [];
    if (rows.length !== ids.length) {
      return jsonResponse({ error: "ALGUM SALDO SELECIONADO NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
    }
    if (!scope.allStores && rows.some((row) => row.companyId !== scope.scopeCompanyId)) {
      return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ALGUM DESSES SALDOS." }, 403);
    }
    await database.batch([
      database.prepare(`DELETE FROM finance_account_weekly_balances WHERE id IN (${placeholders})`).bind(...ids),
    ]);
    return jsonResponse({ deleted: ids.length });
  } catch (error) {
    console.error("Não foi possível excluir os saldos semanais.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR. NADA FOI ALTERADO." }, 500);
  }
}
