import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageFinance, identity, jsonResponse, loadCompanyList, safeText, sameOrigin, type JsonMap } from "../../shared";
import { runBatchCreate } from "../../batch-create";
import { insertRechargeLineSql, validateRechargeLine } from "../shared";

// CADASTRAR EM LOTE de linhas de recarga: cada linha pela mesma validação do
// cadastro individual (validateRechargeLine); número repetido no lote ou já
// cadastrado é apontado na linha; tudo ou nada.
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR RECARGAS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const database = await getD1();
    const companies = await loadCompanyList(database);
    const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");
    const existing = new Set(
      ((await database.prepare("SELECT phone_number AS phoneNumber FROM finance_phone_recharges").all<{ phoneNumber: string }>()).results ?? [])
        .map((row) => digits(row.phoneNumber)),
    );
    return await runBatchCreate(database, body, async (row) => {
      const companyId = safeText(row.companyId, 80);
      if (companyId && !companies.some((company) => company.id === companyId)) return { error: "UNIDADE NÃO ENCONTRADA." };
      const validated = validateRechargeLine({ ...row, companyName: companies.find((company) => company.id === companyId)?.name ?? "" });
      if ("error" in validated) return validated;
      const phone = digits(validated.input.phoneNumber);
      if (existing.has(phone)) return { error: "ESSE NÚMERO JÁ ESTÁ CADASTRADO (OU REPETIDO NO LOTE)." };
      existing.add(phone);
      return { statements: [insertRechargeLineSql(crypto.randomUUID(), validated.input, actor)] };
    });
  } catch (error) {
    console.error("Não foi possível cadastrar as recargas em lote.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR AS RECARGAS EM LOTE." }, 500);
  }
}
