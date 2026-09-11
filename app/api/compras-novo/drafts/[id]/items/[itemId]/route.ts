import { getD1 } from "../../../../../../../db";
import { unauthorizedResponse } from "../../../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../../../shared";

type ItemRow = {
  id: string;
  draftId: string;
  productCode: string;
  productName: string;
  quantity: number;
  targetStores: string;
  candidateSupplierIds: string;
  notes: string;
};

function safeStoreList(value: unknown): { companyId: string; companyName: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = entry && typeof entry === "object" ? (entry as JsonMap) : {};
      return {
        companyId: safeText(record.companyId, 80),
        companyName: safeText(record.companyName, 160),
      };
    })
    .filter((entry) => entry.companyId);
}

function safeSupplierIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((entry) => safeText(entry, 80)).filter((entry) => entry)),
  );
}

async function loadItem(database: D1Database, draftId: string, itemId: string) {
  return database
    .prepare(
      `SELECT id, draft_id AS draftId, product_code AS productCode, product_name AS productName,
              quantity, target_stores AS targetStores, candidate_supplier_ids AS candidateSupplierIds, notes
       FROM purchase_draft_items WHERE id=?1 AND draft_id=?2`,
    )
    .bind(itemId, draftId)
    .first<ItemRow>();
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR RASCUNHOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id: draftId, itemId } = await context.params;

  try {
    const database = await getD1();
    const item = await loadItem(database, draftId, itemId);
    if (!item) return jsonResponse({ error: "ITEM NÃO ENCONTRADO." }, 404);

    const body = (await request.json()) as JsonMap;
    const productCode = body.productCode === undefined ? item.productCode : safeText(body.productCode, 80);
    if (!productCode) return jsonResponse({ error: "INFORME O CÓDIGO DO PRODUTO." }, 400);
    const productName = body.productName === undefined ? item.productName : safeText(body.productName, 200);
    const notes = body.notes === undefined ? item.notes : safeText(body.notes, 2000);

    let quantity = item.quantity;
    if (body.quantity !== undefined) {
      quantity = Number(body.quantity);
      if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 0) {
        return jsonResponse({ error: "INFORME UMA QUANTIDADE VÁLIDA." }, 400);
      }
    }

    const targetStores =
      body.targetStores === undefined ? item.targetStores : JSON.stringify(safeStoreList(body.targetStores));
    const candidateSupplierIds =
      body.candidateSupplierIds === undefined
        ? item.candidateSupplierIds
        : JSON.stringify(safeSupplierIdList(body.candidateSupplierIds));

    const actorName = actor.displayName || "Administrador";
    await database
      .prepare(
        `UPDATE purchase_draft_items
         SET product_code=?1, product_name=?2, quantity=?3, target_stores=?4, candidate_supplier_ids=?5,
             notes=?6, updated_by=?7, updated_by_name=?8, updated_at=CURRENT_TIMESTAMP
         WHERE id=?9`,
      )
      .bind(productCode, productName, quantity, targetStores, candidateSupplierIds, notes, actor.id, actorName, itemId)
      .run();
    await database
      .prepare("UPDATE purchase_drafts SET updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?3")
      .bind(actor.id, actorName, draftId)
      .run();

    return jsonResponse({ updated: true, id: itemId });
  } catch (error) {
    console.error("Não foi possível editar o item do rascunho de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR O ITEM." }, 500);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR RASCUNHOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id: draftId, itemId } = await context.params;

  try {
    const database = await getD1();
    const item = await loadItem(database, draftId, itemId);
    if (!item) return jsonResponse({ error: "ITEM NÃO ENCONTRADO." }, 404);

    await database.prepare("DELETE FROM purchase_draft_items WHERE id=?1").bind(itemId).run();
    const actorName = actor.displayName || "Administrador";
    await database
      .prepare("UPDATE purchase_drafts SET updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?3")
      .bind(actor.id, actorName, draftId)
      .run();

    return jsonResponse({ deleted: true, id: itemId });
  } catch (error) {
    console.error("Não foi possível remover o item do rascunho de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REMOVER O ITEM." }, 500);
  }
}
