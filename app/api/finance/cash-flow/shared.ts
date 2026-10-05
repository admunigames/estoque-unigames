import { getD1 } from "../../../../db";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { addDays } from "../../../lib/finance-status";
import {
  buildCashFlowSeries,
  MAX_CASH_FLOW_DAYS,
  monthsInRange,
  payrollFallbackPaymentDate,
  type DailyAmount,
} from "../../../lib/cash-flow";
import { identity, jsonResponse, safeText } from "../shared";
import { loadEffectiveCashFlowSettings } from "../cash-flow-settings/shared";
import { loadAccountBalances } from "../account-balances/shared";

// Fonte ÚNICA das saídas do Fluxo de Caixa (Financeiro 4/9). A projeção
// (./route.ts) soma estes itens por dia e a LISTA DE PAGAMENTOS
// (./payments/route.ts) mostra os mesmos itens um a um — por isso a soma da
// lista de cada dia é sempre igual às saídas daquele dia na projeção. Não
// existe uma segunda versão destas consultas.
//
// Regras (ver [[estoque_modulo_contas_a_pagar]]):
//  - accounts_payable (Contas a Pagar, Fornecedores em Aberto e Despesas):
//    o saldo ainda NÃO coberto (original − pago − agendados não confirmados)
//    sai na due_date; cada pagamento sai na payment_date (agendado não
//    confirmado sempre; confirmado só de hoje em diante — o do passado já
//    está no saldo informado das contas).
//  - RH: folha lançada, folha ainda não lançada (salário-base dos ativos),
//    benefícios e comissões; sem payment_date → dia fixo do mês seguinte.
//  - datas anteriores a hoje caem no dia 0 da série (vencidos).
// SQL escrito para rodar igual no Postgres (produção) e no SQLite (testes):
// sem GREATEST/::cast — o "nunca negativo" é feito em JS.

type Database = Awaited<ReturnType<typeof getD1>>;

export type CashFlowOrigin = "payable" | "supplier_debt" | "expense" | "payroll" | "benefits" | "commissions";
export type CashFlowItemStatus = "overdue" | "scheduled" | "paid" | "due";

export type CashFlowItem = {
  /** Único na lista (uma conta pode ter saldo em aberto E pagamento agendado). */
  key: string;
  origin: CashFlowOrigin;
  /** accounts_payable.id nas origens de contas; '' no RH. */
  payableId: string;
  date: string;
  description: string;
  supplierName: string;
  categoryName: string;
  companyId: string;
  companyName: string;
  amountCents: number;
  status: CashFlowItemStatus;
};

export const ORIGIN_LABELS: Record<CashFlowOrigin, string> = {
  payable: "CONTA A PAGAR",
  supplier_debt: "FORNECEDOR EM ABERTO",
  expense: "DESPESA",
  payroll: "FOLHA",
  benefits: "BENEFÍCIOS",
  commissions: "COMISSÕES",
};

/** Numerador de placeholders por consulta (?1, ?2, … junto com os binds). */
function queryParams() {
  const values: unknown[] = [];
  return {
    values,
    bind(value: unknown): string {
      values.push(value);
      return `?${values.length}`;
    },
  };
}

/** Escopo de loja das rotas do Fluxo de Caixa (mesma regra de sempre). */
export function resolveCashFlowScope(request: Request, requestedCompanyId: string) {
  const actor = identity(request);
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return { error: jsonResponse({ error: NO_COMPANY_ERROR }, 403) };
  }
  if (!allStores && requestedCompanyId && requestedCompanyId !== scopeActor.companyId) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403) };
  }
  return { companyId: allStores ? requestedCompanyId : scopeActor.companyId, allStores, scopeCompanyId: scopeActor.companyId };
}

type PayableRow = {
  id: string;
  date: string;
  amountCents: number;
  description: string;
  supplierName: string | null;
  categoryName: string | null;
  companyId: string;
  companyName: string;
  expenseId: string | null;
  idempotencyKey: string;
};

function payableOrigin(row: { expenseId: string | null; idempotencyKey: string }): CashFlowOrigin {
  if (row.expenseId) return "expense";
  if (String(row.idempotencyKey || "").startsWith("supplier-debt:")) return "supplier_debt";
  return "payable";
}

/**
 * Todas as saídas de hoje até `lastDate` (inclusive vencidas, com a data
 * original). `payrollDefaultPaymentDay` vem das configurações do fluxo.
 */
