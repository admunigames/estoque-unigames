import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { planPayablesBulk, type PayablesBulkAction } from "../shared";

// Ações em lote de CONTAS A PAGAR (Financeiro 9/9): { action, ids, fields }
// pay (MARCAR COMO PAGO: fields.paymentDate, financeAccountId) · reschedule
// (ALTERAR VENCIMENTO: fields.dueDate) · category (ALTERAR CATEGORIA/CENTRO DE
// CUSTO: fields.financeItemId, fields.costCenterId) · cancel (CANCELAR).
// Mesma função do lote do Fluxo de Caixa (planPayablesBulk); uma transação.

const ACTIONS: PayablesBulkAction[] = ["pay", "reschedule", "category", "cancel"];

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR CONTAS A PAGAR." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20) as PayablesBulkAction;
    if (!ACTIONS.includes(action)) return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((value) => safeText(value, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA CONTA." }, 400);
    if (ids.length > 300) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 300)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;

    const database = await getD1();
    const plan = await planPayablesBulk(database, actor, scopeActor, action, ids, { ...fields, notes: "PAGO EM LOTE EM CONTAS A PAGAR" });
    if ("error" in plan) return jsonResponse({ error: plan.error }, plan.status);
    if (plan.statements.length) await database.batch(plan.statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ applied: plan.applied, skipped: plan.skipped });
  } catch (error) {
    console.error("Não foi possível aplicar o lote de contas a pagar.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A AÇÃO EM LOTE. NADA FOI ALTERADO." }, 500);
  }
}
