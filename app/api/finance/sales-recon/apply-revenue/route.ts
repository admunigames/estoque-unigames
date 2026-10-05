import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, MONTH_PATTERN, safeText, sameOrigin, type JsonMap } from "../../shared";
import { runStatements, scopeActorOf } from "../../card-fees/shared";
import { planRevenueUpsert } from "../../revenue/shared";
import { buildRevenuePlan } from "../shared";

// ATUALIZAR FATURAMENTO DO MÊS (Financeiro 6/9): grava em
// finance_store_revenue, numa transação, as VENDAS e SERVIÇOS conciliados de
// cada unidade que tem vendas no mês (a mesma gravação do lançamento manual:
// amount = vendas + serviços; updated_by/updated_at = quem aplicou e quando).
// Unidade sem vendas no Ponttie não é tocada. Login com loja só aplica a
// própria loja; a ASSISTÊNCIA só quem vê todas as lojas.

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR O FATURAMENTO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = scopeActorOf(request, actor);
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  try {
    const body = (await request.json()) as JsonMap;
    const month = safeText(body.month, 7);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
    const database = await getD1();
    const units = (await buildRevenuePlan(database, month, allStores ? "" : scopeActor.companyId)).filter((unit) => unit.companyId);
    if (!units.length) return jsonResponse({ error: "NÃO HÁ VENDAS DO PONTTIE NESSE MÊS." }, 400);
    const who = { id: actor.id, name: actor.displayName || "Administrador" };
    await runStatements(
      database,
      units.map((unit) =>
        planRevenueUpsert(unit.revenueId, { storeId: unit.companyId, month, salesCents: unit.salesCents, servicesCents: unit.servicesCents }, who),
      ),
    );
    return jsonResponse({
      applied: units.length,
      units: units.map((unit) => ({ companyId: unit.companyId, salesCents: unit.salesCents, servicesCents: unit.servicesCents })),
    });
  } catch (error) {
    console.error("Não foi possível atualizar o faturamento do mês.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR O FATURAMENTO DO MÊS." }, 500);
  }
}
