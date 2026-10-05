import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { todayInTimezone } from "../../../lib/finance-status";
import { summarizeHorizons } from "../../../lib/cash-flow";
import { canManageFinance, identity, jsonResponse, safeText } from "../shared";
import { loadCashFlowProjection, resolveCashFlowScope } from "./shared";

// Fluxo de Caixa (Financeiro Fase 6) — aba PROJEÇÃO DE PAGAMENTOS.
//
// Esta rota é SÓ I/O: a projeção inteira (entradas dos recebíveis, saídas de
// accounts_payable/pagamentos/RH e o Caixa Atual) vem de
// loadCashFlowProjection (./shared.ts) — a mesma fonte da LISTA DE
// PAGAMENTOS (./payments) e do CAIXA SEMANAL (./weekly). Retorna sempre a
// série completa de 90 dias; a UI recorta os horizontes de 7/15/30/60/90.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const scope = resolveCashFlowScope(request, safeText(new URL(request.url).searchParams.get("companyId"), 80));
  if (scope.error) return scope.error;
  const companyId = scope.companyId;
  const today = todayInTimezone();

  try {
    const database = await getD1();
    const { settings, balances, series } = await loadCashFlowProjection(database, companyId, today);
    return jsonResponse({
      companyId,
      today,
      settings,
      caixaAtualCents: balances.caixaAtualCents,
      accountsWithBalance: balances.accountsWithBalance,
      accountsMissingBalance: balances.accountsMissingBalance,
      days: series.days,
      horizons: summarizeHorizons(series),
      // Impostos e taxas de cartão ainda contribuem com 0 (ver
      // saidasImpostosTaxasCents em app/lib/cash-flow.ts).
      taxesAndFeesIncluded: false,
    });
  } catch (error) {
    console.error("Não foi possível carregar o fluxo de caixa.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O FLUXO DE CAIXA." }, 500);
  }
}
