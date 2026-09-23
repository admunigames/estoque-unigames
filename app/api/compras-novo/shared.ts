import { identity, jsonResponse, safeText, sameOrigin, type Identity, type JsonMap } from "../finance/shared";

export { identity, jsonResponse, safeText, sameOrigin };
export type { Identity, JsonMap };

// Módulo "Compras" nativo (Fase A) — permissão única purchases_draft:manage
// (ver worker/index.ts), independente das permissões purchases:* do
// Controle de Compras (Notion), que não é tocado por este módulo.
export function canManageComprasDraft(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("purchases_draft:manage");
}

export function newId() {
  return crypto.randomUUID();
}

export function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Resolve um código de produto digitado (código OU nome) pra TODOS os
// códigos conhecidos daquele produto no catálogo geral (Unigames/P.A Loja)
// — um pedido pode ter sido lançado com qualquer um dos dois, então filtrar
// só pelo código digitado perderia pedidos. Usado tanto pelo histórico "Por
// Produto" quanto pelo filtro de pedidos por produto (cards clicáveis).
export async function resolveProductCodes(database: D1Database, produto: string): Promise<string[]> {
  const catalogMatch = await database
    .prepare(
      `SELECT code_unigames AS codeUnigames, code_pa AS codePa
       FROM product_catalog WHERE code_unigames=?1 OR code_pa=?1 OR name=?1 LIMIT 1`,
    )
    .bind(produto)
    .first<{ codeUnigames: string; codePa: string }>();
  return Array.from(
    new Set([produto, catalogMatch?.codeUnigames, catalogMatch?.codePa].filter((code): code is string => Boolean(code))),
  );
}
