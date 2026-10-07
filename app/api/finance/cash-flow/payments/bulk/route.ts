import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../../shared";
import { planPayablesBulk } from "../../../payables/shared";

// Ações em lote da LISTA DE PAGAMENTOS (só contas — RH é pago na Folha):
// { action: 'pay' | 'reschedule', ids: payableIds[], fields }. A regra é a
// mesma de Contas a Pagar (planPayablesBulk em payables/shared.ts); aqui só
// pay/reschedule — cancelar e alterar categoria ficam em Contas a Pagar.

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR CONTAS A PAGAR." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (action !== "pay" && action !== "reschedule") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((value) => safeText(value, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA CONTA." }, 400);
    if (ids.length > 300) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 300)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;

    const database = await getD1();
    const plan = await planPayablesBulk(database, actor, scopeActor, action, ids, { ...fields, notes: "PAGO EM LOTE PELO FLUXO DE CAIXA" });
    if ("error" in plan) return jsonResponse({ error: plan.error }, plan.status);
    if (plan.statements.length) await database.batch(plan.statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ applied: plan.applied, skipped: plan.skipped });
  } catch (error) {
    console.error("Não foi possível aplicar a ação em lote nas contas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A AÇÃO EM LOTE. NADA FOI ALTERADO." }, 500);
  }
}
