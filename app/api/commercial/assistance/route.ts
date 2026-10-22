import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { MONTH_PATTERN, isAssistanceHub, monthClock, resolveCommercialRules } from "../../../lib/commercial";
import { todayInTimezone } from "../../../lib/finance-status";
import {
  canViewCommercialAssist,
  commercialScope,
  identity,
  jsonResponse,
  loadCompanyNames,
  loadRules,
  previousMonth,
  safeText,
} from "../shared";

// Aba META ASSISTÊNCIA (comercial:assist_view): SÓ O PAINEL comparativo da
// assistência (desde 2026-10-22 a META e o FEITO DA ASSISTÊNCIA são lançados
// na Meta Loja, ao lado das vendas — rota /stores). Base da comissão do
// OPERACIONAL e do prêmio do LÍDER.
//   GET ?month → lojas do alcance com meta/feito do mês e do mês anterior
//                (comparativo), dias restantes e a % da meta de premiação

type GoalRow = {
  companyId: string; month: string; targetCents: number; revenueCents: number; updatedAt: string; updatedByName: string;
  hubTargetCents: number;
};

function guard(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!canViewCommercialAssist(actor)) {
    return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA A META ASSISTÊNCIA." }, 403) };
  }
  const scope = commercialScope(actor);
  if (!scope) return { error: jsonResponse({ error: NO_COMPANY_ERROR }, 403) };
  return { scope };
}

export async function GET(request: Request) {
  const checked = guard(request);
  if (checked.error) return checked.error;
  const { scope } = checked;
  const today = todayInTimezone();
  const requested = safeText(new URL(request.url).searchParams.get("month"), 7);
  const month = MONTH_PATTERN.test(requested) ? requested : today.slice(0, 7);
  const previous = previousMonth(month);
  try {
    const database = await getD1();
    const [result, companyNames, allRules] = await Promise.all([
      database
        .prepare(
          `SELECT company_id AS companyId, month, assist_target_cents AS targetCents, assist_revenue_cents AS revenueCents,
                  target_cents AS hubTargetCents,
                  assist_updated_at AS updatedAt, assist_updated_by_name AS updatedByName
           FROM commercial_store_goals WHERE month IN (?1, ?2)`,
        )
        .bind(month, previous)
        .all<GoalRow>(),
      loadCompanyNames(database),
      loadRules(database),
    ]);
    const key = (row: { month: string; companyId: string }) => `${row.month}|${row.companyId}`;
    const goals = new Map((result.results ?? []).map((row) => [key(row), row]));
    // Meta da assistência da rede = a da linha ASSISTÊNCIA da Meta Loja
    // (cadastrada à parte); o feito é sempre a soma das lojas. 0 = soma das metas.
    const hubs = [...companyNames.entries()].filter(([, name]) => isAssistanceHub(name)).map(([companyId]) => companyId);
    const hubTarget = (when: string) => scope.allStores
      ? hubs.reduce((sum, companyId) => sum + (Number(goals.get(key({ month: when, companyId }))?.hubTargetCents) || 0), 0)
      : 0;
    const rows = [...companyNames.entries()]
      .filter(([companyId]) => !hubs.includes(companyId) && (scope.allStores || companyId === scope.companyId))
      .map(([companyId, name]) => {
        const current = goals.get(key({ month, companyId }));
        const before = goals.get(key({ month: previous, companyId }));
        return {
          companyId,
          name,
          targetCents: Number(current?.targetCents) || 0,
          revenueCents: Number(current?.revenueCents) || 0,
          previousTargetCents: Number(before?.targetCents) || 0,
          previousRevenueCents: Number(before?.revenueCents) || 0,
          updatedAt: current?.updatedAt || "",
          updatedByName: current?.updatedByName || "",
        };
      });
    const roles = resolveCommercialRules(allRules, month).roles;
    return jsonResponse({
      month,
      previousMonth: previous,
      clock: monthClock(month, today),
      // Meta de premiação (120%) da vigência do mês; sem regras de operacional, 120.
      premiumPercent: roles ? roles.operational.premiumPercent : 120,
      companyTargetCents: hubTarget(month),
      previousCompanyTargetCents: hubTarget(previous),
      rows,
    });
  } catch (error) {
    console.error("Não foi possível carregar a meta da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A META DA ASSISTÊNCIA." }, 500);
  }
}
