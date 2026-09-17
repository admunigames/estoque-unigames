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

// Acompanhamento semanal da equipe de uma loja — tabela única para todas as
// lojas; a loja vem sempre da aba ativa no cliente (companyId obrigatório
// na query/no corpo), sem select de loja no formulário.

type StoreTrackingRow = {
  id: string;
  companyId: string;
  companyName: string;
  teamMembers: string;
  week: string;
  meetingDate: string;
  managementFeedback: string;
  topicDiscussed: string;
  suggestedActivity: string;
  inPersonReturn: string;
  memberReturns: string;
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

const COLUMNS = `id, company_id AS companyId, company_name AS companyName, team_members AS teamMembers,
  week, meeting_date AS meetingDate, management_feedback AS managementFeedback,
  topic_discussed AS topicDiscussed, suggested_activity AS suggestedActivity,
  in_person_return AS inPersonReturn, member_returns AS memberReturns,
  attendance_signed AS attendanceSigned, attachment_file_name AS attachmentFileName,
  attachment_r2_key AS attachmentR2Key, attachment_size_bytes AS attachmentSizeBytes,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewStoreTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O ACOMPANHAMENTO DE LOJAS." }, 403);
  }

  const url = new URL(request.url);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  if (!companyId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT ${COLUMNS} FROM hr_store_tracking WHERE company_id=?1
         ORDER BY meeting_date DESC, created_at DESC`,
      )
      .bind(companyId)
      .all<StoreTrackingRow>();
    return jsonResponse({ records: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o acompanhamento da loja.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O ACOMPANHAMENTO DA LOJA." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageStoreTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR O ACOMPANHAMENTO DE LOJAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 160);
    const teamMembers = safeText(body.teamMembers, 4000);
    const week = safeText(body.week, 80);
    const meetingDate = safeText(body.meetingDate, 10);
    const managementFeedback = safeText(body.managementFeedback, 4000);
    const topicDiscussed = safeText(body.topicDiscussed, 4000);
    const suggestedActivity = safeText(body.suggestedActivity, 4000);
    const inPersonReturn = safeText(body.inPersonReturn, 2000);
    const memberReturns = safeText(body.memberReturns, 4000);
    const attendanceSigned = boolToInt(body.attendanceSigned);

    if (!companyId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
    if (meetingDate && !DATE_PATTERN.test(meetingDate)) {
      return jsonResponse({ error: "INFORME UMA DATA DO ENCONTRO VÁLIDA (AAAA-MM-DD)." }, 400);
    }

    const database = await getD1();
    let recordId = editId;
    if (editId) {
      const existing = await database
        .prepare("SELECT id, company_id AS companyId FROM hr_store_tracking WHERE id=?1 LIMIT 1")
        .bind(editId)
        .first<{ id: string; companyId: string }>();
      if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
      if (existing.companyId !== companyId) {
        return jsonResponse({ error: "NÃO É POSSÍVEL MUDAR A LOJA DE UM REGISTRO EXISTENTE." }, 400);
      }
      await database
        .prepare(
          `UPDATE hr_store_tracking
           SET company_name=?1, team_members=?2, week=?3, meeting_date=?4, management_feedback=?5,
               topic_discussed=?6, suggested_activity=?7, in_person_return=?8, member_returns=?9,
               attendance_signed=?10, updated_by=?11, updated_by_name=?12, updated_at=CURRENT_TIMESTAMP
           WHERE id=?13`,
        )
        .bind(
          companyName,
          teamMembers,
          week,
          meetingDate,
          managementFeedback,
          topicDiscussed,
          suggestedActivity,
          inPersonReturn,
          memberReturns,
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
          `INSERT INTO hr_store_tracking
            (id, company_id, company_name, team_members, week, meeting_date, management_feedback,
             topic_discussed, suggested_activity, in_person_return, member_returns, attendance_signed,
             created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, CURRENT_TIMESTAMP, ?12, ?13, CURRENT_TIMESTAMP)`,
        )
        .bind(
          recordId,
          companyId,
          companyName,
          teamMembers,
          week,
          meetingDate,
          managementFeedback,
          topicDiscussed,
          suggestedActivity,
          inPersonReturn,
          memberReturns,
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
    console.error("Não foi possível salvar o acompanhamento da loja.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O ACOMPANHAMENTO DA LOJA." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageStoreTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR O ACOMPANHAMENTO DE LOJAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!uuidIsValid(id)) return jsonResponse({ error: "REGISTRO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT attachment_r2_key AS attachmentR2Key FROM hr_store_tracking WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ attachmentR2Key: string }>();
    if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
    await database.prepare("DELETE FROM hr_store_tracking WHERE id=?1").bind(id).run();
    if (existing.attachmentR2Key) {
      const { documentsBucket } = await import("../../documents/shared");
      const bucket = await documentsBucket();
      await bucket.delete(existing.attachmentR2Key).catch(() => undefined);
    }
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o acompanhamento da loja.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O ACOMPANHAMENTO DA LOJA." }, 500);
  }
}
