import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores } from "../../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { refreshCardSales, runStatements, scopeActorOf, type Statement } from "../shared";

// Ações em lote na aba TAXAS (Financeiro 5/9): { action: 'delete', ids }.
// Sem vigência, só excluir; as vendas já importadas das adquirentes
// afetadas são recalculadas. Todos os ids conferidos antes (404 se algum
// sumiu, 403 se for de outra loja); gravação numa transação.

type FeeRow = { id: string; companyId: string; acquirerId: string };

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR TAXAS DE CARTÃO." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (action !== "delete") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((v) => safeText(v, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA TAXA." }, 400);
    if (ids.length > 500) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 500)." }, 400);

    const database = await getD1();
    const found = await database
      .prepare(
        `SELECT id, company_id AS companyId, acquirer_id AS acquirerId
         FROM finance_card_fees WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...ids)
      .all<FeeRow>();
    const rows = found.results ?? [];
    if (rows.length !== ids.length) {
      return jsonResponse({ error: "ALGUMA TAXA SELECIONADA NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
    }
    if (!allStores && rows.some((row) => row.companyId !== scopeActor.companyId)) {
      return jsonResponse({ error: "VOCÊ NÃO PODE ALTERAR TAXAS DE OUTRA UNIDADE OU GLOBAIS." }, 403);
    }

    const statements: Statement[] = rows.map((row) => ["DELETE FROM finance_card_fees WHERE id=?1", [row.id]]);
    await runStatements(database, statements);
    let recalculated = 0;
    for (const acquirerId of new Set(rows.map((row) => row.acquirerId))) recalculated += await refreshCardSales(database, "acquirer_id", acquirerId);
    return jsonResponse({ applied: statements.length, skipped: [], recalculated });
  } catch (error) {
    console.error("Não foi possível aplicar o lote de taxas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL APLICAR O LOTE DE TAXAS." }, 500);
  }
}
