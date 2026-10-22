import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canSeeAllStores } from "../../../../lib/access-scope";
import { identity, jsonResponse, loadCompanyList, safeText, sameOrigin, type JsonMap } from "../../shared";
import { runBatchCreate } from "../../batch-create";
import { canViewInvoices } from "../shared";
import { planInvoiceCreate } from "../create";

// CADASTRAR EM LOTE de Notas Fiscais manuais: cada linha pela mesma validação
// do cadastro individual (planInvoiceCreate — número/série/chave repetidos,
// competência, valor); tudo ou nada. As duplicatas seguem pelo detalhe da NF.
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  const financeCan = canViewInvoices(actor) &&
    (actor.role === "admin" || actor.permissions.includes("finance:manage") || actor.permissions.includes("payables:invoices_reconcile"));
  if (!financeCan) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR NOTAS FISCAIS." }, 403);
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
    const seen = new Set<string>();
    return await runBatchCreate(database, body, async (row) => {
      const companyId = safeText(row.companyId, 80);
      if (companyId && !companies.some((company) => company.id === companyId)) return { error: "LOJA NÃO ENCONTRADA." };
      // Mesma NF duas vezes no lote: o banco recusaria o lote inteiro.
      const key = [companyId, safeText(row.supplierId, 80), safeText(row.invoiceNumber, 60), safeText(row.series, 20)].join("|");
      if (seen.has(key)) return { error: "NOTA REPETIDA NESTE LOTE." };
      seen.add(key);
      const plan = await planInvoiceCreate(database, actor, scopeActor, allStores, false, {
        ...row,
        purchaseOrderId: "",
        companyName: companies.find((company) => company.id === companyId)?.name ?? "",
      });
      if ("reply" in plan) return { error: String(plan.reply.payload.error || "LINHA INVÁLIDA.") };
      return { statements: plan.statements };
    });
  } catch (error) {
    console.error("Não foi possível cadastrar as notas em lote.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR AS NOTAS EM LOTE." }, 500);
  }
}
