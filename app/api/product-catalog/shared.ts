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
    actor.permissions.includes("purchases_draft:manage") ||
    // Saídas/Entrada/Alterações PDV também buscam no catálogo geral pra
    // preencher o campo de produto desses formulários.
    actor.permissions.includes("outputs:create") ||
    actor.permissions.includes("inputs:create") ||
    actor.permissions.includes("pdv_requests:create")
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

  // Classifica cada item em um dos 3 grupos abaixo SEM tocar o banco ainda —
  // todo o upload sai em no máximo 3 statements em lote (um UPDATE/INSERT
  // por grupo, via unnest de arrays), não um round-trip por item. Uploads
  // grandes (catálogo geral já passa de 7 mil produtos) faziam milhares de
  // statements sequenciais, cada um esperando o anterior responder — passava
  // do tempo que o navegador aguarda uma resposta HTTP, o Worker acabava
  // gravando tudo certo no banco mas a resposta nunca chegava no client, que
  // ficava preso em "carregando" pra sempre (bug real visto no upload da
  // base P.A Loja com esse volume).
  const codeUpdates: Array<{ id: string; name: string }> = [];
  const nameFillUpdates: Array<{ id: string; code: string; name: string }> = [];
  const inserts: Array<{ id: string; name: string; codeUnigames: string; codePa: string }> = [];

  for (const item of cleanedItems) {
    const byCodeMatch = byCode.get(item.code);
    if (byCodeMatch) {
      if (byCodeMatch.name !== item.name) {
        codeUpdates.push({ id: byCodeMatch.id, name: item.name });
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
      nameFillUpdates.push({ id: byNameMatch.id, code: item.code, name: item.name });
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
    inserts.push({ id, name: item.name, codeUnigames, codePa });
    const newRow: MatchRow = { id, name: item.name, codeUnigames, codePa };
    byCode.set(item.code, newRow);
    if (normalizedKey) byNormalizedName.set(normalizedKey, newRow);
    result.created += 1;
  }

  const operations: D1PreparedStatement[] = [];

  if (codeUpdates.length) {
    operations.push(
      database
        .prepare(
          `UPDATE product_catalog AS pc SET name=v.name, updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
           FROM (SELECT * FROM unnest(?3::text[], ?4::text[]) AS t(id, name)) AS v
           WHERE pc.id = v.id`,
        )
        .bind(
          actor.id,
          actor.displayName,
          codeUpdates.map((u) => u.id),
          codeUpdates.map((u) => u.name),
        ),
    );
  }

  if (nameFillUpdates.length) {
    const codeColumn = source === "unigames" ? "code_unigames" : "code_pa";
    operations.push(
      database
        .prepare(
          `UPDATE product_catalog AS pc SET ${codeColumn}=v.code, name=v.name, updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
           FROM (SELECT * FROM unnest(?3::text[], ?4::text[], ?5::text[]) AS t(id, code, name)) AS v
           WHERE pc.id = v.id`,
        )
        .bind(
          actor.id,
          actor.displayName,
          nameFillUpdates.map((u) => u.id),
          nameFillUpdates.map((u) => u.code),
          nameFillUpdates.map((u) => u.name),
        ),
    );
  }

  if (inserts.length) {
    const insertConflictColumn = source === "unigames" ? "code_unigames" : "code_pa";
    // ON CONFLICT no índice único parcial de codeUnigames/codePa (ver
    // db/schema.ts): se outra requisição concorrente (ex.: duplo clique em
    // "carregar base", ou duas abas enviando o mesmo upload) já inseriu essa
    // linha entre o SELECT no início desta função e este INSERT, vira UPDATE
    // em vez de criar produto duplicado — causa raiz da triplicação do
    // catálogo corrigida por este índice.
    operations.push(
      database
        .prepare(
          `INSERT INTO product_catalog (id, name, code_unigames, code_pa, updated_by, updated_by_name)
           SELECT * FROM unnest(?1::text[], ?2::text[], ?3::text[], ?4::text[], ?5::text[], ?6::text[])
           ON CONFLICT (${insertConflictColumn}) WHERE ${insertConflictColumn} <> '' DO UPDATE SET
             name=EXCLUDED.name, updated_by=EXCLUDED.updated_by,
             updated_by_name=EXCLUDED.updated_by_name, updated_at=CURRENT_TIMESTAMP`,
        )
        .bind(
          inserts.map((i) => i.id),
          inserts.map((i) => i.name),
          inserts.map((i) => i.codeUnigames),
          inserts.map((i) => i.codePa),
          inserts.map(() => actor.id),
          inserts.map(() => actor.displayName),
        ),
    );
  }

  if (operations.length) await database.batch(operations);
  return result;
}
