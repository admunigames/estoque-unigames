import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import {
  canManageProductCatalog,
  canViewProductCatalog,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
  type ProductCatalogRow,
} from "./shared";

const PRODUCT_CATALOG_SELECT =
  `SELECT id, name, code_unigames AS codeUnigames, code_pa AS codePa,
          created_at AS createdAt, updated_by AS updatedBy,
          updated_by_name AS updatedByName, updated_at AS updatedAt
   FROM product_catalog`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewProductCatalog(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER O CATÁLOGO DE PRODUTOS." }, 403);
  }

  const url = new URL(request.url);
  const query = safeText(url.searchParams.get("q"), 120);
  // Sem busca, devolve o catálogo inteiro de uma vez (usado pelo Compras
  // nativo pra montar a sugestão de produto no client, mesmo padrão que já
  // existia com o merge de products_catalog:standard/:pa). Com busca, um
  // limite bem menor já basta pra tela de gestão do catálogo.
  const limit = query ? 200 : 5000;

  try {
    const database = await getD1();
    const result = query
      ? await database
          .prepare(
            `${PRODUCT_CATALOG_SELECT}
             WHERE name ILIKE ?1 OR code_unigames ILIKE ?1 OR code_pa ILIKE ?1
             ORDER BY name ASC LIMIT ${limit}`,
          )
          .bind(`%${query}%`)
          .all<ProductCatalogRow>()
      : await database.prepare(`${PRODUCT_CATALOG_SELECT} ORDER BY name ASC LIMIT ${limit}`).all<ProductCatalogRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o catálogo de produtos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O CATÁLOGO DE PRODUTOS." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageProductCatalog(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR O CATÁLOGO DE PRODUTOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    if (!id) return jsonResponse({ error: "PRODUTO INVÁLIDO." }, 400);
    const name = safeText(body.name, 200);
    if (name.length < 2) return jsonResponse({ error: "INFORME O NOME DO PRODUTO." }, 400);
    const codeUnigames = safeText(body.codeUnigames, 80);
    const codePa = safeText(body.codePa, 80);
    if (!codeUnigames && !codePa) {
      return jsonResponse({ error: "INFORME AO MENOS UM CÓDIGO (UNIGAMES OU P.A LOJA)." }, 400);
    }

    const database = await getD1();
    const existing = await database
      .prepare(`SELECT id FROM product_catalog WHERE id=?1 LIMIT 1`)
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "PRODUTO NÃO ENCONTRADO." }, 404);

    if (codeUnigames) {
      const duplicate = await database
        .prepare(`SELECT id FROM product_catalog WHERE code_unigames=?1 AND id<>?2 LIMIT 1`)
        .bind(codeUnigames, id)
        .first<{ id: string }>();
      if (duplicate) return jsonResponse({ error: "JÁ EXISTE OUTRO PRODUTO COM ESSE CÓDIGO UNIGAMES." }, 409);
    }
    if (codePa) {
      const duplicate = await database
        .prepare(`SELECT id FROM product_catalog WHERE code_pa=?1 AND id<>?2 LIMIT 1`)
        .bind(codePa, id)
        .first<{ id: string }>();
      if (duplicate) return jsonResponse({ error: "JÁ EXISTE OUTRO PRODUTO COM ESSE CÓDIGO P.A LOJA." }, 409);
    }

    await database
      .prepare(
        `UPDATE product_catalog
         SET name=?1, code_unigames=?2, code_pa=?3, updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP
         WHERE id=?6`,
      )
      .bind(name, codeUnigames, codePa, actor.id, actor.displayName, id)
      .run();
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível atualizar o produto do catálogo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR O PRODUTO." }, 500);
  }
}
