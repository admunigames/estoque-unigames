import { getD1 } from "../../../../db";
import { upsertUserTask } from "../../../lib/hr-notify";
import { addDays, recifeToday } from "../../../lib/hr-rh";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  DATE_PATTERN,
  actorName,
  canManagePdi,
  canViewPdi,
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
// O RH cola/anexa a TRANSCRIÇÃO da reunião e preenche os campos lendo-a (sem
// IA). Ao salvar: tarefa no DIA SEGUINTE com as próximas ações (para quem
// registrou e para o líder, se tiver login vinculado no RH) e um lembrete na
// data de cada prazo — ambas às 09:00, horário em que o push das Tarefas sai.

type NextAction = { action: string; owner: string; dueDate: string };

function nextActionsFrom(value: unknown): NextAction[] {
  return (Array.isArray(value) ? value : [])
    .map((item) => {
      const raw = item && typeof item === "object" ? (item as JsonMap) : {};
      const dueDate = safeText(raw.dueDate, 10);
      return {
        // JSON não passa pela conversão do getD1: CAIXA ALTA aqui.
        action: safeText(raw.action, 300).toLocaleUpperCase("pt-BR"),
        owner: safeText(raw.owner, 120).toLocaleUpperCase("pt-BR"),
        dueDate: DATE_PATTERN.test(dueDate) ? dueDate : "",
      };
    })
    .filter((item) => item.action)
    .slice(0, 30);
}

function formatDate(date: string) {
  return date ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : "";
}

async function createPdiTasks(
  database: Awaited<ReturnType<typeof getD1>>,
  record: { id: string; leaderName: string; companyName: string; actions: NextAction[] },
  actorId: string,
) {
  const leader = await database
    .prepare("SELECT user_id AS userId FROM hr_employees WHERE full_name=?1 AND user_id<>'' LIMIT 1")
    .bind(record.leaderName.toLocaleUpperCase("pt-BR"))
    .first<{ userId: string }>();
  const users = [...new Set([actorId, leader?.userId || ""].filter(Boolean))];
  const who = [record.leaderName, record.companyName].filter(Boolean).join(" — ");
  const list = record.actions
    .map((item, index) => `${index + 1}) ${item.action}${item.owner ? ` — RESP: ${item.owner}` : ""}${item.dueDate ? ` — PRAZO ${formatDate(item.dueDate)}` : ""}`)
    .join("; ");
  for (const userId of users) {
    await upsertUserTask(database, userId, addDays(recifeToday(), 1), {
      id: `pdi-${record.id}`,
      time: "09:00",
      text: `PDI ${who}: ${list ? `PRÓXIMAS AÇÕES: ${list}` : "ACOMPANHAR O QUE FOI COMBINADO"}`,
    });
    for (const [index, item] of record.actions.entries()) {
      if (!item.dueDate) continue;
      await upsertUserTask(database, userId, item.dueDate, {
        id: `pdi-${record.id}-acao-${index + 1}`,
        time: "09:00",
        text: `PRAZO PDI ${who}: ${item.action}${item.owner ? ` — RESP: ${item.owner}` : ""}`,
      });
    }
  }
}

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
  transcriptText: string;
  transcriptFileName: string;
  agreedText: string;
  participants: string;
  nextActionsJson: string;
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
  attachment_size_bytes AS attachmentSizeBytes, transcript_text AS transcriptText,
  transcript_file_name AS transcriptFileName, agreed_text AS agreedText, participants,
  next_actions_json AS nextActionsJson, created_by AS createdBy,
  created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewPdi(actor)) {
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
  if (!canManagePdi(actor)) {
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
    const transcriptText = safeText(body.transcriptText, 200000);
    const transcriptFileName = safeText(body.transcriptFileName, 200);
    const agreedText = safeText(body.agreedText, 4000);
    const participants = safeText(body.participants, 4000);
    const nextActions = nextActionsFrom(body.nextActions);
    const nextActionsJson = JSON.stringify(nextActions);

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
               updated_by=?10, updated_by_name=?11, updated_at=CURRENT_TIMESTAMP,
               transcript_text=?13, transcript_file_name=?14, agreed_text=?15, participants=?16,
               next_actions_json=?17
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
          transcriptText,
          transcriptFileName,
          agreedText,
          participants,
          nextActionsJson,
        )
        .run();
    } else {
      recordId = crypto.randomUUID();
      await database
        .prepare(
          `INSERT INTO hr_leader_pdi
            (id, leader_name, company_id, company_name, meeting_date, topic_discussed,
             suggested_activity, management_feedback, team_members, attendance_signed,
             created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at,
             transcript_text, transcript_file_name, agreed_text, participants, next_actions_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, CURRENT_TIMESTAMP, ?11, ?12, CURRENT_TIMESTAMP,
                   ?13, ?14, ?15, ?16, ?17)`,
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
          transcriptText,
          transcriptFileName,
          agreedText,
          participants,
          nextActionsJson,
        )
        .run();
    }

    // Tarefas não desfazem o salvamento: falha só vai para o log.
    await createPdiTasks(database, { id: recordId, leaderName, companyName, actions: nextActions }, actor.id)
      .catch((error) => console.error("Não foi possível criar as tarefas do PDI.", error));

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
  if (!canManagePdi(actor)) {
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
