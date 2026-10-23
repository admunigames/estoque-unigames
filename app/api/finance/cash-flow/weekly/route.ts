import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { addDays, todayInTimezone } from "../../../../lib/finance-status";
import { buildWeeklyCash, mondayOf, type DailyAmount } from "../../../../lib/cash-flow";
import { canManageFinance, identity, jsonResponse, safeText } from "../../shared";
import { loadCashFlowProjection, resolveCashFlowScope } from "../shared";

// CAIXA SEMANAL — quadro das últimas 8 semanas + atual + próximas 4.
// Semanas passadas usam o REALIZADO (recebíveis recebidos, pagamentos
// confirmados e RH pago); atual e futuras usam a MESMA projeção da aba
// PROJEÇÃO (loadCashFlowProjection). Conta feita em buildWeeklyCash.

const WEEKS_BACK = 8;
const WEEKS_AHEAD = 4;

function queryParams() {
  const values: unknown[] = [];
  return { values, bind(value: unknown) { values.push(value); return `?${values.length}`; } };
}

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
  const companyId = scope.companyId;
  // Recorte por CONTA (23/10/2026): só a conta escolhida; RH não tem conta e
  // fica de fora nessa visão.
  const accountId = safeText(params.get("accountId"), 80);
  const today = todayInTimezone();
  const currentMonday = mondayOf(today);
  const weeks = Array.from({ length: WEEKS_BACK + 1 + WEEKS_AHEAD }, (_, i) => addDays(currentMonday, (i - WEEKS_BACK) * 7));
  const firstWeek = weeks[0];
  const lastBalanceWeek = addDays(weeks[weeks.length - 1], 7);
  const yesterday = addDays(today, -1);

  try {
    const database = await getD1();
    const realized = (sql: (q: ReturnType<typeof queryParams>) => string) => {
      const q = queryParams();
      const text = sql(q);
      return database.prepare(text).bind(...q.values).all<DailyAmount>();
    };
    const company = (q: ReturnType<typeof queryParams>, column: string) =>
      companyId ? `AND ${column} = ${q.bind(companyId)}` : "";
    const account = (q: ReturnType<typeof queryParams>, column: string) =>
      accountId ? `AND ${column} = ${q.bind(accountId)}` : "";
    const none = { results: [] as DailyAmount[] };

    const [projection, balances, received, paid, payrollPaid, benefitsPaid] = await Promise.all([
      loadCashFlowProjection(database, companyId, today, accountId),
      (() => {
        const q = queryParams();
        const text = `SELECT account_id AS accountId, week_date AS weekDate, balance_cents AS balanceCents
          FROM finance_account_weekly_balances
          WHERE week_date >= ${q.bind(firstWeek)} AND week_date <= ${q.bind(lastBalanceWeek)} ${company(q, "company_id")} ${account(q, "account_id")}`;
        return database.prepare(text).bind(...q.values).all<{ accountId: string; weekDate: string; balanceCents: number }>();
      })(),
      realized((q) => `SELECT received_date AS date, COALESCE(SUM(received_amount_cents), 0) AS amountCents
        FROM accounts_receivable
        WHERE canceled = 0 AND received_amount_cents IS NOT NULL
          AND received_date >= ${q.bind(firstWeek)} AND received_date <= ${q.bind(yesterday)} ${company(q, "company_id")}
          ${account(q, "finance_account_id")}
        GROUP BY received_date`),
      realized((q) => `SELECT p.payment_date AS date, COALESCE(SUM(p.amount_cents), 0) AS amountCents
        FROM accounts_payable_payments p JOIN accounts_payable a ON a.id = p.payable_id
        WHERE a.status <> 'canceled' AND p.confirmed_at <> ''
          AND p.payment_date >= ${q.bind(firstWeek)} AND p.payment_date <= ${q.bind(yesterday)} ${company(q, "a.company_id")}
          ${account(q, "(CASE WHEN p.finance_account_id <> '' THEN p.finance_account_id ELSE a.finance_account_id END)")}
        GROUP BY p.payment_date`),
      accountId ? Promise.resolve(none) : realized((q) => `SELECT payment_date AS date,
          COALESCE(SUM(base_salary_cents + bonus_cents + overtime_cents + additions_cents + other_cents - deductions_cents), 0) AS amountCents
        FROM hr_payroll_entries
        WHERE payment_done = 1 AND payment_date >= ${q.bind(firstWeek)} AND payment_date <= ${q.bind(yesterday)} ${company(q, "company_id")}
        GROUP BY payment_date`),
      accountId ? Promise.resolve(none) : realized((q) => `SELECT payment_date AS date, COALESCE(SUM(amount_cents), 0) AS amountCents
        FROM hr_benefits
        WHERE payment_date >= ${q.bind(firstWeek)} AND payment_date <= ${q.bind(yesterday)} ${company(q, "company_id")}
        GROUP BY payment_date`),
    ]);

    const daily = (rows: { results?: DailyAmount[] }) =>
      (rows.results ?? []).map((row) => ({ date: row.date, amountCents: Number(row.amountCents || 0) }));
    const accounts = projection.balances.accounts.map((a) => ({ accountId: a.accountId, accountName: a.accountName }));
    const rows = buildWeeklyCash({
      today,
      weeks,
      accounts,
      balances: (balances.results ?? []).map((b) => ({ ...b, balanceCents: Number(b.balanceCents || 0) })),
      realizedIn: daily(received),
      realizedOut: [...daily(paid), ...daily(payrollPaid), ...daily(benefitsPaid)],
      projection: projection.series.days,
      caixaAtualCents: projection.balances.caixaAtualCents,
    });
    return jsonResponse({
      today,
      currentMonday,
      currentMondayInformed: (balances.results ?? []).some((b) => b.weekDate === currentMonday),
      accounts: projection.balances.accounts,
      weeks: rows,
    });
  } catch (error) {
    console.error("Não foi possível carregar o caixa semanal.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O CAIXA SEMANAL." }, 500);
  }
}
