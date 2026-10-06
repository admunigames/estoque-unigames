import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { MONTH_PATTERN } from "../../../lib/commercial";
import { todayInTimezone } from "../../../lib/finance-status";
import { canViewCommercialDashboard, identity, jsonResponse, loadSellers, safeText } from "../shared";

// Ranking — SEMPRE a empresa inteira (todas as lojas), para qualquer
// usuário com comercial:dashboard, independente da loja dele. Por vendedor a
// resposta leva SÓ nome, loja e percentual; por loja (`stores`, gráficos
// ITENS/REALMES TOTAIS POR LOJA) só as quantidades somadas e as metas.
// Nenhum valor em R$ e nenhuma comissão sai desta rota.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewCommercialDashboard(actor)) {
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
    // Totais por loja (pedido de 2026-10-06): soma dos vendedores da loja.
    const byStore = new Map<string, { name: string; items: number; targetItems: number; realme: number; targetRealme: number }>();
    for (const seller of sellers) {
      const name = seller.companyName || "SEM LOJA";
      const store = byStore.get(name) ?? { name, items: 0, targetItems: 0, realme: 0, targetRealme: 0 };
      store.items += seller.metrics.items.realized;
      store.targetItems += seller.metrics.items.target;
      store.realme += seller.metrics.realme.realized;
      store.targetRealme += seller.metrics.realme.target;
      byStore.set(name, store);
    }
    return jsonResponse({ month, items, stores: [...byStore.values()] });
  } catch (error) {
    console.error("Não foi possível carregar o ranking do Comercial.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O RANKING." }, 500);
  }
}
