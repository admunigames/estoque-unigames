import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { runBatchCreate } from "../../batch-create";
import { insertMachineSql, validateMachineInput } from "../create";

// CADASTRAR EM LOTE de maquinetas: cada linha pela mesma validação do
// cadastro individual (validateMachineInput — adquirente da unidade, serial
// único, também entre as linhas do lote); tudo ou nada.
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR MAQUINETAS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  if (!allStores && !hasCompany(scopeActor.companyId)) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const database = await getD1();
    const serials = new Set<string>();
    return await runBatchCreate(database, body, async (row) => {
      const validated = await validateMachineInput(database, scopeActor, allStores, { ...row, id: "" }, "", serials);
      if ("error" in validated) return { error: validated.error };
      return { statements: [insertMachineSql(crypto.randomUUID(), validated.input, actor)] };
    });
  } catch (error) {
    console.error("Não foi possível cadastrar as maquinetas em lote.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR AS MAQUINETAS EM LOTE." }, 500);
  }
}
