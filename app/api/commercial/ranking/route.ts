import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { MONTH_PATTERN } from "../../../lib/commercial";
import { todayInTimezone } from "../../../lib/finance-status";
import { canViewCommercial, identity, jsonResponse, loadSellers, safeText } from "../shared";

// Ranking — SEMPRE a empresa inteira (todas as lojas), para qualquer
// usuário com acesso ao módulo, independente da loja dele. Por isso a
// resposta leva SÓ nome, loja e percentual: nenhum valor em R$, nenhuma
// quantidade e nenhuma comissão sai desta rota.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewCommercial(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O COMERCIAL." }, 403);
  }

  const requested = safeText(new URL(request.url).searchParams.get("month"), 7);
  const month = MONTH_PATTERN.test(requested) ? requested : todayInTimezone().slice(0, 7);

  try {
    const database = await getD1();
    const { sellers } = await loadSellers(database, month);
    const items = sellers.map((seller) => ({
      employeeId: seller.employeeId,
      name: seller.name,
      companyName: seller.companyName,
      zone: seller.zone,
      revenuePercent: seller.metrics.revenue.percent,
      itemsPercent: seller.metrics.items.percent,
      warrantyPercent: seller.metrics.warranty.attachPercent,
      realmePercent: seller.metrics.realme.percent,
    }));
    return jsonResponse({ month, items });
  } catch (error) {
    console.error("Não foi possível carregar o ranking do Comercial.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O RANKING." }, 500);
  }
}
