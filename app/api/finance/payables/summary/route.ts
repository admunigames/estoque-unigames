import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { todayInTimezone } from "../../../../lib/finance-status";
import { canManageFinance, identity, jsonResponse, safeText } from "../../shared";
import { buildOpenSuppliers, buildPayablesQuickViews } from "./shared";

// Números dos cards de atalho (Hoje/Amanhã/.../Vencidos/Pagos) num único
// GET, já filtrados por loja/permissão — evita 9 requisições separadas do
// front e garante que os atalhos e a listagem usam exatamente a mesma
// definição de intervalo (ver quickViewDueRange, fonte única).
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
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  if (!allStores && companyId && companyId !== scopeActor.companyId) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A ESSA LOJA." }, 403);
  }
  const effectiveCompanyId = allStores ? companyId : scopeActor.companyId;

  const today = todayInTimezone();

  try {
    const database = await getD1();
    const [quickViews, openSuppliers] = await Promise.all([
      buildPayablesQuickViews(database, effectiveCompanyId, today),
      buildOpenSuppliers(database, effectiveCompanyId),
    ]);
    return jsonResponse({ today, quickViews, openSuppliers });
  } catch (error) {
    console.error("Não foi possível carregar o resumo de contas a pagar.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O RESUMO." }, 500);
  }
}
