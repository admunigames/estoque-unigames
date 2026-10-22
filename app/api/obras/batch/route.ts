import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { runBatchCreate } from "../../finance/batch-create";
import { canManageWorks, identity, jsonResponse, sameOrigin } from "../shared";
import { insertObraSql, validateObra } from "../create";

// CADASTRAR EM LOTE de obras: cada linha pela mesma validação do cadastro
// individual (validateObra); tudo ou nada.
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageWorks(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA GERENCIAR OBRAS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const database = await getD1();
    return await runBatchCreate(database, body, async (row) => {
      const validated = await validateObra(database, row);
      if ("error" in validated) return validated;
      return { statements: [insertObraSql(crypto.randomUUID(), validated.input, actor)] };
    });
  } catch (error) {
    console.error("Não foi possível cadastrar as obras em lote.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR AS OBRAS EM LOTE." }, 500);
  }
}
