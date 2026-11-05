import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { MONTH_PATTERN, isAssistanceHub, progressPercent } from "../../../lib/commercial";
import { todayInTimezone } from "../../../lib/finance-status";
import {
  canViewCommercialMetas,
  commercialScope,
  identity,
  jsonResponse,
  loadCompanyNames,
  loadSellers,
  loadStoreGoals,
  safeText,
} from "../shared";

// Aba METAS (comercial:metas, pedido de 2026-11-05): visão geral SÓ LEITURA
// da meta e do feito em R$ do mês — lojas (total da loja = vendas +
// assistência, como no ranking; a linha ASSISTÊNCIA fica de fora, igual ao
// total da rede) e vendedores (meta e faturado da aba Meta Vendedores).
// Login com loja vê só a própria loja e os vendedores dela.
//   GET ?month → { month, allStores, stores, total, sellers }

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewCommercialMetas(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER AS METAS." }, 403);
  }
  const scope = commercialScope(actor);
  if (!scope) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  const requested = safeText(new URL(request.url).searchParams.get("month"), 7);
  const month = MONTH_PATTERN.test(requested) ? requested : todayInTimezone().slice(0, 7);
  try {
    const database = await getD1();
    const [goals, companyNames, { sellers }] = await Promise.all([
      loadStoreGoals(database, month),
      loadCompanyNames(database),
      loadSellers(database, month),
    ]);
    const inScope = (companyId: string) => scope.allStores || companyId === scope.companyId;
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "pt-BR");
    const stores = [...goals.entries()]
      .filter(([companyId, goal]) => inScope(companyId) && !isAssistanceHub(companyNames.get(companyId) || "") && (goal.targetCents > 0 || goal.revenueCents > 0))
      .map(([companyId, goal]) => ({
        companyId,
        name: companyNames.get(companyId) || companyId,
        targetCents: goal.targetCents,
        revenueCents: goal.revenueCents,
        percent: progressPercent(goal.revenueCents, goal.targetCents),
      }))
      .sort(byName);
    const sum = (key: "targetCents" | "revenueCents") => stores.reduce((acc, row) => acc + row[key], 0);
    return jsonResponse({
      month,
      allStores: scope.allStores,
      stores,
      total: { targetCents: sum("targetCents"), revenueCents: sum("revenueCents"), percent: progressPercent(sum("revenueCents"), sum("targetCents")) },
      sellers: sellers
        .filter((seller) => inScope(seller.companyId) && (seller.goal.targetRevenueCents > 0 || seller.realized.revenueCents > 0))
        .map((seller) => ({
          employeeId: seller.employeeId,
          name: seller.name,
          companyName: seller.companyName,
          role: seller.role,
          inactive: seller.inactive,
          targetCents: seller.goal.targetRevenueCents,
          revenueCents: seller.realized.revenueCents,
          percent: seller.metrics.revenue.percent,
        }))
        .sort((a, b) => (a.companyName || "").localeCompare(b.companyName || "", "pt-BR") || byName(a, b)),
    });
  } catch (error) {
    console.error("Não foi possível carregar as metas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS METAS." }, 500);
  }
}