export async function loadCashFlowOutflows(
  database: Database,
  options: { companyId: string; today: string; lastDate: string; payrollDefaultPaymentDay: number },
): Promise<CashFlowItem[]> {
  const { companyId, today, lastDate } = options;
  const currentMonth = today.slice(0, 7);
  const lastMonth = lastDate.slice(0, 7);
  const horizonMonths = monthsInRange(today, lastDate);
  const statusOf = (date: string, scheduled: boolean): CashFlowItemStatus =>
    scheduled ? "scheduled" : date < today ? "overdue" : "due";

  const payableJoins = `LEFT JOIN finance_suppliers f ON f.id = a.supplier_id
     LEFT JOIN finance_items i ON i.id = a.finance_item_id
     LEFT JOIN finance_categories c ON c.id = i.category_id`;
  const payableColumns = `a.description, f.name AS supplierName,
     CASE WHEN c.name IS NULL THEN i.name ELSE c.name || ' › ' || i.name END AS categoryName,
     a.company_id AS companyId, a.company_name AS companyName, a.expense_id AS expenseId,
     a.idempotency_key AS idempotencyKey`;

  const [open, payments, payroll, payrollMissing, benefits, commissions] = await Promise.all([
    // Saldo ainda NÃO coberto por pagamento, no vencimento. Agendado não
    // confirmado não mexe em paid_amount_cents, então é descontado aqui
    // (senão a conta sairia duas vezes: no vencimento e na data agendada).
    (() => {
      const q = queryParams();
      const dateLimit = q.bind(lastDate);
      const company = companyId ? `AND a.company_id = ${q.bind(companyId)}` : "";
      return database
        .prepare(
          `SELECT a.id, a.due_date AS date,
                  a.original_amount_cents - a.paid_amount_cents - COALESCE(s.total, 0) AS amountCents,
                  ${payableColumns}
           FROM accounts_payable a
           LEFT JOIN (
             SELECT payable_id, SUM(amount_cents) AS total FROM accounts_payable_payments
             WHERE scheduled = 1 AND confirmed_at = '' GROUP BY payable_id
           ) s ON s.payable_id = a.id
           ${payableJoins}
           WHERE a.status NOT IN ('canceled', 'paid')
             AND a.original_amount_cents > a.paid_amount_cents
             AND a.due_date <= ${dateLimit} ${company}`,
        )
        .bind(...q.values)
        .all<PayableRow>();
    })(),
    // Pagamentos: agendados não confirmados sempre; confirmados de hoje em diante.
    (() => {
      const q = queryParams();
      const from = q.bind(today);
      const to = q.bind(lastDate);
      const company = companyId ? `AND a.company_id = ${q.bind(companyId)}` : "";
      return database
        .prepare(
          `SELECT a.id, p.id AS paymentId, p.payment_date AS date, p.amount_cents AS amountCents,
                  p.scheduled AS scheduled, p.confirmed_at AS confirmedAt, ${payableColumns}
           FROM accounts_payable_payments p
           JOIN accounts_payable a ON a.id = p.payable_id
           ${payableJoins}
           WHERE a.status <> 'canceled' AND p.payment_date <= ${to}
             AND ((p.scheduled = 1 AND p.confirmed_at = '')
                  OR (p.confirmed_at <> '' AND p.payment_date >= ${from}))
             ${company}`,
        )
        .bind(...q.values)
        .all<PayableRow & { paymentId: string; scheduled: number; confirmedAt: string }>();
    })(),
    // RH: folha lançada (líquido = adições − descontos, como em
    // hr-payroll/entries netCentsFor). Recorte de competência a partir do mês
    // corrente e sem o que já foi pago no passado.
    (() => {
      const q = queryParams();
      const from = q.bind(currentMonth);
      const to = q.bind(lastMonth);
      const paidCutoff = q.bind(today);
      const company = companyId ? `AND company_id = ${q.bind(companyId)}` : "";
      return database
        .prepare(
          `SELECT month, payment_date AS paymentDate, company_id AS companyId, MAX(company_name) AS companyName,
                  COALESCE(SUM(base_salary_cents + bonus_cents + overtime_cents + additions_cents
                               + other_cents - deductions_cents), 0) AS amountCents
           FROM hr_payroll_entries
           WHERE month >= ${from} AND month <= ${to}
             AND NOT (payment_done = 1 AND payment_date <> '' AND payment_date < ${paidCutoff})
             ${company}
           GROUP BY month, payment_date, company_id`,
        )
        .bind(...q.values)
        .all<{ month: string; paymentDate: string; companyId: string; companyName: string; amountCents: number }>();
    })(),
    // RH: folha AINDA NÃO lançada → salário-base dos ativos (sem inventar
    // bônus/desconto). Benefícios e comissões não têm esse fallback.
    (() => {
      const q = queryParams();
      const monthsUnion = horizonMonths.map((month) => `SELECT CAST(${q.bind(month)} AS TEXT) AS month`).join(" UNION ALL ");
      const company = companyId ? `AND e.company_id = ${q.bind(companyId)}` : "";
      return database
        .prepare(
          `SELECT months.month AS month, '' AS paymentDate, e.company_id AS companyId, MAX(e.company_name) AS companyName,
                  COALESCE(SUM(e.salary_cents), 0) AS amountCents
           FROM hr_employees e
           CROSS JOIN (${monthsUnion}) AS months
           WHERE e.status = 'active' ${company}
             AND NOT EXISTS (
               SELECT 1 FROM hr_payroll_entries p
               WHERE p.employee_id = e.id AND p.month = months.month
             )
           GROUP BY months.month, e.company_id`,
        )
        .bind(...q.values)
        .all<{ month: string; paymentDate: string; companyId: string; companyName: string; amountCents: number }>();
    })(),
    // RH: benefícios (sem payment_done — "pago no passado" decidido pela data).
    (() => {
      const q = queryParams();
      const from = q.bind(currentMonth);
      const to = q.bind(lastMonth);
      const paidCutoff = q.bind(today);
      const company = companyId ? `AND company_id = ${q.bind(companyId)}` : "";
      return database
        .prepare(
          `SELECT month, payment_date AS paymentDate, company_id AS companyId, MAX(company_name) AS companyName,
                  COALESCE(SUM(amount_cents), 0) AS amountCents
           FROM hr_benefits
           WHERE month >= ${from} AND month <= ${to}
             AND NOT (payment_date <> '' AND payment_date < ${paidCutoff})
             ${company}
           GROUP BY month, payment_date, company_id`,
        )
        .bind(...q.values)
        .all<{ month: string; paymentDate: string; companyId: string; companyName: string; amountCents: number }>();
    })(),
    // RH: comissões — sem data de pagamento própria: sempre o dia fixo.
    (() => {
      const q = queryParams();
      const from = q.bind(currentMonth);
      const to = q.bind(lastMonth);
      const company = companyId ? `AND company_id = ${q.bind(companyId)}` : "";
      return database
        .prepare(
          `SELECT month, '' AS paymentDate, company_id AS companyId, MAX(company_name) AS companyName,
                  COALESCE(SUM(commission_cents + bonuses_cents + premiums_cents
                               - discounts_cents + adjustments_cents), 0) AS amountCents
           FROM hr_commissions
           WHERE month >= ${from} AND month <= ${to} ${company}
           GROUP BY month, company_id`,
        )
        .bind(...q.values)
        .all<{ month: string; paymentDate: string; companyId: string; companyName: string; amountCents: number }>();
    })(),
  ]);

  const items: CashFlowItem[] = [];
  for (const row of open.results ?? []) {
    const amountCents = Number(row.amountCents || 0);
    if (amountCents <= 0 || !row.date) continue;
    items.push({
      key: `open:${row.id}`,
      origin: payableOrigin(row),
      payableId: row.id,
      date: row.date,
      description: row.description || "",
      supplierName: row.supplierName || "",
      categoryName: row.categoryName || "",
      companyId: row.companyId || "",
      companyName: row.companyName || "",
      amountCents,
      status: statusOf(row.date, false),
    });
  }
  for (const row of payments.results ?? []) {
    const amountCents = Number(row.amountCents || 0);
    if (!row.date) continue;
    const scheduled = Number(row.scheduled) === 1 && !row.confirmedAt;
    items.push({
      key: `payment:${row.paymentId}`,
      origin: payableOrigin(row),
      payableId: row.id,
      date: row.date,
      description: row.description || "",
      supplierName: row.supplierName || "",
      categoryName: row.categoryName || "",
      companyId: row.companyId || "",
      companyName: row.companyName || "",
      amountCents,
      status: scheduled ? "scheduled" : "paid",
    });
  }

  const hrGroups: Array<[CashFlowOrigin, string, typeof payroll]> = [
    ["payroll", "FOLHA", payroll],
    ["payroll", "FOLHA (SALÁRIO-BASE, AINDA NÃO LANÇADA)", payrollMissing],
    ["benefits", "BENEFÍCIOS", benefits],
    ["commissions", "COMISSÕES", commissions],
  ];
  for (const [origin, label, rows] of hrGroups) {
    for (const row of rows.results ?? []) {
      const amountCents = Number(row.amountCents || 0);
      if (!amountCents) continue;
      const paymentDate = safeText(row.paymentDate, 10);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(paymentDate)
        ? paymentDate
        : payrollFallbackPaymentDate(row.month, options.payrollDefaultPaymentDay);
      items.push({
        key: `${origin}:${label}:${row.month}:${paymentDate}:${row.companyId}`,
        origin,
        payableId: "",
        date,
        description: `${label} ${row.month.slice(5, 7)}/${row.month.slice(0, 4)}`,
        supplierName: "",
        categoryName: "RH",
        companyId: row.companyId || "",
        companyName: row.companyName || "",
        amountCents,
        status: statusOf(date, false),
      });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));
  return items;
}

