import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { addDays, todayInTimezone } from "../../../../lib/finance-status";
import { MAX_CASH_FLOW_DAYS } from "../../../../lib/cash-flow";
import { canManageFinance, identity, jsonResponse, safeText } from "../../shared";
import { loadEffectiveCashFlowSettings } from "../../cash-flow-settings/shared";
import { cashFlowLastDate, loadCashFlowOutflows, resolveCashFlowScope } from "../shared";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// LISTA DE PAGAMENTOS do Fluxo de Caixa: os MESMOS itens de saída que a
// projeção soma por dia (loadCashFlowOutflows). GET ?from&to&companyId —
// período dentro da janela de 90 dias a partir de hoje (padrão +30 dias);
// `overdue` traz à parte tudo com data anterior a hoje ainda em aberto.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }
  const params = new URL(request.url).searchParams;
  const scope = resolveCashFlowScope(request, safeText(params.get("companyId"), 80));
  if (scope.error) return scope.error;

  const today = todayInTimezone();
  const lastDate = cashFlowLastDate(today, MAX_CASH_FLOW_DAYS);
  const rawFrom = safeText(params.get("from"), 10);
  const rawTo = safeText(params.get("to"), 10);
  const from = DATE_RE.test(rawFrom) && rawFrom > today ? (rawFrom > lastDate ? lastDate : rawFrom) : today;
  let to = DATE_RE.test(rawTo) ? rawTo : addDays(today, 29);
  if (to > lastDate) to = lastDate;
  if (to < from) to = from;

  try {
    const database = await getD1();
    const settings = await loadEffectiveCashFlowSettings(database, scope.companyId);
    const all = await loadCashFlowOutflows(database, {
      companyId: scope.companyId,
      today,
      lastDate,
      payrollDefaultPaymentDay: settings.payrollDefaultPaymentDay,
    });
    return jsonResponse({
      today,
      from,
      to,
      maxDate: lastDate,
      overdue: all.filter((item) => item.date < today),
      items: all.filter((item) => item.date >= from && item.date <= to),
    });
  } catch (error) {
    console.error("Não foi possível carregar a lista de pagamentos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A LISTA DE PAGAMENTOS." }, 500);
  }
}
