import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { addDays, todayInTimezone } from "../../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, safeText } from "../../shared";
import { resolveCashFlowScope } from "../../cash-flow/shared";

// RECEBIMENTOS FUTUROS (aba RECEBÍVEIS do Fluxo de Caixa): tudo não
// recebido e não cancelado com data prevista até hoje + `days` (padrão 90,
// máx. 365). Os de data anterior a hoje vêm como ATRASADOS. A tela agrupa
// por semana e adquirente. SQL portátil (Postgres e SQLite).
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const params = new URL(request.url).searchParams;
  const scope = resolveCashFlowScope(request, safeText(params.get("companyId"), 80));
  if (scope.error) return scope.error;
  const today = todayInTimezone();
  const days = Math.min(365, Math.max(1, Number(params.get("days")) || 90));
  const to = addDays(today, days - 1);

  try {
    const database = await getD1();
    const values: unknown[] = [to];
    let company = "";
    if (scope.companyId) {
      values.push(scope.companyId);
      company = "AND company_id = ?2";
    }
    const rows = await database
      .prepare(
        `SELECT id, company_id AS companyId, company_name AS companyName, operator_text AS operatorText,
                competence_month AS competenceMonth, expected_date AS expectedDate,
                expected_amount_cents AS expectedAmountCents
         FROM accounts_receivable
         WHERE canceled = 0 AND received_amount_cents IS NULL AND expected_date <> ''
           AND expected_date <= ?1 ${company}
         ORDER BY expected_date ASC, operator_text ASC LIMIT 3000`,
      )
      .bind(...values)
      .all<{ id: string; expectedDate: string; expectedAmountCents: number }>();
    const all = (rows.results ?? []).map((row) => ({ ...row, expectedAmountCents: Number(row.expectedAmountCents || 0) }));
    return jsonResponse({
      today,
      to,
      overdue: all.filter((row) => row.expectedDate < today),
      upcoming: all.filter((row) => row.expectedDate >= today),
    });
  } catch (error) {
    console.error("Não foi possível carregar os recebimentos futuros.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS RECEBIMENTOS FUTUROS." }, 500);
  }
}
