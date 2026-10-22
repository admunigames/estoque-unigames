import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores } from "../../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, loadCompanyList, safeText, sameOrigin, type JsonMap } from "../../shared";
import { runBatchCreate } from "../../batch-create";
import { planSupplierDebtCreate } from "../create";

// CADASTRAR EM LOTE de dívidas de fornecedores: cada linha pela mesma
// validação do cadastro individual (planSupplierDebtCreate); tudo ou nada.
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR DÍVIDAS DE FORNECEDORES." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scopeActor = {
    role: actor.role,
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: actor.permissions,
  };
  const allStores = canSeeAllStores(scopeActor, "finance:manage");
  try {
    const body = (await request.json()) as JsonMap;
    const database = await getD1();
    const companies = await loadCompanyList(database);
    return await runBatchCreate(database, body, async (row, line, batchKey) => {
      const companyId = safeText(row.companyId, 80);
      if (companyId && !companies.some((company) => company.id === companyId)) return { error: "LOJA NÃO ENCONTRADA." };
      const plan = await planSupplierDebtCreate(database, actor, scopeActor, allStores, {
        ...row,
        companyName: companies.find((company) => company.id === companyId)?.name ?? "",
        idempotencyKey: `supplier-debts-batch:${batchKey}:${line}`,
      });
      if ("reply" in plan) {
        return { error: String(plan.reply.payload.error || (plan.reply.payload.alreadyProcessed ? "LINHA JÁ CADASTRADA." : "LINHA INVÁLIDA.")) };
      }
      return { statements: plan.statements };
    });
  } catch (error) {
    console.error("Não foi possível cadastrar as dívidas em lote.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR AS DÍVIDAS EM LOTE." }, 500);
  }
}
