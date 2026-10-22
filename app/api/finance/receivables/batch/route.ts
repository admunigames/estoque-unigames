import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { runBatchCreate } from "../../batch-create";
import { planReceivableCreate } from "../create";

// CADASTRAR EM LOTE de recebíveis (Fluxo de Caixa): cada linha pelo mesmo
// planReceivableCreate do cadastro individual; tudo ou nada.
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR RECEBÍVEIS." }, 403);
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
    return await runBatchCreate(database, body, async (row, line, batchKey) => {
      const plan = await planReceivableCreate(database, actor, scopeActor, allStores, {
        ...row,
        idempotencyKey: `receivables-batch:${batchKey}:${line}`,
      });
      if ("reply" in plan) {
        return { error: String(plan.reply.payload.error || (plan.reply.payload.alreadyProcessed ? "LINHA JÁ CADASTRADA." : "LINHA INVÁLIDA.")) };
      }
      return { statements: plan.statements };
    });
  } catch (error) {
    console.error("Não foi possível cadastrar os recebíveis em lote.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR OS RECEBÍVEIS EM LOTE." }, 500);
  }
}
