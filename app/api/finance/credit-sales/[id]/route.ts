import { getD1 } from "../../../../../db";
import { jsonResponse, loadCompanyList, type JsonMap } from "../../shared";
import { runStatements } from "../../card-fees/shared";
import { creditScope, inScope, loadCreditSalesByIds, loadProviders, loadTakenProposals, planCreditSale } from "../shared";

// EDITAR um crediário já lançado (09/11/2026) — mesma conferência do NOVO
// CREDIÁRIO. Já recebido (extrato ou manual): só muda o que não mexe no
// dinheiro (login, ID da venda, proposta, observação, data prevista).

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const scope = creditScope(request, true);
  if (scope instanceof Response) return scope;
  const { id } = await context.params;
  try {
    const database = await getD1();
    const [existing] = await loadCreditSalesByIds(database, [id]);
    if (!existing || !inScope(scope, existing.companyId)) return jsonResponse({ error: "CREDIÁRIO NÃO ENCONTRADO." }, 404);
    const body = (await request.json()) as JsonMap;
    const providerId = String(body.providerId ?? "");
    const [companies, providers, taken] = await Promise.all([
      loadCompanyList(database),
      loadProviders(database, scope),
      loadTakenProposals(database, providerId ? [providerId] : []),
    ]);
    const plan = planCreditSale({ scope, companies, providers: new Map(providers.map((row) => [row.id, row])), taken }, body, existing);
    if ("error" in plan) return jsonResponse({ error: plan.error }, plan.status);
    if (existing.bankEntryId || existing.receivedDate) {
      const [, values] = plan.statement as [string, unknown[]];
      const [, companyId, , nextProvider, , saleDate, , , , gross, feeBps, , net] = values;
      const moneyChanged =
        companyId !== existing.companyId || nextProvider !== existing.providerId || saleDate !== existing.saleDate ||
        gross !== existing.grossCents || feeBps !== existing.feeBps || net !== existing.netCents;
      if (moneyChanged) {
        return jsonResponse({ error: "CREDIÁRIO JÁ RECEBIDO: SÓ DÁ PARA MUDAR LOGIN, ID DA VENDA, PROPOSTA E OBSERVAÇÃO. VOLTE PARA PENDENTE PARA ALTERAR VALOR, DATA, UNIDADE OU FINANCEIRA." }, 409);
      }
    }
    await runStatements(database, [plan.statement]);
    return jsonResponse({ updated: true, id });
  } catch (error) {
    console.error("Não foi possível editar o crediário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR O CREDIÁRIO." }, 500);
  }
}
