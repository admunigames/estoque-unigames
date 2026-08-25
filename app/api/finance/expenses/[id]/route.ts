import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { todayInTimezone } from "../../../../lib/finance-status";
import { displayStatusCaseSql } from "../../../../lib/payables-recurrence";
import { canManageFinance, identity, jsonResponse, safeText } from "../../shared";
import { assertExpenseAccess, loadExpense } from "../shared";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const { id } = await context.params;
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };

  try {
    const database = await getD1();
    const expense = await loadExpense(database, id);
    if (!expense) return jsonResponse({ error: "DESPESA NÃO ENCONTRADA." }, 404);

    const accessError = assertExpenseAccess(scopeActor, expense);
    if (accessError) return jsonResponse({ error: accessError }, 403);

    const today = todayInTimezone();
    const payables = await database
      .prepare(
        `SELECT id, company_id AS companyId, company_name AS companyName,
                original_amount_cents AS originalAmountCents, paid_amount_cents AS paidAmountCents,
                competence_month AS competenceMonth, due_date AS dueDate, status,
                installment_number AS installmentNumber, installment_total AS installmentTotal,
                recurrence_frequency AS recurrenceFrequency,
                ${displayStatusCaseSql(1)} AS displayStatus
         FROM accounts_payable WHERE expense_id=?2 ORDER BY company_id ASC, due_date ASC, id ASC`,
      )
      .bind(today, id)
      .all();

    const rateioShares =
      expense.rateioType === "rateio"
        ? await database
            .prepare(
              `SELECT company_id AS companyId, company_name AS companyName,
                      percent_basis_points AS percentBasisPoints, amount_cents AS amountCents
               FROM expense_rateio_shares WHERE expense_id=?1 ORDER BY company_id ASC`,
            )
            .bind(id)
            .all()
        : null;

    return jsonResponse({
      expense,
      payables: payables.results ?? [],
      rateioShares: rateioShares?.results ?? [],
    });
  } catch (error) {
    console.error("Não foi possível carregar a despesa.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A DESPESA." }, 500);
  }
}
