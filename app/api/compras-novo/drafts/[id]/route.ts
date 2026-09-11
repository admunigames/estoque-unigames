import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";

type DraftRow = {
  id: string;
  name: string;
  status: string;
  notes: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

type ItemRow = {
  id: string;
  draftId: string;
  productCode: string;
  productName: string;
  quantity: number;
  targetStores: string;
  candidateSupplierIds: string;
  notes: string;
  stockSnapshotJson: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

async function loadDraft(database: D1Database, id: string) {
  return database
    .prepare(
      `SELECT id, name, status, notes,
              created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
              updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt
       FROM purchase_drafts WHERE id=?1`,
    )
    .bind(id)
    .first<DraftRow>();
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O MÓDULO DE COMPRAS." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const draft = await loadDraft(database, id);
    if (!draft) return jsonResponse({ error: "RASCUNHO NÃO ENCONTRADO." }, 404);

    const items = await database
      .prepare(
        `SELECT id, draft_id AS draftId, product_code AS productCode, product_name AS productName,
                quantity, target_stores AS targetStores, candidate_supplier_ids AS candidateSupplierIds,
                notes, stock_snapshot_json AS stockSnapshotJson,
                created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
                updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt
         FROM purchase_draft_items WHERE draft_id=?1 ORDER BY created_at ASC`,
      )
      .bind(id)
      .all<ItemRow>();

    return jsonResponse({ draft, items: items.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o rascunho de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O RASCUNHO." }, 500);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR RASCUNHOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const draft = await loadDraft(database, id);
    if (!draft) return jsonResponse({ error: "RASCUNHO NÃO ENCONTRADO." }, 404);

    const body = (await request.json()) as JsonMap;
    const name = body.name === undefined ? draft.name : safeText(body.name, 160);
    if (name.length < 2) return jsonResponse({ error: "INFORME O NOME DO RASCUNHO." }, 400);
    const notes = body.notes === undefined ? draft.notes : safeText(body.notes, 2000);
    const status = body.status === undefined ? draft.status : safeText(body.status, 20);
    if (status !== "aberto" && status !== "arquivado") {
      return jsonResponse({ error: "STATUS INVÁLIDO." }, 400);
    }

    await database
      .prepare(
        `UPDATE purchase_drafts
         SET name=?1, notes=?2, status=?3, updated_by=?4, updated_by_name=?5, updated_at=CURRENT_TIMESTAMP
         WHERE id=?6`,
      )
      .bind(name, notes, status, actor.id, actor.displayName || "Administrador", id)
      .run();
    return jsonResponse({ updated: true, id });
  } catch (error) {
    console.error("Não foi possível editar o rascunho de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EDITAR O RASCUNHO." }, 500);
  }
}

// Arquivamento (soft-delete) — mesmo padrão do resto do projeto: nenhum
// rascunho é fisicamente apagado, só sai da listagem padrão (status
// 'arquivado', ver GET /drafts sem includeArchived=1).
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ARQUIVAR RASCUNHOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const { id } = await context.params;

  try {
    const database = await getD1();
    const draft = await loadDraft(database, id);
    if (!draft) return jsonResponse({ error: "RASCUNHO NÃO ENCONTRADO." }, 404);

    await database
      .prepare(
        `UPDATE purchase_drafts
         SET status='arquivado', updated_by=?1, updated_by_name=?2, updated_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
      )
      .bind(actor.id, actor.displayName || "Administrador", id)
      .run();
    return jsonResponse({ archived: true, id });
  } catch (error) {
    console.error("Não foi possível arquivar o rascunho de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ARQUIVAR O RASCUNHO." }, 500);
  }
}
