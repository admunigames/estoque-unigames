import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";
import { PAYROLL_BLOCK_LABELS } from "../dre/payroll";

// Config do mapeamento RH → DRE (item 13): cada bloco de custo de pessoal
// aponta para um item da DRE. Config global, gerida no Financeiro.

const BLOCKS = ["folha", "beneficios", "comissoes"] as const;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  try {
    const database = await getD1();
    const [mappingResult, itemsResult] = await Promise.all([
      database.prepare("SELECT block, finance_item_id AS financeItemId FROM hr_dre_mapping").all<{
        block: string;
        financeItemId: string;
      }>(),
      database
        .prepare(
          `SELECT fi.id AS id, fi.name AS itemName, fc.name AS categoryName, pfc.name AS parentCategoryName
           FROM finance_items fi
           LEFT JOIN finance_categories fc ON fc.id = fi.category_id
           LEFT JOIN finance_categories pfc ON pfc.id = fc.parent_id
           ORDER BY fc.position ASC, fi.position ASC, fi.name ASC`,
        )
        .all<{ id: string; itemName: string; categoryName: string | null; parentCategoryName: string | null }>(),
    ]);

    const byBlock = new Map((mappingResult.results ?? []).map((row) => [row.block, row.financeItemId]));
    const mapping = BLOCKS.map((block) => ({
      block,
      label: PAYROLL_BLOCK_LABELS[block],
      financeItemId: byBlock.get(block) ?? "",
    }));
    const items = (itemsResult.results ?? []).map((row) => ({
      id: row.id,
      label: [row.parentCategoryName, row.categoryName, row.itemName].filter(Boolean).join(" › "),
    }));
    return jsonResponse({ mapping, items });
  } catch (error) {
    console.error("Não foi possível carregar o mapeamento RH → DRE.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O MAPEAMENTO RH → DRE." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CONFIGURAR O MAPEAMENTO RH → DRE." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const incoming = Array.isArray(body.mapping) ? body.mapping : [];
    const wanted = new Map<string, string>();
    for (const raw of incoming) {
      const entry = raw as JsonMap;
      const block = safeText(entry.block, 20);
      if (!(BLOCKS as readonly string[]).includes(block)) {
        return jsonResponse({ error: "BLOCO DE RH INVÁLIDO." }, 400);
      }
      wanted.set(block, safeText(entry.financeItemId, 80));
    }

    const database = await getD1();
    const validItems = new Set(
      ((await database.prepare("SELECT id FROM finance_items").all<{ id: string }>()).results ?? []).map(
        (row) => row.id,
      ),
    );
    for (const itemId of wanted.values()) {
      if (itemId && !validItems.has(itemId)) {
        return jsonResponse({ error: "ITEM DA DRE NÃO ENCONTRADO." }, 400);
      }
    }

    const actorName = actor.displayName || "Administrador";
    await database.batch(
      BLOCKS.map((block) =>
        database
          .prepare(
            `INSERT INTO hr_dre_mapping (block, finance_item_id, updated_by, updated_by_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
             ON CONFLICT (block) DO UPDATE SET
               finance_item_id = excluded.finance_item_id,
               updated_by = excluded.updated_by,
               updated_by_name = excluded.updated_by_name,
               updated_at = CURRENT_TIMESTAMP`,
          )
          .bind(block, wanted.get(block) ?? "", actor.id, actorName),
      ),
    );
    return jsonResponse({ saved: true });
  } catch (error) {
    console.error("Não foi possível salvar o mapeamento RH → DRE.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O MAPEAMENTO RH → DRE." }, 500);
  }
}
