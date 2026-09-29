import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { MONTH_PATTERN } from "../../../lib/commercial";
import { todayInTimezone } from "../../../lib/finance-status";
import {
  NO_COMPANY_ERROR,
} from "../../../lib/access-scope";
import {
  canManageCommercial,
  canViewCommercial,
  commercialScope,
  identity,
  jsonResponse,
  loadSellers,
  safeText,
} from "../shared";

// Dashboard + Comissão: vendedores do mês com meta, realizado (Loja/Online)
// e as métricas já calculadas (percentual, alvo seguinte, média diária
// necessária e comissão estimada).
//
// Quem vê o quê (decisão confirmada com o usuário):
//   - conta vinculada a um vendedor (RH > Funcionários > Conta de acesso)
//     → SÓ o próprio vendedor (ownOnly), independente da loja/permissão;
//   - conta sem vínculo (gestor/admin/diretoria) → escopo por loja de
//     sempre (commercialScope): a própria loja, ou todas.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewCommercial(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O COMERCIAL." }, 403);
  }
  const scope = commercialScope(actor);
  if (!scope) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  const requested = safeText(new URL(request.url).searchParams.get("month"), 7);
  const month = MONTH_PATTERN.test(requested) ? requested : todayInTimezone().slice(0, 7);

  try {
    const database = await getD1();
    const { sellers, clock } = await loadSellers(database, month);
    const own = actor.id ? sellers.filter((seller) => seller.userId === actor.id) : [];
    const ownOnly = own.length > 0;
    const visible = ownOnly
      ? own
      : scope.allStores ? sellers : sellers.filter((seller) => seller.companyId === scope.companyId);
    return jsonResponse({
      month,
      clock,
      ownOnly,
      allStores: !ownOnly && scope.allStores,
      companyId: scope.companyId,
      canManage: canManageCommercial(actor),
      // userId é só interno (undefined some do JSON).
      sellers: visible.map((seller) => ({ ...seller, userId: undefined })),
    });
  } catch (error) {
    console.error("Não foi possível carregar o Comercial.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS DADOS DO COMERCIAL." }, 500);
  }
}
