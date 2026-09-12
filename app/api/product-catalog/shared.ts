import { identity, jsonResponse, safeText, sameOrigin, type Identity, type JsonMap } from "../finance/shared";

export { identity, jsonResponse, safeText, sameOrigin };
export type { Identity, JsonMap };

// Catálogo geral de produtos (Cadastros > Base de Dados > Cadastro de
// Produtos) — usa a mesma dupla view/manage do resto de "Base de Dados"
// (worker/index.ts, MODULE_VIEW_PERMISSIONS.database), não uma permissão
// nova. Ver db/schema.ts (productCatalog) para o desenho da tabela.
export function canViewProductCatalog(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("database:view") ||
    actor.permissions.includes("database:manage") ||
    // Compras nativo consulta o catálogo geral pra sugerir/validar produto.
    actor.permissions.includes("purchases_draft:manage")
  );
}

export function canManageProductCatalog(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("database:manage");
}

export function newId() {
  return crypto.randomUUID();
}

export type ProductCatalogSource = "unigames" | "pa";

export type ProductCatalogRow = {
  id: string;
  name: string;
  codeUnigames: string;
  codePa: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

// Mesma normalização usada no client (public/estoque.html, função
// normalizeProductKey) para casar produtos das abas Unigames/P.A Loja por
// nome quando os códigos são diferentes entre os dois sistemas de origem.
// Mantida em sincronia manualmente — não há import cruzado entre a API e o
// HTML estático.
export function normalizeProductKey(name: string): string {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(da|de|do|das|dos)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PRODUCT_CATALOG_SELECT =
  `SELECT id, name, code_unigames AS codeUnigames, code_pa AS codePa,
          created_at AS createdAt, updated_by AS updatedBy,
          updated_by_name AS updatedByName, updated_at AS updatedAt
   FROM product_catalog`;

type MatchRow = { id: string; name: string; codeUnigames: string; codePa: string };

export type ProductCatalogUpsertResult = {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
};

/**
 * Upsert em lote pra uma aba (source) do catálogo geral. Pra cada item:
 * 1. Acha pelo código DAQUELA aba — se achar, atualiza o nome se mudou
 *    (upload mais recente sempre prevalece).
 * 2. Senão, tenta achar por nome normalizado entre produtos que ainda não
 *    têm código daquela aba — se achar, preenche o código que faltava
 *    (unifica os dois códigos no mesmo produto).
 * 3. Senão, só cria produto novo se createIfMissing=true — do contrário,
 *    ignora (usado pela reconciliação a partir do upload por loja/grupo,
 *    que nunca cria produto novo no catálogo geral, só atualiza nome de
 *    código já cadastrado).
 */
export async function upsertProductCatalogEntries(
  database: D1Database,
  source: ProductCatalogSource,
  items: Array<{ code: string; name: string }>,
  actor: { id: string; displayName: string },
  createIfMissing: boolean,
): Promise<ProductCatalogUpsertResult> {
  const result: ProductCatalogUpsertResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  const cleanedItems = items
    .map((item) => ({ code: safeText(item.code, 80), name: safeText(item.name, 200) }))
    .filter((item) => item.code && item.name);
  if (!cleanedItems.length) return result;

  const existingResult = await database.prepare(PRODUCT_CATALOG_SELECT).all<MatchRow>();
  const existingRows = existingResult.results ?? [];

  const byCode = new Map<string, MatchRow>();
  const byNormalizedName = new Map<string, MatchRow>();
  for (const row of existingRows) {
    const code = source === "unigames" ? row.codeUnigames : row.codePa;
    if (code) byCode.set(code, row);
    const key = normalizeProductKey(row.name);
    if (key && !byNormalizedName.has(key)) byNormalizedName.set(key, row);
  }

  const operations: D1PreparedStatement[] = [];

  for (const item of cleanedItems) {
    const byCodeMatch = byCode.get(item.code);
    if (byCodeMatch) {
      if (byCodeMatch.name !== item.name) {
        operations.push(
          database
            .prepare(
              `UPDATE product_catalog SET name=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4`,
            )
            .bind(item.name, actor.id, actor.displayName, byCodeMatch.id),
        );
        byCodeMatch.name = item.name;
        result.updated += 1;
      } else {
        result.unchanged += 1;
      }
      continue;
    }

    const normalizedKey = normalizeProductKey(item.name);
    const byNameMatch = normalizedKey ? byNormalizedName.get(normalizedKey) : undefined;
    const nameMatchHasThisSourceCode = byNameMatch
      ? Boolean(source === "unigames" ? byNameMatch.codeUnigames : byNameMatch.codePa)
      : true;
    if (byNameMatch && !nameMatchHasThisSourceCode) {
      const codeColumn = source === "unigames" ? "code_unigames" : "code_pa";
      operations.push(
        database
          .prepare(
            `UPDATE product_catalog SET ${codeColumn}=?1, name=?2, updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP WHERE id=?5`,
          )
          .bind(item.code, item.name, actor.id, actor.displayName, byNameMatch.id),
      );
      byCode.set(item.code, byNameMatch);
      if (source === "unigames") byNameMatch.codeUnigames = item.code;
      else byNameMatch.codePa = item.code;
      byNameMatch.name = item.name;
      result.updated += 1;
      continue;
    }

    if (!createIfMissing) {
      result.skipped += 1;
      continue;
    }

    const id = newId();
    const codeUnigames = source === "unigames" ? item.code : "";
    const codePa = source === "pa" ? item.code : "";
    operations.push(
      database
        .prepare(
          `INSERT INTO product_catalog (id, name, code_unigames, code_pa, updated_by, updated_by_name)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(id, item.name, codeUnigames, codePa, actor.id, actor.displayName),
    );
    const newRow: MatchRow = { id, name: item.name, codeUnigames, codePa };
    byCode.set(item.code, newRow);
    if (normalizedKey) byNormalizedName.set(normalizedKey, newRow);
    result.created += 1;
  }

  if (operations.length) await database.batch(operations);
  return result;
}
