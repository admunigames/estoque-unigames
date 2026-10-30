import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { canActOnStore, NO_COMPANY_ERROR } from "../../lib/access-scope";
import { matchCosts, type CostRow } from "../../lib/inventario";
import {
  canView,
  findInventory,
  guard,
  identity,
  jsonResponse,
  loadStores,
  NOT_FOUND,
  safeText,
  storeScope,
  upper,
  type Actor,
  type Database,
} from "./shared";

// Estoque > Inventário.
//   GET                 → inventários (escopo de loja) + lojas
//   GET ?id             → inventário completo: categorias, itens, anotados
//                         para inventário nas Divergências e recontagens
//   POST {storeId, inventoryDate}                  (manage) → novo inventário
//   PATCH {id, action, ...}
//     upload_category {category, fileName, items[{code, product, systemQty}]} (manage)
//     delete_category {category}                   (manage)
//     count {itemId, countedQty|null}              (count) → ao vivo
//     finish_category / reopen_category {category} (count) → quem contou
//     costs {fileName, costs[{code, barcode, gtin, name, costCents}]} (manage)
//     add_item {itemId?, category?, code, product, countedQty, costCents|null} (count) →
//       produto FORA DA LISTA (sistema 0, custo à mão, não sobrescrito pelos custos)
//     delete_item {itemId}                         (count) → só produto fora da lista
//     reason {itemId, reason} / remove {itemId, removed} (manage)
//     recount {itemIds[], recount}                  (manage) → PDF RECONTAGEM DE LOJA
//     finalize {finalized}                          (manage)
//   DELETE {id}                                     (delete; deleted=1)

const MAX_ITEMS_PER_CATEGORY = 5000;
const MAX_COST_ROWS = 20000;
const MAX_QTY = 1_000_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function chunk<T>(list: T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let index = 0; index < list.length; index += size) parts.push(list.slice(index, index + size));
  return parts;
}

function groupByCost(matched: Map<string, number>) {
  const groups = new Map<number, string[]>();
  for (const [itemId, costCents] of matched) groups.set(costCents, [...(groups.get(costCents) ?? []), itemId]);
  return groups;
}

function qty(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && Math.abs(number) <= MAX_QTY ? number : null;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canView(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO AO INVENTÁRIO." }, 403);
  const scope = storeScope(actor);
  if (scope.blocked) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  try {
    const database = await getD1();
    const id = safeText(new URL(request.url).searchParams.get("id"), 80);
    if (id) return await inventoryDetail(database, actor, id);
    const stores = (await loadStores(database)).filter((store) => scope.allStores || store.id === actor.companyId);
    const filter = scope.allStores ? "" : " AND v.store_id=?1";
    const statement = database.prepare(
      `SELECT v.id, v.store_id AS storeId, v.store_name AS storeName, v.inventory_date AS inventoryDate, v.status,
              v.created_by_name AS createdByName, v.finalized_at AS finalizedAt,
              (SELECT count(*) FROM inventory_categories c WHERE c.inventory_id=v.id) AS categories,
              (SELECT count(*) FROM inventory_categories c WHERE c.inventory_id=v.id AND c.counted_at<>'') AS countedCategories,
              (SELECT count(*) FROM inventory_items i WHERE i.inventory_id=v.id) AS items,
              (SELECT count(*) FROM inventory_items i WHERE i.inventory_id=v.id AND i.removed=0
                 AND i.counted_qty IS NOT NULL AND i.counted_qty<>i.system_qty) AS divergent
       FROM inventories v WHERE v.deleted=0${filter}
       ORDER BY v.inventory_date DESC, v.created_at DESC LIMIT 200`,
    );
    const result = await (scope.allStores ? statement : statement.bind(actor.companyId)).all<Record<string, unknown>>();
    const inventories = (result.results ?? []).map((row) => ({
      ...row,
      categories: Number(row.categories), countedCategories: Number(row.countedCategories),
      items: Number(row.items), divergent: Number(row.divergent),
    }));
    return jsonResponse({ stores, inventories });
  } catch (error) {
    console.error("Não foi possível carregar os inventários.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS INVENTÁRIOS." }, 500);
  }
}