/** Itens → agregados diários (a forma que buildCashFlowSeries recebe). */
export function outflowsToDaily(items: CashFlowItem[], kind: "payables" | "payroll"): DailyAmount[] {
  const hr = new Set<CashFlowOrigin>(["payroll", "benefits", "commissions"]);
  return items
    .filter((item) => (kind === "payroll" ? hr.has(item.origin) : !hr.has(item.origin)))
    .map((item) => ({ date: item.date, amountCents: item.amountCents }));
}

/** Última data da janela de 90 dias a partir de hoje. */
export function cashFlowLastDate(today: string, days: number) {
  return addDays(today, days - 1);
}

/**
 * Projeção completa de 90 dias (mesma conta de sempre): entradas dos
 * recebíveis + saídas de loadCashFlowOutflows, sobre o Caixa Atual de
 * loadAccountBalances. Usada pela rota da projeção e pelo Caixa Semanal.
 */
export async function loadCashFlowProjection(database: Database, companyId: string, today: string) {
  const lastDate = cashFlowLastDate(today, MAX_CASH_FLOW_DAYS);
  const settings = await loadEffectiveCashFlowSettings(database, companyId);
  const [receivablesPending, receivablesReceived, outflows, balances] = await Promise.all([
    // ENTRADAS — recebíveis ainda não recebidos, na data prevista.
    (() => {
      const q = queryParams();
      const dateLimit = q.bind(lastDate);
      const company = companyId ? `AND company_id = ${q.bind(companyId)}` : "";
      return database
        .prepare(
          `SELECT expected_date AS date, COALESCE(SUM(expected_amount_cents), 0) AS amountCents
           FROM accounts_receivable
           WHERE canceled = 0 AND received_amount_cents IS NULL
             AND expected_date <= ${dateLimit} ${company}
           GROUP BY expected_date`,
        )
        .bind(...q.values)
        .all<DailyAmount>();
    })(),
    // ENTRADAS — recebidos entram pelo valor e pela data reais.
    (() => {
      const q = queryParams();
      const from = q.bind(today);
      const to = q.bind(lastDate);
      const company = companyId ? `AND company_id = ${q.bind(companyId)}` : "";
      return database
        .prepare(
          `SELECT received_date AS date, COALESCE(SUM(received_amount_cents), 0) AS amountCents
           FROM accounts_receivable
           WHERE canceled = 0 AND received_amount_cents IS NOT NULL AND received_date <> ''
             AND received_date >= ${from} AND received_date <= ${to} ${company}
           GROUP BY received_date`,
        )
        .bind(...q.values)
        .all<DailyAmount>();
    })(),
    loadCashFlowOutflows(database, {
      companyId,
      today,
      lastDate,
      payrollDefaultPaymentDay: settings.payrollDefaultPaymentDay,
    }),
    // Caixa Atual pela MESMA função da tela de saldos.
    loadAccountBalances(database, companyId),
  ]);
  const toDaily = (rows: { results?: DailyAmount[] }): DailyAmount[] =>
    (rows.results ?? [])
      .filter((row) => Boolean(row.date))
      .map((row) => ({ date: row.date, amountCents: Number(row.amountCents || 0) }));
  const series = buildCashFlowSeries({
    today,
    days: MAX_CASH_FLOW_DAYS,
    caixaAtualCents: balances.caixaAtualCents,
    entradas: [...toDaily(receivablesPending), ...toDaily(receivablesReceived)],
    saidasPayables: outflowsToDaily(outflows, "payables"),
    saidasPayroll: outflowsToDaily(outflows, "payroll"),
  });
  return { settings, balances, series, outflows, lastDate };
}
