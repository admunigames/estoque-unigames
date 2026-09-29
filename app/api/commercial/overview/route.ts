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
  linkedEmployeeIds,
  loadSellers,
  safeText,
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
// `?for=cadastro` (aba Cadastro de Metas, só comercial:manage) ignora o
// "só o próprio": quem cadastra metas precisa ver os vendedores da loja.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewCommercial(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O COMERCIAL." }, 403);
  }
  const scope = commercialScope(actor);
  if (!scope) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);

  const url = new URL(request.url);
  const requested = safeText(url.searchParams.get("month"), 7);
  const forCadastro = url.searchParams.get("for") === "cadastro";
  if (forCadastro && !canManageCommercial(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR METAS." }, 403);
  }
  const month = MONTH_PATTERN.test(requested) ? requested : todayInTimezone().slice(0, 7);

  try {
    const database = await getD1();
    const [{ sellers, clock }, linked] = await Promise.all([
      loadSellers(database, month),
      forCadastro ? Promise.resolve([] as string[]) : linkedEmployeeIds(database, actor.id),
    ]);
    // Conta vinculada a um vendedor: só ele, mesmo que o mês ainda não
    // tenha sido importado (a tela mostra "ainda não importado").
    const ownOnly = linked.length > 0;
    const visible = ownOnly
      ? sellers.filter((seller) => linked.includes(seller.employeeId))
      : scope.allStores ? sellers : sellers.filter((seller) => seller.companyId === scope.companyId);
    return jsonResponse({
      month,
      clock,
      ownOnly,
      allStores: !ownOnly && scope.allStores,
      companyId: scope.companyId,
      canManage: canManageCommercial(actor),
      sellers: visible,
    });
  } catch (error) {
    console.error("Não foi possível carregar o Comercial.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS DADOS DO COMERCIAL." }, 500);
  }
}
