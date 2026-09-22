import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  actorName,
  canManageSchedules,
  canViewSchedules,
  dateInMonth,
  findAssignment,
  identity,
  isValidDate,
  isValidMonth,
  isWeekday,
  jsonResponse,
  safeText,
  sameOrigin,
  uuidIsValid,
  type Identity,
  type JsonMap,
} from "../shared";

// RH > Escalas e Folgas — folga de segunda a sábado, lançada manualmente
// dia a dia (não é um dia fixo por colaborador, varia semana a semana).
// Assim como em sundays/route.ts, só é possível lançar um colaborador que já
// tem loja cadastrada no mês (hr_schedule_assignments).

type WeekdayOffRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  referenceMonth: string;
  offDate: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

const WEEKDAY_OFF_COLUMNS = `
  id, employee_id AS employeeId, employee_name AS employeeName,
  reference_month AS referenceMonth, off_date AS offDate,
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
  const employeeId = safeText(url.searchParams.get("employeeId"), 80);
  if (!isValidMonth(referenceMonth)) {
    return jsonResponse({ error: "MÊS DE REFERÊNCIA INVÁLIDO." }, 400);
  }

  try {
    const database = await getD1();
    const query = employeeId
      ? `SELECT ${WEEKDAY_OFF_COLUMNS} FROM hr_schedule_weekday_off
         WHERE reference_month=?1 AND employee_id=?2 ORDER BY off_date ASC, employee_name ASC`
      : `SELECT ${WEEKDAY_OFF_COLUMNS} FROM hr_schedule_weekday_off
         WHERE reference_month=?1 ORDER BY off_date ASC, employee_name ASC`;
    const statement = employeeId
      ? database.prepare(query).bind(referenceMonth, employeeId)
      : database.prepare(query).bind(referenceMonth);
    const result = await statement.all<WeekdayOffRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar a folga de segunda a sábado.", error);
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
    const employeeId = safeText(body.employeeId, 80);
    const employeeName = safeText(body.employeeName, 160);
    const referenceMonth = safeText(body.referenceMonth, 7);
    const offDate = safeText(body.offDate, 10);

    if (!employeeId || !employeeName) return jsonResponse({ error: "INFORME O COLABORADOR." }, 400);
    if (!isValidMonth(referenceMonth)) return jsonResponse({ error: "MÊS DE REFERÊNCIA INVÁLIDO." }, 400);
    if (!isValidDate(offDate)) return jsonResponse({ error: "DATA INVÁLIDA." }, 400);
    if (!isWeekday(offDate)) return jsonResponse({ error: "A DATA INFORMADA É UM DOMINGO." }, 400);
    if (!dateInMonth(offDate, referenceMonth)) {
      return jsonResponse({ error: "A DATA INFORMADA NÃO PERTENCE AO MÊS DE REFERÊNCIA." }, 400);
    }

    const assignment = await findAssignment(employeeId, referenceMonth);
    if (!assignment) {
      return jsonResponse({ error: "COLABORADOR NÃO TEM LOJA CADASTRADA NESTE MÊS." }, 400);
    }

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM hr_schedule_weekday_off WHERE employee_id=?1 AND off_date=?2 LIMIT 1")
      .bind(employeeId, offDate)
      .first<{ id: string }>();
    if (existing) return jsonResponse({ error: "REGISTRO JÁ EXISTE." }, 409);

    const recordId = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_schedule_weekday_off
          (id, employee_id, employee_name, reference_month, off_date,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP, ?6, ?7, CURRENT_TIMESTAMP)`,
      )
      .bind(recordId, employeeId, employeeName, referenceMonth, offDate, actor.id, actorName(actor))
      .run();

    return jsonResponse({ created: true, id: recordId }, 201);
  } catch (error) {
    console.error("Não foi possível salvar a folga do colaborador.", error);
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
      .prepare("SELECT id FROM hr_schedule_weekday_off WHERE id=?1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
    await database.prepare("DELETE FROM hr_schedule_weekday_off WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a folga do colaborador.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O REGISTRO." }, 500);
  }
}
