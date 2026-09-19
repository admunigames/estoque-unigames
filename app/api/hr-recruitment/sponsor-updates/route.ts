import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  actorName,
  canManageRecruitment,
  canViewRecruitment,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  uuidIsValid,
  type JsonMap,
} from "../shared";

// Log/timeline de atualizações semanais do padrinho sobre o apadrinhado —
// múltiplos lançamentos ao longo do tempo, sempre criados (nunca editados).

type UpdateRow = {
  id: string;
  sponsorId: string;
  updateText: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RECRUTAMENTO E SELEÇÃO." }, 403);
  }

  const sponsorId = safeText(new URL(request.url).searchParams.get("sponsorId"), 80);
  if (!uuidIsValid(sponsorId)) return jsonResponse({ error: "PADRINHO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, sponsor_id AS sponsorId, update_text AS updateText,
                created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt
         FROM hr_recruitment_sponsor_updates WHERE sponsor_id=?1 ORDER BY created_at ASC`,
      )
      .bind(sponsorId)
      .all<UpdateRow>();
    return jsonResponse({ updates: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as atualizações do padrinho.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS ATUALIZAÇÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR ATUALIZAÇÕES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const sponsorId = safeText(body.sponsorId, 80);
    const updateText = safeText(body.updateText, 4000);

    if (!uuidIsValid(sponsorId)) return jsonResponse({ error: "PADRINHO INVÁLIDO." }, 400);
    if (!updateText) return jsonResponse({ error: "INFORME O TEXTO DA ATUALIZAÇÃO." }, 400);

    const database = await getD1();
    const sponsor = await database
      .prepare("SELECT id FROM hr_recruitment_sponsors WHERE id=?1")
      .bind(sponsorId)
      .first<{ id: string }>();
    if (!sponsor) return jsonResponse({ error: "PADRINHO NÃO ENCONTRADO." }, 404);

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_recruitment_sponsor_updates
          (id, sponsor_id, update_text, created_by, created_by_name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)`,
      )
      .bind(id, sponsorId, updateText, actor.id, actorName(actor))
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível lançar a atualização do padrinho.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL LANÇAR A ATUALIZAÇÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR ATUALIZAÇÕES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!uuidIsValid(id)) return jsonResponse({ error: "ATUALIZAÇÃO INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM hr_recruitment_sponsor_updates WHERE id=?1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "ATUALIZAÇÃO NÃO ENCONTRADA." }, 404);
    await database.prepare("DELETE FROM hr_recruitment_sponsor_updates WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a atualização do padrinho.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A ATUALIZAÇÃO." }, 500);
  }
}
