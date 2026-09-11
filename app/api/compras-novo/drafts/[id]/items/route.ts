import { getD1 } from "../../../../../../db";
import { unauthorizedResponse } from "../../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, newId, safeText, sameOrigin, type JsonMap } from "../../../shared";

// targetStores: [{ companyId, companyName }] — candidateSupplierIds: [supplierId, ...].
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

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR RASCUNHOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id: draftId } = await context.params;

  try {
    const database = await getD1();
    const draft = await database
      .prepare("SELECT id, status FROM purchase_drafts WHERE id=?1")
      .bind(draftId)
      .first<{ id: string; status: string }>();
    if (!draft) return jsonResponse({ error: "RASCUNHO NÃO ENCONTRADO." }, 404);
    if (draft.status !== "aberto") {
      return jsonResponse({ error: "ESTE RASCUNHO ESTÁ ARQUIVADO E NÃO PODE RECEBER NOVOS ITENS." }, 409);
    }

    const body = (await request.json()) as JsonMap;
    const productCode = safeText(body.productCode, 80);
    const productName = safeText(body.productName, 200);
    const quantity = Number(body.quantity);
    const notes = safeText(body.notes, 2000);
    const targetStores = safeStoreList(body.targetStores);
    const candidateSupplierIds = safeSupplierIdList(body.candidateSupplierIds);
    const stockSnapshotJson =
      body.stockSnapshot && typeof body.stockSnapshot === "object" ? JSON.stringify(body.stockSnapshot) : "{}";

    if (!productCode) return jsonResponse({ error: "INFORME O CÓDIGO DO PRODUTO." }, 400);
    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 0) {
      return jsonResponse({ error: "INFORME UMA QUANTIDADE VÁLIDA." }, 400);
    }

    const id = newId();
    const actorName = actor.displayName || "Administrador";
    await database
      .prepare(
        `INSERT INTO purchase_draft_items
          (id, draft_id, product_code, product_name, quantity, target_stores, candidate_supplier_ids,
           notes, stock_snapshot_json, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, CURRENT_TIMESTAMP, ?10, ?11, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        draftId,
        productCode,
        productName,
        quantity,
        JSON.stringify(targetStores),
        JSON.stringify(candidateSupplierIds),
        notes,
        stockSnapshotJson,
        actor.id,
        actorName,
      )
      .run();

    await database
      .prepare("UPDATE purchase_drafts SET updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?3")
      .bind(actor.id, actorName, draftId)
      .run();

    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível adicionar o item ao rascunho de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ADICIONAR O ITEM." }, 500);
  }
}
