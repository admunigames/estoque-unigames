import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { planPayablesBulk } from "../../payables/shared";
import { assertExpenseAccess, loadExpense, planExpenseDeletion, type ExpenseRow } from "../shared";

// Ações em lote de DESPESAS: { action: 'category' | 'delete', ids, fields }.
// - category: categoria e/ou centro de custo da despesa e de TODAS as contas
//   dela (mesma regra do lote de Contas a Pagar — planPayablesBulk — com a
//   DRE recalculada);
// - delete: exclui a despesa inteira (contas, fatias do rateio, anexos e
//   agendamentos) — PULA a que tem pagamento confirmado e a que veio do
//   cartão corporativo ou do extrato (o lançamento de origem apontaria para
//   ela). A DRE das células tocadas é recalculada na mesma transação.
// Confere TODOS os ids antes (404 se algum sumiu, 403 se de outra loja).
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR DESPESAS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 20);
    if (action !== "category" && action !== "delete") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map((value) => safeText(value, 80)).filter(Boolean))];
    if (!ids.length) return jsonResponse({ error: "SELECIONE AO MENOS UMA DESPESA." }, 400);
    if (ids.length > 300) return jsonResponse({ error: "SELEÇÃO GRANDE DEMAIS (MÁX. 300)." }, 400);
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : {}) as JsonMap;

    const database = await getD1();
    const expenses: ExpenseRow[] = [];
    for (const id of ids) {
      const expense = await loadExpense(database, id);
      if (!expense) return jsonResponse({ error: "ALGUMA DESPESA SELECIONADA NÃO EXISTE MAIS. ATUALIZE A LISTA." }, 404);
      const accessError = assertExpenseAccess(scopeActor, expense);
      if (accessError) return jsonResponse({ error: accessError }, 403);
      expenses.push(expense);
    }
    const payablesOf = async (expenseId: string) =>
      (
        await database
          .prepare(
            `SELECT id, company_id AS companyId, finance_item_id AS financeItemId, competence_month AS competenceMonth
             FROM accounts_payable WHERE expense_id=?1`,
          )
          .bind(expenseId)
          .all<{ id: string; companyId: string; financeItemId: string; competenceMonth: string }>()
      ).results ?? [];
    const actorName = actor.displayName || "Administrador";
    const skipped: Array<{ id: string; description: string; reason: string }> = [];
    const statements: [string, unknown[]][] = [];
    let applied = 0;

    if (action === "category") {
      const financeItemId = safeText(fields.financeItemId, 80);
      const costCenterChanged = fields.costCenterId !== undefined;
      const payableIds: string[] = [];
      const expenseOfPayable = new Map<string, ExpenseRow>();
      for (const expense of expenses) {
        for (const payable of await payablesOf(expense.id)) {
          payableIds.push(payable.id);
          expenseOfPayable.set(payable.id, expense);
        }
      }
      const plan = await planPayablesBulk(database, actor, scopeActor, "category", payableIds, fields);
      if ("error" in plan) return jsonResponse({ error: plan.error }, plan.status);
      const skippedExpenses = new Set(plan.skipped.map((item) => expenseOfPayable.get(item.id)?.id));
      for (const item of plan.skipped) {
        const expense = expenseOfPayable.get(item.id);
        if (expense && !skipped.some((row) => row.id === expense.id)) skipped.push({ id: expense.id, description: expense.description, reason: item.reason });
      }
      statements.push(...plan.statements);
      let costCenterName = "";
      const costCenterId = safeText(fields.costCenterId, 80);
      if (costCenterId) {
        const row = await database.prepare("SELECT name FROM finance_cost_centers WHERE id=?1").bind(costCenterId).first<{ name: string }>();
        costCenterName = row?.name ?? "";
      }
      for (const expense of expenses) {
        if (skippedExpenses.has(expense.id)) continue;
        statements.push([
          `UPDATE expenses SET finance_item_id=?1, cost_center=?2, cost_center_id=?3,
             updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP WHERE id=?6`,
          [
            financeItemId || expense.financeItemId,
            costCenterChanged ? costCenterName : expense.costCenter,
            costCenterChanged ? costCenterId || null : expense.costCenterId,
            actor.id,
            actorName,
            expense.id,
          ],
        ]);
        applied += 1;
      }
    } else {
      for (const expense of expenses) {
        const plan = await planExpenseDeletion(database, expense, { id: actor.id, name: actorName });
        if ("skip" in plan) { skipped.push({ id: expense.id, description: expense.description, reason: plan.skip }); continue; }
        statements.push(...plan.statements);
        applied += 1;
      }
    }
    if (statements.length) await database.batch(statements.map(([sql, values]) => database.prepare(sql).bind(...values)));
    return jsonResponse({ applied, skipped });
  } catch (error) {
    console.error("Não foi possível aplicar o lote de despesas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A AÇÃO EM LOTE. NADA FOI ALTERADO." }, 500);
  }
}