async function inventoryDetail(database: Database, actor: Actor, id: string) {
  const inventory = await findInventory(database, actor, id);
  if (!inventory) return jsonResponse({ error: NOT_FOUND }, 404);
  const [full, categories, items, noted, attachments] = await Promise.all([
    database
      .prepare(
        `SELECT id, store_id AS storeId, store_name AS storeName, inventory_date AS inventoryDate, status,
                costs_file_name AS costsFileName, costs_uploaded_by_name AS costsUploadedByName, costs_uploaded_at AS costsUploadedAt,
                finalized_by_name AS finalizedByName, finalized_at AS finalizedAt, created_by_name AS createdByName, created_at AS createdAt
         FROM inventories WHERE id=?1`,
      )
      .bind(id)
      .first<Record<string, unknown>>(),
    database
      .prepare(
        `SELECT category, file_name AS fileName, uploaded_by_name AS uploadedByName, uploaded_at AS uploadedAt,
                counted_by_name AS countedByName, counted_at AS countedAt
         FROM inventory_categories WHERE inventory_id=?1 ORDER BY category`,
      )
      .bind(id)
      .all<Record<string, unknown>>(),
    database
      .prepare(
        `SELECT id, category, code, product, system_qty AS systemQty, counted_qty AS countedQty,
                counted_by_name AS countedByName, counted_at AS countedAt, cost_cents AS costCents, reason,
                source, added_by_name AS addedByName, removed, recount, removed_by_name AS removedByName, removed_at AS removedAt
         FROM inventory_items WHERE inventory_id=?1 ORDER BY category, product`,
      )
      .bind(id)
      .all<Record<string, unknown>>(),
    // Itens "ANOTADO PARA INVENTÁRIO" das Divergências desta loja.
    database
      .prepare(
        `SELECT i.id, i.product_code AS code, i.product_name AS product, i.physical_qty AS physicalQty,
                i.system_qty AS systemQty, i.stock_response AS stockResponse, i.store_notes AS storeNotes,
                i.inventoried_by_name AS inventoriedByName, i.inventoried_at AS inventoriedAt
         FROM divergence_items i JOIN divergence_requests r ON r.id=i.request_id
         WHERE r.company_id=?1 AND i.status='inventario' ORDER BY i.product_name`,
      )
      .bind(inventory.storeId)
      .all<Record<string, unknown>>(),
    database
      .prepare(
        `SELECT id, file_name AS fileName, size_bytes AS sizeBytes, uploaded_by_name AS uploadedByName, uploaded_at AS uploadedAt
         FROM inventory_attachments WHERE inventory_id=?1 AND deleted=0 ORDER BY uploaded_at DESC`,
      )
      .bind(id)
      .all<Record<string, unknown>>(),
  ]);
  const toNumber = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return jsonResponse({
    inventory: full,
    categories: categories.results ?? [],
    items: (items.results ?? []).map((row) => ({
      ...row, systemQty: Number(row.systemQty), countedQty: toNumber(row.countedQty),
      costCents: toNumber(row.costCents), removed: Number(row.removed), recount: Number(row.recount),
    })),
    divergencesNoted: (noted.results ?? []).map((row) => ({ ...row, physicalQty: Number(row.physicalQty), systemQty: Number(row.systemQty) })),
    attachments: attachments.results ?? [],
  });
}

