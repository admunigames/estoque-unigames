import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  DATE_PATTERN,
  actorName,
  canManageStoreTracking,
  canViewStoreTracking,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  uuidIsValid,
  boolToInt,
  type JsonMap,
} from "../shared";

// PDI (Plano de Desenvolvimento Individual) de líderes de loja — um registro
// por encontro. Loja é escolhida no formulário (diferente do módulo
// "acompanhamento por loja", onde a loja vem da aba ativa).

type LeaderPdiRow = {
  id: string;
  leaderName: string;
  companyId: string;
  companyName: string;
  meetingDate: string;
  topicDiscussed: string;
  suggestedActivity: string;
  managementFeedback: string;
  teamMembers: string;
  attendanceSigned: number;
  attachmentFileName: string;
  attachmentR2Key: string;
  attachmentSizeBytes: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

const COLUMNS = `id, leader_name AS leaderName, company_id AS companyId, company_name AS companyName,
  meeting_date AS meetingDate, topic_discussed AS topicDiscussed,
  suggested_activity AS suggestedActivity, management_feedback AS managementFeedback,
  team_members AS teamMembers, attendance_signed AS attendanceSigned,
  attachment_file_name AS attachmentFileName, attachment_r2_key AS attachmentR2Key,
  attachment_size_bytes AS attachmentSizeBytes, created_by AS createdBy,
  created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewStoreTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O PDI DE LÍDERES." }, 403);
  }

  const url = new URL(request.url);
  const companyId = safeText(url.searchParams.get("companyId"), 80);

  try {
    const database = await getD1();
    const conditions: string[] = [];
    const params: string[] = [];
    if (companyId) {
      params.push(companyId);
      conditions.push(`company_id=?${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await database
      .prepare(`SELECT ${COLUMNS} FROM hr_leader_pdi ${where} ORDER BY meeting_date DESC, created_at DESC`)
      .bind(...params)
      .all<LeaderPdiRow>();
    return jsonResponse({ records: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o PDI de líderes.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O PDI DE LÍDERES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageStoreTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR O PDI DE LÍDERES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const leaderName = safeText(body.leaderName, 160);
    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 160);
    const meetingDate = safeText(body.meetingDate, 10);
    const topicDiscussed = safeText(body.topicDiscussed, 4000);
    const suggestedActivity = safeText(body.suggestedActivity, 4000);
    const managementFeedback = safeText(body.managementFeedback, 4000);
    const teamMembers = safeText(body.teamMembers, 4000);
    const attendanceSigned = boolToInt(body.attendanceSigned);

    if (!leaderName) return jsonResponse({ error: "INFORME O NOME DO LÍDER." }, 400);
    if (!companyId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
    if (meetingDate && !DATE_PATTERN.test(meetingDate)) {
      return jsonResponse({ error: "INFORME UMA DATA DO ENCONTRO VÁLIDA (AAAA-MM-DD)." }, 400);
    }

    const database = await getD1();
    let recordId = editId;
    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM hr_leader_pdi WHERE id=?1 LIMIT 1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "REGISTRO DE PDI NÃO ENCONTRADO." }, 404);
      await database
        .prepare(
          `UPDATE hr_leader_pdi
           SET leader_name=?1, company_id=?2, company_name=?3, meeting_date=?4, topic_discussed=?5,
               suggested_activity=?6, management_feedback=?7, team_members=?8, attendance_signed=?9,
               updated_by=?10, updated_by_name=?11, updated_at=CURRENT_TIMESTAMP
           WHERE id=?12`,
        )
        .bind(
          leaderName,
          companyId,
          companyName,
          meetingDate,
          topicDiscussed,
          suggestedActivity,
          managementFeedback,
          teamMembers,
          attendanceSigned,
          actor.id,
          actorName(actor),
          editId,
        )
        .run();
    } else {
      recordId = crypto.randomUUID();
      await database
        .prepare(
          `INSERT INTO hr_leader_pdi
            (id, leader_name, company_id, company_name, meeting_date, topic_discussed,
             suggested_activity, management_feedback, team_members, attendance_signed,
             created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, CURRENT_TIMESTAMP, ?11, ?12, CURRENT_TIMESTAMP)`,
        )
        .bind(
          recordId,
          leaderName,
          companyId,
          companyName,
          meetingDate,
          topicDiscussed,
          suggestedActivity,
          managementFeedback,
          teamMembers,
          attendanceSigned,
          actor.id,
          actorName(actor),
        )
        .run();
    }

    return jsonResponse(
      editId ? { updated: true, id: recordId } : { created: true, id: recordId },
      editId ? 200 : 201,
    );
  } catch (error) {
    console.error("Não foi possível salvar o registro de PDI.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O REGISTRO DE PDI." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageStoreTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR REGISTROS DE PDI." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!uuidIsValid(id)) return jsonResponse({ error: "REGISTRO DE PDI INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT attachment_r2_key AS attachmentR2Key FROM hr_leader_pdi WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ attachmentR2Key: string }>();
    if (!existing) return jsonResponse({ error: "REGISTRO DE PDI NÃO ENCONTRADO." }, 404);
    await database.prepare("DELETE FROM hr_leader_pdi WHERE id=?1").bind(id).run();
    if (existing.attachmentR2Key) {
      const { documentsBucket } = await import("../../documents/shared");
      const bucket = await documentsBucket();
      await bucket.delete(existing.attachmentR2Key).catch(() => undefined);
    }
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o registro de PDI.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O REGISTRO DE PDI." }, 500);
  }
}
