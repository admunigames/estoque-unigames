import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { periodDueRange, todayInTimezone, type DashboardPeriod } from "../../../lib/finance-status";
import { DATE_PATTERN } from "../../../lib/payables-recurrence";
import { canManageFinance, identity, jsonResponse, safeText } from "../shared";
import {
  buildByStoreDre,
  buildConsolidatedDre,
  buildStoreDre,
  monthsBetween,
  type ByStoreDreResult,
  type ConsolidatedCategory,
} from "../dre/shared";
import { displayStatusCaseSql } from "../payables/shared";
import { buildOpenSuppliers, buildPayablesQuickViews } from "../payables/summary/shared";

// Dashboard Geral do Financeiro (Fase 2) — agrega, numa única resposta, os
// indicadores que já existem espalhados por DRE/Contas a Pagar/Fornecedores,
// pra evitar N requisições separadas no front-end. Nenhuma fórmula nova é
// criada aqui: tudo é reaproveitado de app/api/finance/dre/shared.ts e
// app/api/finance/payables/summary/shared.ts — este arquivo só decide QUAIS
// meses/lojas consultar a partir do filtro de período e soma os resultados
// quando o período cobre mais de um mês (ex.: "Ano").

const VALID_PERIODS = new Set<DashboardPeriod>(["day", "week", "month", "year"]);

type DreLikeResult = {
  revenueCents: number;
  expenseTotalCents: number;
  resultCents: number;
  marginBasisPoints: number;
  categories: ConsolidatedCategory[];
};

function marginOf(revenueCents: number, resultCents: number): number {
  return revenueCents > 0 ? Math.round((resultCents / revenueCents) * 10000) : 0;
}

/**
 * Soma a DRE (consolidada ou de uma loja específica) por vários meses — usado
 * só quando o período selecionado é "Ano" (a DRE em si é sempre mensal, ver
 * finance_store_entries/finance_store_revenue). Reaproveita buildStoreDre /
 * buildConsolidatedDre mês a mês; a soma final recalcula resultado/margem
 * com a MESMA fórmula de app/api/finance/dre/shared.ts (revenue - despesa,
 * margem = resultado/receita) — não uma fórmula nova, só aplicada ao total.
 */
async function sumDreAcrossMonths(
  database: Awaited<ReturnType<typeof getD1>>,
  effectiveCompanyId: string,
  months: string[],
): Promise<DreLikeResult> {
  const perMonth = await Promise.all(
    months.map((month) =>
      effectiveCompanyId ? buildStoreDre(database, effectiveCompanyId, month) : buildConsolidatedDre(database, month),
    ),
  );
  const revenueCents = perMonth.reduce((sum, result) => sum + result.revenueCents, 0);
  const expenseTotalCents = perMonth.reduce((sum, result) => sum + result.expenseTotalCents, 0);
  const resultCents = revenueCents - expenseTotalCents;

  const categoryMap = new Map<string, ConsolidatedCategory>();
  for (const monthResult of perMonth) {
    for (const category of monthResult.categories) {
      const existing = categoryMap.get(category.id) ?? { id: category.id, name: category.name, totalCents: 0 };
      existing.totalCents += category.totalCents;
      categoryMap.set(category.id, existing);
    }
  }

  return {
    revenueCents,
    expenseTotalCents,
    resultCents,
    marginBasisPoints: marginOf(revenueCents, resultCents),
    categories: [...categoryMap.values()],
  };
}

type ByStoreRow = ByStoreDreResult["stores"][number];

/** Mesma lógica de soma mensal acima, só que para o comparativo por loja. */
async function sumByStoreAcrossMonths(
  database: Awaited<ReturnType<typeof getD1>>,
  months: string[],
): Promise<ByStoreRow[]> {
  const perMonth = await Promise.all(months.map((month) => buildByStoreDre(database, month)));
  const map = new Map<string, { storeId: string; storeName: string; revenueCents: number; expenseTotalCents: number }>();
  for (const monthResult of perMonth) {
    for (const store of monthResult.stores) {
      const existing =
        map.get(store.storeId) ?? { storeId: store.storeId, storeName: store.storeName, revenueCents: 0, expenseTotalCents: 0 };
      existing.revenueCents += store.revenueCents;
      existing.expenseTotalCents += store.expenseTotalCents;
      map.set(store.storeId, existing);
    }
  }
  return [...map.values()].map((store) => {
    const resultCents = store.revenueCents - store.expenseTotalCents;
    return { ...store, resultCents, marginBasisPoints: marginOf(store.revenueCents, resultCents), categories: [] };
  });
}

