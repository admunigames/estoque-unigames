import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { todayInTimezone } from "../../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, MONTH_PATTERN, safeText } from "../../shared";
import { loadEffectiveCashFlowSettings } from "../../cash-flow-settings/shared";

type TotalsRow = { expectedCents: number; receivedCents: number; pendingCents: number; count: number };
type GroupRow = TotalsRow & { key: string; label: string };
type DivergentRow = {
  id: string;
  companyId: string;
  companyName: string;
  operatorText: string;
  competenceMonth: string;
  expectedDate: string;
  expectedAmountCents: number;
  receivedAmountCents: number;
  receivedDate: string;
  differenceCents: number;
};

/** Mês anterior a `AAAA-MM`. */
function previousMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 2, 1));
  return date.toISOString().slice(0, 7);
}

// Comparativos da tela de Recebíveis: Previsto x Recebido do mês, mês atual x
// anterior, por unidade, por operadora e a lista de divergências acima da
// tolerância configurada. Tudo agregado no banco — nenhuma lista completa
// sobe pra memória.
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

  const params = new URL(request.url).searchParams;
  const requestedCompanyId = safeText(params.get("companyId"), 80);
  if (!allStores && requestedCompanyId && requestedCompanyId !== scopeActor.companyId) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
  }
  const companyId = allStores ? requestedCompanyId : scopeActor.companyId;

  const today = todayInTimezone();
  const month = safeText(params.get("month"), 7) || today.slice(0, 7);
  if (!MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }
  const priorMonth = previousMonth(month);

  // Cancelados nunca entram em nenhum comparativo.
  const companyCondition = companyId ? "AND company_id = ?2" : "";
  const companyParams: unknown[] = companyId ? [companyId] : [];

  const TOTALS = `COUNT(*) AS count,
    COALESCE(SUM(expected_amount_cents), 0) AS expectedCents,
    COALESCE(SUM(COALESCE(received_amount_cents, 0)), 0) AS receivedCents,
    COALESCE(SUM(CASE WHEN received_amount_cents IS NULL THEN expected_amount_cents ELSE 0 END), 0) AS pendingCents`;

  try {
    const database = await getD1();
    const settings = await loadEffectiveCashFlowSettings(database, companyId);

    const [currentMonth, previous, byStore, byOperator, divergences] = await Promise.all([
      database
        .prepare(
          `SELECT ${TOTALS} FROM accounts_receivable
           WHERE canceled = 0 AND competence_month = ?1 ${companyCondition}`,
        )
        .bind(month, ...companyParams)
        .first<TotalsRow>(),
      database
        .prepare(
          `SELECT ${TOTALS} FROM accounts_receivable
           WHERE canceled = 0 AND competence_month = ?1 ${companyCondition}`,
        )
        .bind(priorMonth, ...companyParams)
        .first<TotalsRow>(),
      database
        .prepare(
          `SELECT company_id AS key, MAX(company_name) AS label, ${TOTALS}
           FROM accounts_receivable
           WHERE canceled = 0 AND competence_month = ?1 ${companyCondition}
           GROUP BY company_id
           ORDER BY expectedCents DESC`,
        )
        .bind(month, ...companyParams)
        .all<GroupRow>(),
      database
        .prepare(
          `SELECT operator_text AS key, operator_text AS label, ${TOTALS}
           FROM accounts_receivable
           WHERE canceled = 0 AND competence_month = ?1 ${companyCondition}
           GROUP BY operator_text
           ORDER BY expectedCents DESC`,
        )
        .bind(month, ...companyParams)
        .all<GroupRow>(),
      // Divergências acima da tolerância (percentual OU valor fixo, o que for
      // atingido primeiro) — mesma regra de isReceivableDivergent, escrita em
      // SQL pra não trazer a lista inteira pra JS.
      database
        .prepare(
          `SELECT id, company_id AS companyId, company_name AS companyName, operator_text AS operatorText,
                  competence_month AS competenceMonth, expected_date AS expectedDate,
                  expected_amount_cents AS expectedAmountCents, received_amount_cents AS receivedAmountCents,
                  received_date AS receivedDate,
                  received_amount_cents - expected_amount_cents AS differenceCents
           FROM accounts_receivable
           WHERE canceled = 0 AND competence_month = ?1 ${companyId ? "AND company_id = ?4" : ""}
             AND received_amount_cents IS NOT NULL
             AND (ABS(received_amount_cents - expected_amount_cents) > ?2::numeric
                  OR ABS(received_amount_cents - expected_amount_cents)
                     > ABS(expected_amount_cents) * (?3::numeric / 10000))
           ORDER BY ABS(received_amount_cents - expected_amount_cents) DESC
           LIMIT 100`,
        )
        .bind(
          month,
          settings.receivablesToleranceFixedCents,
          settings.receivablesToleranceBps,
          ...(companyId ? [companyId] : []),
        )
        .all<DivergentRow>(),
    ]);

    function normalize(row: TotalsRow | null): TotalsRow {
      return {
        count: Number(row?.count ?? 0),
        expectedCents: Number(row?.expectedCents ?? 0),
        receivedCents: Number(row?.receivedCents ?? 0),
        pendingCents: Number(row?.pendingCents ?? 0),
      };
    }

    const current = normalize(currentMonth);
    const prior = normalize(previous);

    return jsonResponse({
      month,
      previousMonth: priorMonth,
      companyId,
      settings,
      today,
      current: { ...current, differenceCents: current.receivedCents - (current.expectedCents - current.pendingCents) },
      previous: { ...prior, differenceCents: prior.receivedCents - (prior.expectedCents - prior.pendingCents) },
      byStore: byStore.results ?? [],
      byOperator: byOperator.results ?? [],
      divergences: divergences.results ?? [],
    });
  } catch (error) {
    console.error("Não foi possível carregar o resumo dos recebíveis.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O RESUMO DOS RECEBÍVEIS." }, 500);
  }
}
