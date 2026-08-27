import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin } from "../../../shared";
import { assertReceivableAccess, loadReceivable } from "../../shared";

// Cancelamento de recebível é sempre SOFT (canceled=1 + auditoria de
// quem/quando), nunca DELETE físico — mesmo princípio do cancelamento de
// Contas a Pagar. Um recebível cancelado some da lista padrão e some do
// Fluxo de Caixa, mas continua auditável.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CANCELAR RECEBÍVEIS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const receivable = await loadReceivable(database, id);
    if (!receivable) return jsonResponse({ error: "RECEBÍVEL NÃO ENCONTRADO." }, 404);
    if (Number(receivable.canceled) === 1) {
      return jsonResponse({ canceled: true, alreadyProcessed: true, id });
    }

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertReceivableAccess(scopeActor, receivable);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    await database
      .prepare(
        `UPDATE accounts_receivable
         SET canceled=1, canceled_by=?1, canceled_by_name=?2, canceled_at=CURRENT_TIMESTAMP,
             updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
      )
      .bind(actor.id, actor.displayName || "Administrador", id)
      .run();

    return jsonResponse({ canceled: true, id });
  } catch (error) {
    console.error("Não foi possível cancelar o recebível.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CANCELAR O RECEBÍVEL." }, 500);
  }
}
