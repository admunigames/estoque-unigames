import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin } from "../../../shared";
import { assertAccess, loadPayable, recalcPayableEntrySql } from "../../shared";

// Cancelamento é sempre um soft-cancel (status='canceled' + auditoria de
// quem/quando) — nunca exclui fisicamente a obrigação, só remove/estorna o
// lançamento derivado na DRE (ver recalcPayableEntrySql). Pagamentos já
// confirmados NÃO são revertidos automaticamente — cancelar uma conta com
// saldo já pago é uma decisão financeira separada, fora do escopo deste
// botão (o histórico de pagamentos continua visível pra referência).
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CANCELAR CONTAS A PAGAR." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const payable = await loadPayable(database, id);
    if (!payable) return jsonResponse({ error: "CONTA NÃO ENCONTRADA." }, 404);
    if (payable.status === "canceled") {
      return jsonResponse({ canceled: true, alreadyProcessed: true, id });
    }

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertAccess(scopeActor, payable);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const actorName = actor.displayName || "Administrador";
    const entryId = crypto.randomUUID();
    const statements: [string, unknown[]][] = [
      [
        `UPDATE accounts_payable
         SET status='canceled', canceled_by=?1, canceled_by_name=?2, canceled_at=CURRENT_TIMESTAMP,
             updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
        [actor.id, actorName, id],
      ],
      ...recalcPayableEntrySql(entryId, payable.companyId, payable.financeItemId, payable.competenceMonth, actor.id, actorName),
    ];

    // Se esta conta a pagar é a gêmea de uma dívida de Fornecedores em
    // Aberto (supplier_open_debts), cancelar por aqui (a tela genérica de
    // Contas a Pagar) precisa cancelar as duas juntas — senão a dívida
    // continua aparecendo como aberta na aba de Fornecedores em Aberto
    // (que filtra só por supplier_open_debts.canceled).
    const twinDebt = await database
      .prepare("SELECT id FROM supplier_open_debts WHERE accounts_payable_id=?1")
      .bind(id)
      .first<{ id: string }>();
    if (twinDebt) {
      statements.push([
        `UPDATE supplier_open_debts
         SET canceled=1, updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
        [actor.id, actorName, twinDebt.id],
      ]);
    }

    const prepared = statements.map(([sql, sqlValues]) => database.prepare(sql).bind(...sqlValues));
    await database.batch(prepared);

    return jsonResponse({ canceled: true, id });
  } catch (error) {
    console.error("Não foi possível cancelar a conta a pagar.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CANCELAR A CONTA A PAGAR." }, 500);
  }
}