export async function POST(request: Request) {
  const checked = guard(request, ["manage"], "VOCÊ NÃO TEM PERMISSÃO PARA CRIAR INVENTÁRIO.");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const storeId = safeText(body.storeId, 80);
    const inventoryDate = safeText(body.inventoryDate, 10);
    if (!DATE_PATTERN.test(inventoryDate)) return jsonResponse({ error: "DATA INVÁLIDA." }, 400);
    const database = await getD1();
    const store = (await loadStores(database)).find((item) => item.id === storeId);
    if (!store || !canActOnStore(actor, "inventario:manage", storeId)) return jsonResponse({ error: "ESCOLHA A LOJA." }, 400);
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO inventories (id, store_id, store_name, inventory_date, status, deleted, created_by, created_by_name, created_at)
         VALUES (?1, ?2, ?3, ?4, 'aberto', 0, ?5, ?6, ?7)`,
      )
      .bind(id, store.id, store.name, inventoryDate, actor.id, actor.displayName, new Date().toISOString())
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível criar o inventário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CRIAR O INVENTÁRIO." }, 500);
  }
}

const ACTION_PERMISSION: Record<string, string> = {
  add_item: "count", delete_item: "count",
  upload_category: "manage", delete_category: "manage", count: "count", finish_category: "count",
  reopen_category: "count", costs: "manage", reason: "manage", remove: "manage", recount: "manage", finalize: "manage",
};

export async function PATCH(request: Request) {
  const body = (await request.clone().json().catch(() => ({}))) as Record<string, unknown>;
  const action = safeText(body.action, 30);
  const permission = ACTION_PERMISSION[action];
  if (!permission) return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
  // Quem gerencia também conta.
  const checked = guard(request, permission === "count" ? ["count", "manage"] : [permission], "VOCÊ NÃO TEM PERMISSÃO PARA ESTA AÇÃO NO INVENTÁRIO.");
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  try {
    const database = await getD1();
    const inventory = await findInventory(database, actor, safeText(body.id, 80));
    if (!inventory) return jsonResponse({ error: NOT_FOUND }, 404);
    if (inventory.status === "finalizado" && action !== "finalize") {
      return jsonResponse({ error: "INVENTÁRIO FINALIZADO: REABRA PARA ALTERAR." }, 409);
    }
    const now = new Date().toISOString();
    const category = upper(body.category, 120);

    if (action === "upload_category") {
      if (!category) return jsonResponse({ error: "INFORME A CATEGORIA." }, 400);
      const raw = Array.isArray(body.items) ? body.items : [];
      if (!raw.length) return jsonResponse({ error: "O RELATÓRIO NÃO TEM PRODUTOS." }, 400);
      if (raw.length > MAX_ITEMS_PER_CATEGORY) return jsonResponse({ error: "RELATÓRIO GRANDE DEMAIS PARA UMA CATEGORIA." }, 400);
      const items = [];
      for (const entry of raw as Record<string, unknown>[]) {
        const product = upper(entry.product, 200);
        const systemQty = qty(entry.systemQty);
        if (!product || systemQty === null) return jsonResponse({ error: `LINHA INVÁLIDA NO RELATÓRIO: ${product || "SEM NOME"}.` }, 400);
        items.push({ code: safeText(entry.code, 60), product, systemQty });
      }
      const counted = await database
        .prepare("SELECT count(*) AS n FROM inventory_items WHERE inventory_id=?1 AND category=?2 AND counted_qty IS NOT NULL")
        .bind(inventory.id, category)
        .first<{ n: number }>();
      if (Number(counted?.n || 0) > 0) {
        return jsonResponse({ error: `A CATEGORIA ${category} JÁ TEM CONTAGEM. EXCLUA A CATEGORIA ANTES DE SUBIR DE NOVO.` }, 409);
      }
      await database.batch([
        database.prepare("DELETE FROM inventory_items WHERE inventory_id=?1 AND category=?2").bind(inventory.id, category),
        database.prepare("DELETE FROM inventory_categories WHERE inventory_id=?1 AND category=?2").bind(inventory.id, category),
        database
          .prepare(
            `INSERT INTO inventory_categories (id, inventory_id, category, file_name, uploaded_by_name, uploaded_at, counted_by_name, counted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', '')`,
          )
          .bind(crypto.randomUUID(), inventory.id, category, safeText(body.fileName, 200), actor.displayName, now),
        ...chunk(items, 200).map((part) =>
          database
            .prepare(
              `INSERT INTO inventory_items (id, inventory_id, category, code, product, system_qty, counted_qty, cost_cents, reason, removed,
                 updated_by_name, updated_at)
               VALUES ${part.map((_, index) => `(?${index * 4 + 4}, ?1, ?2, ?${index * 4 + 5}, ?${index * 4 + 6}, ?${index * 4 + 7}, NULL, NULL, '', 0, ?3, ?${part.length * 4 + 4})`).join(", ")}`,
            )
            .bind(inventory.id, category, actor.displayName,
              ...part.flatMap((item) => [crypto.randomUUID(), item.code, item.product, item.systemQty]), now)),
      ]);
      return jsonResponse({ uploaded: true, category, items: items.length });
    }

    if (action === "delete_category") {
      await database.batch([
        database.prepare("DELETE FROM inventory_items WHERE inventory_id=?1 AND category=?2").bind(inventory.id, category),
        database.prepare("DELETE FROM inventory_categories WHERE inventory_id=?1 AND category=?2").bind(inventory.id, category),
      ]);
      return jsonResponse({ deleted: true });
    }

    if (action === "add_item" || action === "delete_item") {
      const itemId = safeText(body.itemId, 80);
      const existing = itemId
        ? await database
          .prepare("SELECT id FROM inventory_items WHERE id=?1 AND inventory_id=?2 AND source='manual'")
          .bind(itemId, inventory.id)
          .first<{ id: string }>()
        : null;
      if (itemId && !existing) return jsonResponse({ error: "PRODUTO FORA DA LISTA NÃO ENCONTRADO." }, 404);
      if (action === "delete_item") {
        if (!existing) return jsonResponse({ error: "PRODUTO FORA DA LISTA NÃO ENCONTRADO." }, 404);
        await database.prepare("DELETE FROM inventory_items WHERE id=?1").bind(existing.id).run();
        return jsonResponse({ deleted: true });
      }
      const product = upper(body.product, 200);
      const countedQty = qty(body.countedQty);
      const rawCost = body.costCents;
      const costCents = rawCost === null || rawCost === undefined || rawCost === "" ? null : Number(rawCost);
      if (!product) return jsonResponse({ error: "INFORME O PRODUTO." }, 400);
      if (countedQty === null || countedQty < 0) return jsonResponse({ error: "INFORME A QUANTIDADE CONTADA." }, 400);
      if (costCents !== null && (!Number.isInteger(costCents) || costCents < 0 || costCents > 100_000_00)) {
        return jsonResponse({ error: "CUSTO INVÁLIDO." }, 400);
      }
      if (existing) {
        await database
          .prepare(
            `UPDATE inventory_items SET code=?1, product=?2, counted_qty=?3, cost_cents=?4, counted_by_name=?5, counted_at=?6,
               updated_by_name=?5, updated_at=?6 WHERE id=?7`,
          )
          .bind(safeText(body.code, 60), product, countedQty, costCents, actor.displayName, now, existing.id)
          .run();
        return jsonResponse({ updated: true, id: existing.id });
      }
      // Categoria escolhida ou "FORA DA LISTA" (criada na hora, se ainda não existir).
      const target = category || "FORA DA LISTA";
      const id = crypto.randomUUID();
      await database.batch([
        database
          .prepare(
            `INSERT INTO inventory_categories (id, inventory_id, category, file_name, uploaded_by_name, uploaded_at, counted_by_name, counted_at)
             VALUES (?1, ?2, ?3, '', ?4, ?5, '', '') ON CONFLICT (inventory_id, category) DO NOTHING`,
          )
          .bind(crypto.randomUUID(), inventory.id, target, actor.displayName, now),
        database
          .prepare(
            `INSERT INTO inventory_items (id, inventory_id, category, code, product, system_qty, counted_qty, counted_by_name, counted_at,
               cost_cents, reason, source, added_by_name, removed, updated_by_name, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, '', 'manual', ?7, 0, ?7, ?8)`,
          )
          .bind(id, inventory.id, target, safeText(body.code, 60), product, countedQty, actor.displayName, now, costCents),
      ]);
      return jsonResponse({ created: true, id, category: target }, 201);
    }

    if (action === "count") {
      const raw = body.countedQty;
      const countedQty = raw === null || raw === "" ? null : qty(raw);
      if (countedQty === null && raw !== null && raw !== "") return jsonResponse({ error: "QUANTIDADE INVÁLIDA." }, 400);
      if (countedQty !== null && countedQty < 0) return jsonResponse({ error: "A QUANTIDADE CONTADA NÃO PODE SER NEGATIVA." }, 400);
      const row = await database
        .prepare(
          `UPDATE inventory_items SET counted_qty=?1, counted_by_name=?2, counted_at=?3, updated_by_name=?2, updated_at=?3
           WHERE id=?4 AND inventory_id=?5 RETURNING id`,
        )
        .bind(countedQty, countedQty === null ? "" : actor.displayName, countedQty === null ? "" : now, safeText(body.itemId, 80), inventory.id)
        .first<{ id: string }>();
      if (!row) return jsonResponse({ error: "PRODUTO NÃO ENCONTRADO." }, 404);
      return jsonResponse({ counted: true });
    }

    if (action === "finish_category" || action === "reopen_category") {
      const finishing = action === "finish_category";
      const statements = [
        database
          .prepare("UPDATE inventory_categories SET counted_by_name=?1, counted_at=?2 WHERE inventory_id=?3 AND category=?4")
          .bind(finishing ? actor.displayName : "", finishing ? now : "", inventory.id, category),
      ];
      // Produto não contado ao finalizar a categoria = contado ZERO.
      if (finishing) {
        statements.push(
          database
            .prepare(
              `UPDATE inventory_items SET counted_qty=0, counted_by_name=?1, counted_at=?2, updated_by_name=?1, updated_at=?2
               WHERE inventory_id=?3 AND category=?4 AND counted_qty IS NULL`,
            )
            .bind(actor.displayName, now, inventory.id, category),
        );
      }
      await database.batch(statements);
      return jsonResponse({ updated: true });
    }

    if (action === "costs") {
      const raw = Array.isArray(body.costs) ? body.costs : [];
      if (!raw.length) return jsonResponse({ error: "O RELATÓRIO DE CUSTOS NÃO TEM PRODUTOS." }, 400);
      if (raw.length > MAX_COST_ROWS) return jsonResponse({ error: "RELATÓRIO DE CUSTOS GRANDE DEMAIS." }, 400);
      const costs: CostRow[] = (raw as Record<string, unknown>[])
        .map((row) => ({
          code: safeText(row.code, 60), barcode: safeText(row.barcode, 60), gtin: safeText(row.gtin, 60),
          name: safeText(row.name, 200), costCents: Number(row.costCents),
        }))
        .filter((row) => Number.isInteger(row.costCents) && row.costCents >= 0);
      const items = await database
        .prepare("SELECT id, code, product FROM inventory_items WHERE inventory_id=?1 AND source<>'manual'")
        .bind(inventory.id)
        .all<{ id: string; code: string; product: string }>();
      const matched = matchCosts(items.results ?? [], costs);
      await database.batch([
        // Produto fora da lista mantém o custo digitado à mão.
        database.prepare("UPDATE inventory_items SET cost_cents=NULL WHERE inventory_id=?1 AND source<>'manual'").bind(inventory.id),
        // Um UPDATE por valor de custo (muitos produtos têm o mesmo custo).
        ...[...groupByCost(matched)].flatMap(([costCents, ids]) => chunk(ids, 500).map((part) =>
          database
            .prepare(`UPDATE inventory_items SET cost_cents=?1 WHERE id IN (${part.map((_, index) => `?${index + 2}`).join(", ")})`)
            .bind(costCents, ...part))),
        database
          .prepare("UPDATE inventories SET costs_file_name=?1, costs_uploaded_by_name=?2, costs_uploaded_at=?3 WHERE id=?4")
          .bind(safeText(body.fileName, 200), actor.displayName, now, inventory.id),
      ]);
      return jsonResponse({ matched: matched.size, items: (items.results ?? []).length });
    }

    if (action === "reason" || action === "remove") {
      const statement = action === "reason"
        ? database
          .prepare("UPDATE inventory_items SET reason=?1, updated_by_name=?2, updated_at=?3 WHERE id=?4 AND inventory_id=?5 RETURNING id")
          .bind(upper(body.reason, 1000), actor.displayName, now, safeText(body.itemId, 80), inventory.id)
        : database
          .prepare(
            `UPDATE inventory_items SET removed=?1, removed_by_name=?2, removed_at=?3, updated_by_name=?4, updated_at=?5
             WHERE id=?6 AND inventory_id=?7 RETURNING id`,
          )
          .bind(body.removed ? 1 : 0, body.removed ? actor.displayName : "", body.removed ? now : "", actor.displayName, now,
            safeText(body.itemId, 80), inventory.id);
      const row = await statement.first<{ id: string }>();
      if (!row) return jsonResponse({ error: "PRODUTO NÃO ENCONTRADO." }, 404);
      return jsonResponse({ updated: true });
    }

    if (action === "recount") {
      const ids = (Array.isArray(body.itemIds) ? body.itemIds : []).map((value) => safeText(value, 80)).filter(Boolean);
      if (!ids.length || ids.length > MAX_ITEMS_PER_CATEGORY) return jsonResponse({ error: "ESCOLHA OS PRODUTOS." }, 400);
      for (const part of chunk(ids, 90)) {
        await database
          .prepare(
            `UPDATE inventory_items SET recount=?1, updated_by_name=?2, updated_at=?3
             WHERE inventory_id=?4 AND id IN (${part.map((_id, index) => `?${index + 5}`).join(",")})`,
          )
          .bind(body.recount ? 1 : 0, actor.displayName, now, inventory.id, ...part)
          .run();
      }
      return jsonResponse({ updated: true });
    }

    // finalize
    const finalized = Boolean(body.finalized);
    await database
      .prepare("UPDATE inventories SET status=?1, finalized_by_name=?2, finalized_at=?3 WHERE id=?4")
      .bind(finalized ? "finalizado" : "aberto", finalized ? actor.displayName : "", finalized ? now : "", inventory.id)
      .run();
    return jsonResponse({ updated: true, status: finalized ? "finalizado" : "aberto" });
  } catch (error) {
    console.error("Não foi possível atualizar o inventário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR O INVENTÁRIO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const checked = guard(request, ["delete"], "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR INVENTÁRIO.");
  if ("error" in checked) return checked.error;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const database = await getD1();
    const inventory = await findInventory(database, checked.actor, safeText(body.id, 80));
    if (!inventory) return jsonResponse({ error: NOT_FOUND }, 404);
    await database.prepare("UPDATE inventories SET deleted=1 WHERE id=?1").bind(inventory.id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o inventário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O INVENTÁRIO." }, 500);
  }
}
