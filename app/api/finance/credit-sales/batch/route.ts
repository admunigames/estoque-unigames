import { getD1 } from "../../../../../db";
import { jsonResponse, loadCompanyList, safeText, type JsonMap } from "../../shared";
import { runStatements, type Statement } from "../../card-fees/shared";
import { creditScope, loadProviders, loadTakenProposals, planCreditSale } from "../shared";

// CADASTRAR EM LOTE (Crediários, Financeiro 7/9): { companyId, providerId,
// rows[] } — unidade/financeira do cabeçalho valem para a linha que não
// trouxer a sua. Tudo numa transação; devolve criadas e puladas (proposta
// repetida, campo faltando) com o motivo.

export async function POST(request: Request) {
  const scope = creditScope(request, true);
  if (scope instanceof Response) return scope;
  try {
    const body = (await request.json()) as JsonMap;
    const rows = (Array.isArray(body.rows) ? body.rows : []).filter((row): row is JsonMap => Boolean(row) && typeof row === "object");
    if (!rows.length) return jsonResponse({ error: "PREENCHA AO MENOS UMA LINHA." }, 400);
    if (rows.length > 300) return jsonResponse({ error: "LOTE GRANDE DEMAIS (MÁX. 300 LINHAS)." }, 400);
    const header = { companyId: safeText(body.companyId, 80), providerId: safeText(body.providerId, 80) };

    const database = await getD1();
    const [companies, providers] = await Promise.all([loadCompanyList(database), loadProviders(database, scope)]);
    const taken = await loadTakenProposals(database, providers.map((row) => row.id));
    const ctx = { scope, companies, providers: new Map(providers.map((row) => [row.id, row])), taken };

    const statements: Statement[] = [];
    const skipped: Array<{ line: number; proposal: string; reason: string }> = [];
    rows.forEach((row, index) => {
      const plan = planCreditSale(ctx, {
        ...row,
        companyId: safeText(row.companyId, 80) || header.companyId,
        providerId: safeText(row.providerId, 80) || header.providerId,
      });
      if ("error" in plan) skipped.push({ line: index + 1, proposal: safeText(row.proposal, 60), reason: plan.error });
      else statements.push(plan.statement);
    });
    await runStatements(database, statements);
    return jsonResponse({ created: statements.length, skipped }, statements.length ? 201 : 200);
  } catch (error) {
    console.error("Não foi possível cadastrar os crediários em lote.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR OS CREDIÁRIOS EM LOTE." }, 500);
  }
}