type SumRow = { cents: number };
type CostCenterRow = { costCenterId: string; costCenterName: string; totalCents: number };
type UpcomingPayableRow = {
  id: string;
  description: string;
  companyId: string;
  companyName: string;
  supplierId: string;
  dueDate: string;
  originalAmountCents: number;
  paidAmountCents: number;
  displayStatus: string;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  const url = new URL(request.url);
  const params = url.searchParams;

  const companyId = safeText(params.get("companyId"), 80);
  if (!allStores && companyId && companyId !== scopeActor.companyId) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
  }
  const effectiveCompanyId = allStores ? companyId : scopeActor.companyId;

  const periodRaw = safeText(params.get("period"), 10) as DashboardPeriod;
  const period: DashboardPeriod = VALID_PERIODS.has(periodRaw) ? periodRaw : "month";

  const today = todayInTimezone();
  const referenceDateRaw = safeText(params.get("date"), 10);
  const referenceDate = DATE_PATTERN.test(referenceDateRaw) ? referenceDateRaw : today;

  const { from, to } = periodDueRange(period, referenceDate);
  const months = period === "year" ? monthsBetween(from.slice(0, 7), to.slice(0, 7)) : [referenceDate.slice(0, 7)];

  try {
    const database = await getD1();

    const scopeCondition = effectiveCompanyId ? "AND company_id=?3" : "";
    const scopeParams = effectiveCompanyId ? [effectiveCompanyId] : [];

    const [realizedRow, projectedRow, costCentersResult, upcomingResult, quickViews, openSuppliers, dre, byStore] =
      await Promise.all([
        database
          .prepare(
            `SELECT COALESCE(SUM(paid_amount_cents), 0) AS cents FROM accounts_payable
             WHERE status='paid' AND due_date >= ?1 AND due_date <= ?2 ${scopeCondition}`,
          )
          .bind(from, to, ...scopeParams)
          .first<SumRow>(),
        database
          .prepare(
            `SELECT COALESCE(SUM(original_amount_cents - paid_amount_cents), 0) AS cents FROM accounts_payable
             WHERE status IN ('open','scheduled','partially_paid') AND due_date >= ?1 AND due_date <= ?2 ${scopeCondition}`,
          )
          .bind(from, to, ...scopeParams)
          .first<SumRow>(),
        database
          .prepare(
            `SELECT COALESCE(cc.id, '') AS costCenterId,
                    COALESCE(cc.name, NULLIF(ap.cost_center, ''), 'SEM CENTRO DE CUSTO') AS costCenterName,
                    COALESCE(SUM(ap.original_amount_cents), 0) AS totalCents
             FROM accounts_payable ap
             LEFT JOIN finance_cost_centers cc ON cc.id = ap.cost_center_id
             WHERE ap.status <> 'canceled' AND ap.due_date >= ?1 AND ap.due_date <= ?2 ${
               effectiveCompanyId ? "AND ap.company_id=?3" : ""
             }
             GROUP BY COALESCE(cc.id, ''), COALESCE(cc.name, NULLIF(ap.cost_center, ''), 'SEM CENTRO DE CUSTO')
             ORDER BY totalCents DESC`,
          )
          .bind(from, to, ...scopeParams)
          .all<CostCenterRow>(),
        database
          .prepare(
            `SELECT id, description, company_id AS companyId, company_name AS companyName, supplier_id AS supplierId,
                    due_date AS dueDate, original_amount_cents AS originalAmountCents, paid_amount_cents AS paidAmountCents,
                    ${displayStatusCaseSql(1)} AS displayStatus
             FROM accounts_payable
             WHERE status NOT IN ('paid','canceled') ${effectiveCompanyId ? "AND company_id=?2" : ""}
             ORDER BY due_date ASC, id ASC
             LIMIT 10`,
          )
          .bind(today, ...scopeParams)
          .all<UpcomingPayableRow>(),
        buildPayablesQuickViews(database, effectiveCompanyId, today),
        buildOpenSuppliers(database, effectiveCompanyId),
        sumDreAcrossMonths(database, effectiveCompanyId, months),
        effectiveCompanyId ? Promise.resolve<ByStoreRow[]>([]) : sumByStoreAcrossMonths(database, months),
      ]);

    return jsonResponse({
      period,
      date: referenceDate,
      from,
      to,
      month: period === "year" ? null : months[0],
      monthFrom: period === "year" ? months[0] : null,
      monthTo: period === "year" ? months[months.length - 1] : null,
      companyId: effectiveCompanyId,
      allStores,
      payablesQuickViews: {
        today: quickViews.today,
        week: quickViews.week,
        month: quickViews.month,
        overdue: quickViews.overdue,
      },
      expenses: {
        realizedCents: Number(realizedRow?.cents ?? 0),
        projectedCents: Number(projectedRow?.cents ?? 0),
      },
      revenue: dre,
      byStore: effectiveCompanyId
        ? [
            {
              storeId: effectiveCompanyId,
              storeName: "",
              revenueCents: dre.revenueCents,
              expenseTotalCents: dre.expenseTotalCents,
              resultCents: dre.resultCents,
              marginBasisPoints: dre.marginBasisPoints,
            },
          ]
        : byStore,
      byCategory: dre.categories,
      byCostCenter: costCentersResult.results ?? [],
      topSuppliers: openSuppliers.slice(0, 10),
      upcomingPayments: upcomingResult.results ?? [],
    });
  } catch (error) {
    console.error("Não foi possível montar o dashboard financeiro.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MONTAR O DASHBOARD FINANCEIRO." }, 500);
  }
}
