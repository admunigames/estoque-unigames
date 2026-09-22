import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  actorName,
  canManageSchedules,
  canViewSchedules,
  dateInMonth,
  findAssignment,
  identity,
  isSunday,
  isValidDate,
  isValidMonth,
  jsonResponse,
  safeText,
  sameOrigin,
  uuidIsValid,
  type Identity,
  type JsonMap,
} from "../shared";

// RH > Escalas e Folgas — escala de domingos TRABALHADOS. A folga de
// domingo de cada colaborador é o complemento disso (ver report/route.ts):
// por isso só é possível lançar aqui um colaborador que já tem loja
// cadastrada no mês (hr_schedule_assignments).

type SundayWorkRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  referenceMonth: string;
  workDate: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

const SUNDAY_WORK_COLUMNS = `
  id, employee_id AS employeeId, employee_name AS employeeName,
  reference_month AS referenceMonth, work_date AS workDate,
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
      ? `SELECT ${SUNDAY_WORK_COLUMNS} FROM hr_schedule_sunday_work
         WHERE reference_month=?1 AND employee_id=?2 ORDER BY work_date ASC, employee_name ASC`
      : `SELECT ${SUNDAY_WORK_COLUMNS} FROM hr_schedule_sunday_work
         WHERE reference_month=?1 ORDER BY work_date ASC, employee_name ASC`;
    const statement = employeeId
      ? database.prepare(query).bind(referenceMonth, employeeId)
      : database.prepare(query).bind(referenceMonth);
    const result = await statement.all<SundayWorkRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar a escala de domingos.", error);
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
    const workDate = safeText(body.workDate, 10);

    if (!employeeId || !employeeName) return jsonResponse({ error: "INFORME O COLABORADOR." }, 400);
    if (!isValidMonth(referenceMonth)) return jsonResponse({ error: "MÊS DE REFERÊNCIA INVÁLIDO." }, 400);
    if (!isValidDate(workDate)) return jsonResponse({ error: "DATA INVÁLIDA." }, 400);
    if (!isSunday(workDate)) return jsonResponse({ error: "A DATA INFORMADA NÃO É UM DOMINGO." }, 400);
    if (!dateInMonth(workDate, referenceMonth)) {
      return jsonResponse({ error: "A DATA INFORMADA NÃO PERTENCE AO MÊS DE REFERÊNCIA." }, 400);
    }

    const assignment = await findAssignment(employeeId, referenceMonth);
    if (!assignment) {
      return jsonResponse({ error: "COLABORADOR NÃO TEM LOJA CADASTRADA NESTE MÊS." }, 400);
    }

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM hr_schedule_sunday_work WHERE employee_id=?1 AND work_date=?2 LIMIT 1")
      .bind(employeeId, workDate)
      .first<{ id: string }>();
    if (existing) return jsonResponse({ error: "REGISTRO JÁ EXISTE." }, 409);

    const recordId = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_schedule_sunday_work
          (id, employee_id, employee_name, reference_month, work_date,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP, ?6, ?7, CURRENT_TIMESTAMP)`,
      )
      .bind(recordId, employeeId, employeeName, referenceMonth, workDate, actor.id, actorName(actor))
      .run();

    return jsonResponse({ created: true, id: recordId }, 201);
  } catch (error) {
    console.error("Não foi possível salvar a escala de domingo trabalhado.", error);
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
      .prepare("SELECT id FROM hr_schedule_sunday_work WHERE id=?1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
    await database.prepare("DELETE FROM hr_schedule_sunday_work WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a escala de domingo trabalhado.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O REGISTRO." }, 500);
  }
}
