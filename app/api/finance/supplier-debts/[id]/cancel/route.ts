import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin } from "../../../shared";
import { recalcPayableEntrySql } from "../../../payables/shared";
import { assertSupplierDebtAccess, loadSupplierDebt } from "../../shared";

type PayableTwin = {
  companyId: string;
  financeItemId: string;
  competenceMonth: string;
  status: string;
};

// Cancela a dívida E a accounts_payable gêmea na MESMA transação (soft-cancel,
// mesmo padrão de app/api/finance/payables/[id]/cancel/route.ts) — nunca uma
// sem a outra, pra não deixar as duas tabelas divergentes.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CANCELAR DÍVIDAS DE FORNECEDORES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const debt = await loadSupplierDebt(database, id);
    if (!debt) return jsonResponse({ error: "DÍVIDA NÃO ENCONTRADA." }, 404);
    if (debt.canceled) return jsonResponse({ canceled: true, alreadyProcessed: true, id });

    const scopeActor = {
      role: actor.role,
      companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
      permissions: actor.permissions,
    };
    const accessError = assertSupplierDebtAccess(scopeActor, debt);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const payable = await database
      .prepare(
        `SELECT company_id AS companyId, finance_item_id AS financeItemId, competence_month AS competenceMonth, status
         FROM accounts_payable WHERE id=?1`,
      )
      .bind(debt.accountsPayableId)
      .first<PayableTwin>();
    if (!payable) return jsonResponse({ error: "CONTA A PAGAR VINCULADA NÃO ENCONTRADA (DADOS INCONSISTENTES)." }, 500);

    const actorName = actor.displayName || "Administrador";
    const entryId = crypto.randomUUID();
    const statements: [string, unknown[]][] = [
      [
        `UPDATE supplier_open_debts
         SET canceled=1, updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
        [actor.id, actorName, id],
      ],
    ];
    if (payable.status !== "canceled") {
      statements.push([
        `UPDATE accounts_payable
         SET status='canceled', canceled_by=?1, canceled_by_name=?2, canceled_at=CURRENT_TIMESTAMP,
             updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
        [actor.id, actorName, debt.accountsPayableId],
      ]);
      statements.push(
        ...recalcPayableEntrySql(entryId, payable.companyId, payable.financeItemId, payable.competenceMonth, actor.id, actorName),
      );
    }

    await database.batch(statements.map(([sql, sqlValues]) => database.prepare(sql).bind(...sqlValues)));

    return jsonResponse({ canceled: true, id });
  } catch (error) {
    console.error("Não foi possível cancelar a dívida de fornecedor.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CANCELAR A DÍVIDA DE FORNECEDOR." }, 500);
  }
}
