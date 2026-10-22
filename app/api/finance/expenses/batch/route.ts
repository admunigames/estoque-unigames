import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores } from "../../../../lib/access-scope";
import { canManageFinance, identity, jsonResponse, loadCompanyList, safeText, sameOrigin, type JsonMap } from "../../shared";
import { runBatchCreate } from "../../batch-create";
import { planExpense } from "../shared";

// CADASTRAR EM LOTE de Despesas (avulsas, loja única ou fora do rateio): cada
// linha pelo mesmo planExpense do cadastro individual; tudo ou nada.
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR DESPESAS." }, 403);
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
      const rateioType = safeText(row.rateioType, 20) === "no_rateio" ? "no_rateio" : "single_store";
      const plan = await planExpense(database, actor, { allStores, companyId: scopeActor.companyId }, {
        ...row,
        kind: "single",
        rateioType,
        companyName: companies.find((company) => company.id === companyId)?.name ?? "",
        idempotencyKey: `expenses-batch:${batchKey}:${line}`,
      });
      if ("reply" in plan) {
        return { error: String(plan.reply.payload.error || (plan.reply.payload.alreadyProcessed ? "LINHA JÁ CADASTRADA." : "LINHA INVÁLIDA.")) };
      }
      return { statements: plan.statements };
    });
  } catch (error) {
    console.error("Não foi possível cadastrar as despesas em lote.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR AS DESPESAS EM LOTE." }, 500);
  }
}
