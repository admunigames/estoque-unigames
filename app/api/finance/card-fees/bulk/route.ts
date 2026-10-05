import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores } from "../../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { runStatements, scopeActorOf, type Statement } from "../shared";

// Ações em lote na aba TAXAS (Financeiro 5/9): { action: 'delete' | 'close',
// ids, fields: { validTo } }. close = ENCERRAR VIGÊNCIA na data (a taxa que
// começa depois dela é pulada). Todos os ids conferidos antes (404 se algum
// sumiu, 403 se for de outra loja); gravação numa transação.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type FeeRow = { id: string; companyId: string; validFrom: string; validTo: string; label: string };

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
    if (action !== "delete" && action !== "close") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((v) => safeText(v, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA TAXA." }, 400);
    if (ids.length > 500) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 500)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;
    const validTo = safeText(fields.validTo, 10);
    if (action === "close" && !DATE_RE.test(validTo)) return jsonResponse({ error: "INFORME A DATA DE FIM DA VIGÊNCIA." }, 400);

    const database = await getD1();
    const found = await database
      .prepare(
        `SELECT id, company_id AS companyId, valid_from AS validFrom, valid_to AS validTo,
                acquirer_name || ' ' || modality || ' ' || installments || 'x' AS label
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

    const who = actor.displayName || "Administrador";
    const skipped: Array<{ id: string; description: string; reason: string }> = [];
    const statements: Statement[] = [];
    for (const row of rows) {
      if (action === "delete") {
        statements.push(["DELETE FROM finance_card_fees WHERE id=?1", [row.id]]);
        continue;
      }
      if (row.validFrom && row.validFrom > validTo) {
        skipped.push({ id: row.id, description: row.label, reason: "VIGÊNCIA COMEÇA DEPOIS DA DATA" });
        continue;
      }
      if (row.validTo && row.validTo <= validTo) {
        skipped.push({ id: row.id, description: row.label, reason: "JÁ ENCERRADA ANTES" });
        continue;
      }
      statements.push([
        `UPDATE finance_card_fees SET valid_to=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4`,
        [validTo, actor.id, who, row.id],
      ]);
    }
    await runStatements(database, statements);
    return jsonResponse({ applied: statements.length, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar o lote de taxas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL APLICAR O LOTE DE TAXAS." }, 500);
  }
}
