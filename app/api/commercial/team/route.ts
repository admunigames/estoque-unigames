import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { MONTH_PATTERN } from "../../../lib/commercial";
import { todayInTimezone } from "../../../lib/finance-status";
import {
  canViewCommercialDashboard,
  commercialScope,
  identity,
  jsonResponse,
  linkedEmployeeIds,
  loadCompanyNames,
  loadSellers,
  safeText,
} from "../shared";

// Ranking > META VENDEDORES: meta e feito (faturamento) de cada vendedor DA
// LOJA. Quem vê qual loja (decisão do usuário, 2026-10-06):
//   - conta vinculada a um vendedor → SÓ a loja do próprio vendedor (no RH),
//     com os colegas dela — nenhuma outra loja;
//   - gestor com loja → a própria loja; sem loja (ou admin) → escolhe a loja.
// Só meta e feito: nenhuma comissão sai desta rota.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewCommercialDashboard(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O COMERCIAL." }, 403);
  }
  const url = new URL(request.url);
  const requested = safeText(url.searchParams.get("month"), 7);
  const month = MONTH_PATTERN.test(requested) ? requested : todayInTimezone().slice(0, 7);
  const scope = commercialScope(actor);
  try {
    const database = await getD1();
    const [{ sellers }, linked, companyNames] = await Promise.all([
      loadSellers(database, month),
      linkedEmployeeIds(database, actor.id),
      loadCompanyNames(database),
    ]);
    let allowed: Set<string> | null;
    if (linked.length) {
      const placeholders = linked.map((_, index) => `?${index + 1}`).join(", ");
      const rows = await database
        .prepare(`SELECT company_id AS companyId FROM hr_employees WHERE id IN (${placeholders})`)
        .bind(...linked)
        .all<{ companyId: string }>();
      allowed = new Set((rows.results ?? []).map((row) => row.companyId).filter(Boolean));
    } else if (!scope) {
      return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
    } else {
      allowed = scope.allStores ? null : new Set([scope.companyId]);
    }
    const visible = sellers.filter((seller) => !allowed || allowed.has(seller.companyId));
    const stores = [...new Set(visible.map((seller) => seller.companyId))]
      .map((companyId) => ({ companyId, name: companyNames.get(companyId) || visible.find((s) => s.companyId === companyId)?.companyName || "SEM LOJA" }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    const wanted = safeText(url.searchParams.get("companyId"), 80);
    const companyId = stores.some((store) => store.companyId === wanted) ? wanted : stores[0]?.companyId || "";
    const items = visible
      .filter((seller) => seller.companyId === companyId)
      .map((seller) => ({
        employeeId: seller.employeeId,
        name: seller.name,
        targetRevenueCents: seller.goal.targetRevenueCents,
        revenueCents: seller.realized.revenueCents,
        percent: seller.metrics.revenue.percent,
      }));
    return jsonResponse({ month, stores, companyId, items });
  } catch (error) {
    console.error("Não foi possível carregar a meta dos vendedores.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A META DOS VENDEDORES." }, 500);
  }
}
