import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canManageComprasDraft, identity, jsonResponse, newId, safeText, sameOrigin, type JsonMap } from "../shared";

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
  itemCount: number;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O MÓDULO DE COMPRAS." }, 403);
  }

  const url = new URL(request.url);
  const includeArchived = url.searchParams.get("includeArchived") === "1";

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT d.id, d.name, d.status, d.notes,
                d.created_by AS createdBy, d.created_by_name AS createdByName, d.created_at AS createdAt,
                d.updated_by AS updatedBy, d.updated_by_name AS updatedByName, d.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM purchase_draft_items i WHERE i.draft_id = d.id) AS itemCount
         FROM purchase_drafts d
         ${includeArchived ? "" : "WHERE d.status = 'aberto'"}
         ORDER BY d.created_at DESC`,
      )
      .all<DraftRow>();
    return jsonResponse({ drafts: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os rascunhos de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS RASCUNHOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageComprasDraft(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CRIAR RASCUNHOS DE COMPRA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const name = safeText(body.name, 160);
    const notes = safeText(body.notes, 2000);
    if (name.length < 2) return jsonResponse({ error: "INFORME O NOME DO RASCUNHO." }, 400);

    const database = await getD1();
    const id = newId();
    const actorName = actor.displayName || "Administrador";
    await database
      .prepare(
        `INSERT INTO purchase_drafts
          (id, name, status, notes, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, 'aberto', ?3, ?4, ?5, CURRENT_TIMESTAMP, ?4, ?5, CURRENT_TIMESTAMP)`,
      )
      .bind(id, name, notes, actor.id, actorName)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível criar o rascunho de compra.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CRIAR O RASCUNHO." }, 500);
  }
}
