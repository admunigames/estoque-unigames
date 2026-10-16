import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { MONTH_PATTERN } from "../../../lib/commercial";
import { todayInTimezone } from "../../../lib/finance-status";
import { canViewCommercialRanking, identity, jsonResponse, loadSellers, safeText, withoutInactive } from "../shared";

// Ranking — SEMPRE a empresa inteira (todas as lojas), para qualquer
// usuário com comercial:ranking, independente da loja dele. Por isso a
// resposta leva SÓ nome, loja e percentual: nenhum valor em R$, nenhuma
// quantidade e nenhuma comissão sai desta rota. (Itens/realmes por loja vêm
// da Meta Loja, rota /stores.) Vendedor inativo no RH só com ?inactive=1.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewCommercialRanking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O COMERCIAL." }, 403);
  }

  const url = new URL(request.url);
  const requested = safeText(url.searchParams.get("month"), 7);
  const includeInactive = url.searchParams.get("inactive") === "1";
  const month = MONTH_PATTERN.test(requested) ? requested : todayInTimezone().slice(0, 7);

  try {
    const database = await getD1();
    const { sellers } = await loadSellers(database, month);
    const items = withoutInactive(sellers, includeInactive).map((seller) => ({
      employeeId: seller.employeeId,
      name: seller.name,
      companyName: seller.companyName,
      zone: seller.zone,
      revenuePercent: seller.metrics.revenue.percent,
      itemsPercent: seller.metrics.items.percent,
      warrantyPercent: seller.metrics.warranty.attachPercent,
      realmePercent: seller.metrics.realme.percent,
      inactive: seller.inactive,
    }));
    return jsonResponse({ month, items });
  } catch (error) {
    console.error("Não foi possível carregar o ranking do Comercial.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O RANKING." }, 500);
  }
}
