import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  actorName,
  canManageSchedules,
  canViewSchedules,
  identity,
  isValidDate,
  isValidMonth,
  jsonResponse,
  safeText,
  sameOrigin,
  uuidIsValid,
  type Identity,
  type JsonMap,
} from "../shared";

// RH > Escalas e Folgas — observação livre por (loja, dia), não por
// colaborador (ex: "WAMBERTO LARGA 20H"). Upsert manual por
// (companyId, noteDate), mesmo padrão de assignments/route.ts: SELECT antes,
// decide entre UPDATE e INSERT.

type DayNoteRow = {
  id: string;
  companyId: string;
  companyName: string;
  referenceMonth: string;
  noteDate: string;
  notes: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

const DAY_NOTE_COLUMNS = `
  id, company_id AS companyId, company_name AS companyName,
  reference_month AS referenceMonth, note_date AS noteDate, notes,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt
`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewSchedules(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR ESCALAS E FOLGAS." }, 403);
  }

  const url = new URL(request.url);
  const referenceMonth = safeText(url.searchParams.get("referenceMonth"), 7);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  if (!isValidMonth(referenceMonth)) {
    return jsonResponse({ error: "MÊS DE REFERÊNCIA INVÁLIDO." }, 400);
  }

  try {
    const database = await getD1();
    const query = companyId
      ? `SELECT ${DAY_NOTE_COLUMNS} FROM hr_schedule_day_notes
         WHERE reference_month=?1 AND company_id=?2 ORDER BY note_date ASC`
      : `SELECT ${DAY_NOTE_COLUMNS} FROM hr_schedule_day_notes
         WHERE reference_month=?1 ORDER BY note_date ASC`;
    const statement = companyId
      ? database.prepare(query).bind(referenceMonth, companyId)
      : database.prepare(query).bind(referenceMonth);
    const result = await statement.all<DayNoteRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as observações do dia.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS REGISTROS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor: Identity = identity(request);
  if (!canManageSchedules(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA GERENCIAR ESCALAS E FOLGAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 200);
    const referenceMonth = safeText(body.referenceMonth, 7);
    const noteDate = safeText(body.noteDate, 10);
    const notes = safeText(body.notes, 2000);

    if (!companyId) return jsonResponse({ error: "INFORME A LOJA." }, 400);
    if (!isValidMonth(referenceMonth)) return jsonResponse({ error: "MÊS DE REFERÊNCIA INVÁLIDO." }, 400);
    if (!isValidDate(noteDate)) return jsonResponse({ error: "DATA INVÁLIDA." }, 400);

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM hr_schedule_day_notes WHERE company_id=?1 AND note_date=?2 LIMIT 1")
      .bind(companyId, noteDate)
      .first<{ id: string }>();

    const recordId = existing ? existing.id : crypto.randomUUID();
    if (existing) {
      await database
        .prepare(
          `UPDATE hr_schedule_day_notes
           SET company_name=?1, notes=?2, updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP
           WHERE id=?5`,
        )
        .bind(companyName, notes, actor.id, actorName(actor), recordId)
        .run();
    } else {
      await database
        .prepare(
          `INSERT INTO hr_schedule_day_notes
            (id, company_id, company_name, reference_month, note_date, notes,
             created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP, ?7, ?8, CURRENT_TIMESTAMP)`,
        )
        .bind(recordId, companyId, companyName, referenceMonth, noteDate, notes, actor.id, actorName(actor))
        .run();
    }

    return jsonResponse(existing ? { updated: true, id: recordId } : { created: true, id: recordId }, existing ? 200 : 201);
  } catch (error) {
    console.error("Não foi possível salvar a observação do dia.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O REGISTRO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageSchedules(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR REGISTROS DE ESCALAS E FOLGAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!uuidIsValid(id)) return jsonResponse({ error: "REGISTRO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM hr_schedule_day_notes WHERE id=?1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
    await database.prepare("DELETE FROM hr_schedule_day_notes WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a observação do dia.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O REGISTRO." }, 500);
  }
}
