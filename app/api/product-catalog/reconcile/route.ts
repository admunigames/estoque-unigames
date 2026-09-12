import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  canManageProductCatalog,
  identity,
  jsonResponse,
  sameOrigin,
  upsertProductCatalogEntries,
  type JsonMap,
  type ProductCatalogSource,
} from "../shared";

const MAX_ITEMS = 20000;

// Reconciliação a partir do upload de "Base de Produtos" por grupo
// (Cadastros > Base de Dados, padrão/P.A — não alterado por este módulo,
// continua alimentando o Estoque Fiscal exatamente como antes). Chamado
// como efeito colateral desse upload existente: só ATUALIZA o nome de um
// código que já existe no catálogo geral — nunca cria produto novo por
// aqui (createIfMissing=false). Cadastrar produto novo é sempre feito pela
// tela dedicada "Cadastro de Produtos" (ver ../upload/route.ts).
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageProductCatalog(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ATUALIZAR O CATÁLOGO DE PRODUTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const source: ProductCatalogSource = body.source === "pa" ? "pa" : "unigames";
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) return jsonResponse({ created: 0, updated: 0, unchanged: 0, skipped: 0 });
    const items = rawItems.slice(0, MAX_ITEMS).map((item) => {
      const record = item as JsonMap;
      return { code: String(record.code ?? ""), name: String(record.name ?? "") };
    });

    const database = await getD1();
    const result = await upsertProductCatalogEntries(database, source, items, actor, false);
    return jsonResponse({ ...result });
  } catch (error) {
    console.error("Não foi possível reconciliar o catálogo de produtos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL RECONCILIAR O CATÁLOGO." }, 500);
  }
}
