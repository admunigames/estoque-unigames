import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { MONTH_PATTERN } from "../../../lib/commercial";
import { todayInTimezone } from "../../../lib/finance-status";
import {
  NO_COMPANY_ERROR,
} from "../../../lib/access-scope";
import {
  canManageCommercialCredit,
  canManageCommercialGoals,
  canManageCommercialRules,
  canViewCommercialCredit,
  canViewCommercialGoals,
  canMarkCommercialNewcomer,
  canViewCommercialCommission,
  canViewCommercialDashboard,
  commercialScope,
  identity,
  jsonResponse,
  linkedEmployeeIds,
  loadStoreGoals,
  loadSellers,
  safeText,
  withoutInactive,
} from "../shared";

// Dashboard + Comissão: vendedores do mês (importados da planilha) com meta,
// realizado e as métricas já calculadas (percentual, alvo seguinte, média diária
// necessária e comissão estimada).
//
// Quem vê o quê (decisão confirmada com o usuário):
//   - conta vinculada a um vendedor (RH > Funcionários > Conta de acesso)
//     → SÓ o próprio vendedor (ownOnly), independente da loja/permissão;
//   - conta sem vínculo (gestor/admin/diretoria) → escopo por loja de
//     sempre (commercialScope): a própria loja, ou todas.
// `?for=cadastro` (abas de atualização Vendedores e Crediários —
// comercial:goals ou comercial:credit) ignora o "só o próprio": quem lança
// precisa ver os vendedores da loja.
// Sem comercial:commission, os valores em R$ da comissão são REMOVIDOS da
// resposta (não basta esconder no front); ficam só allCriteriaMet,
// revenueRateBps e newcomer, usados pelo selo do Dashboard — que é igual
// para todos. `rules` = regra vigente do mês (textos das regras no front).
// NOVATO é escondido da conta vinculada a um vendedor (ownOnly): a resposta
// sai com newcomer=false (os valores em R$ continuam os reais), e essa conta
// nunca pode marcar novatos (canMarkNewcomer=false; a rota também recusa).
// Vendedor INATIVO no RH some por padrão (Dashboard); ?inactive=1 (aba
// Comissão e "MOSTRAR INATIVOS" do Dashboard) e ?for=cadastro trazem com
// inactive=true. A conta vinculada continua vendo o próprio histórico.
// LÍDER vem em sellers (role='lider', premiação de líder na comissão).
// OPERACIONAIS vêm à parte (`operationals`), com o mesmo escopo; sem
// comercial:commission saem só os % e a faixa (nenhum R$). `tracking` =
// meta e feito (R$) da loja e da assistência de cada loja que tem operacional
// ou líder visível — o acompanhamento e a meta 120% do Dashboard deles.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  const url = new URL(request.url);
  const requested = safeText(url.searchParams.get("month"), 7);
  const forCadastro = url.searchParams.get("for") === "cadastro";
  const includeInactive = forCadastro || url.searchParams.get("inactive") === "1";
  const canDashboard = canViewCommercialDashboard(actor);
  const canCommission = canViewCommercialCommission(actor);
  const canGoals = canManageCommercialGoals(actor);
  if (forCadastro) {
    if (!canViewCommercialGoals(actor) && !canViewCommercialCredit(actor)) {
      return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ATUALIZAR OS VENDEDORES." }, 403);
    }
  } else if (!canDashboard && !canCommission) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O COMERCIAL." }, 403);
  }
  const scope = commercialScope(actor);
  if (!scope) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  const month = MONTH_PATTERN.test(requested) ? requested : todayInTimezone().slice(0, 7);

  try {
    const database = await getD1();
    const [{ sellers: monthSellers, tabOperationals, operationals, clock, rules }, linked] = await Promise.all([
      loadSellers(database, month),
      forCadastro ? Promise.resolve([] as string[]) : linkedEmployeeIds(database, actor.id),
    ]);
    // A aba Vendedores mostra também quem foi trocado para OPERACIONAL.
    const sellers = forCadastro ? [...monthSellers, ...tabOperationals] : monthSellers;
    // Conta vinculada a um vendedor: só ele, mesmo que o mês ainda não
    // tenha sido importado (a tela mostra "ainda não importado").
    const ownOnly = linked.length > 0;
    const scoped = ownOnly
      ? sellers
        .filter((seller) => linked.includes(seller.employeeId))
        .map((seller) => ({
          ...seller,
          newcomer: false,
          metrics: { ...seller.metrics, commission: { ...seller.metrics.commission, newcomer: false } },
        }))
      : scope.allStores ? sellers : sellers.filter((seller) => seller.companyId === scope.companyId);
    const shown = ownOnly ? scoped : withoutInactive(scoped, includeInactive);
    const visible = canCommission
      ? shown
      : shown.map((seller) => {
        // Dashboard igual para todos: fica só o que o selo usa (critérios
        // batidos e taxa); os valores em R$ são exclusivos da aba Comissão.
        // digital: selo LOJA DIGITAL (sem R$).
        const { allCriteriaMet, revenueRateBps, newcomer, digital } = seller.metrics.commission;
        return { ...seller, metrics: { ...seller.metrics, commission: { allCriteriaMet, revenueRateBps, newcomer, digital } } };
      });
    const scopedOperationals = operationals.filter((person) =>
      ownOnly ? linked.includes(person.employeeId) : scope.allStores || person.companyId === scope.companyId);
    const visibleOperationals = canCommission
      ? scopedOperationals
      : scopedOperationals.map((person) => {
        const { assistPercent, storePercent, rateBps, premiumPercent } = person.commission;
        return { ...person, commission: { assistPercent, storePercent, rateBps, premiumPercent } };
      });
    // Acompanhamento das lojas dos operacionais e líderes que aparecem aqui.
    const trackedStores = new Map<string, string>();
    for (const person of scopedOperationals) trackedStores.set(person.companyId, person.companyName);
    for (const seller of shown) if (seller.role === "lider") trackedStores.set(seller.companyId, seller.companyName);
    const storeGoals = !forCadastro && trackedStores.size ? await loadStoreGoals(database, month) : new Map();
    const tracking = forCadastro ? [] : [...trackedStores.entries()].map(([companyId, name]) => {
      const goal = storeGoals.get(companyId);
      return {
        companyId, name,
        targetCents: goal?.targetCents ?? 0, revenueCents: goal?.revenueCents ?? 0,
        assistTargetCents: goal?.assistTargetCents ?? 0, assistRevenueCents: goal?.assistRevenueCents ?? 0,
      };
    });
    return jsonResponse({
      month,
      clock,
      tracking,
      ownOnly,
      includeInactive,
      allStores: !ownOnly && scope.allStores,
      companyId: scope.companyId,
      canDashboard,
      canCommission,
      canGoals,
      canCredit: canManageCommercialCredit(actor),
      canRules: canManageCommercialRules(actor),
      canMarkNewcomer: !ownOnly && canMarkCommercialNewcomer(actor),
      rules,
      sellers: visible,
      operationals: forCadastro ? [] : visibleOperationals,
    });
  } catch (error) {
    console.error("Não foi possível carregar o Comercial.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS DADOS DO COMERCIAL." }, 500);
  }
}
