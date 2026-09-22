import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  actorName,
  canManageSchedules,
  canViewSchedules,
  identity,
  isValidMonth,
  jsonResponse,
  safeText,
  sameOrigin,
  uuidIsValid,
  type Identity,
  type JsonMap,
} from "../shared";

// RH > Escalas e Folgas — loja fixa do colaborador no mês (base pro cálculo
// de folga de domingo em report/route.ts). Upsert manual por
// (employeeId, referenceMonth): não existe UPSERT nativo no wrapper getD1(),
// então fazemos SELECT antes e decidimos entre UPDATE e INSERT.

type AssignmentRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  referenceMonth: string;
  notes: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

const ASSIGNMENT_COLUMNS = `
  id, employee_id AS employeeId, employee_name AS employeeName,
  company_id AS companyId, company_name AS companyName,
  reference_month AS referenceMonth, notes,
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

  const referenceMonth = safeText(new URL(request.url).searchParams.get("referenceMonth"), 7);
  if (!isValidMonth(referenceMonth)) {
    return jsonResponse({ error: "MÊS DE REFERÊNCIA INVÁLIDO." }, 400);
  }

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT ${ASSIGNMENT_COLUMNS} FROM hr_schedule_assignments
         WHERE reference_month=?1 ORDER BY employee_name ASC`,
      )
      .bind(referenceMonth)
      .all<AssignmentRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar a loja fixa dos colaboradores.", error);
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
    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 200);
    const referenceMonth = safeText(body.referenceMonth, 7);
    const notes = safeText(body.notes, 2000);

    if (!employeeId) return jsonResponse({ error: "INFORME O COLABORADOR." }, 400);
    if (!employeeName) return jsonResponse({ error: "INFORME O COLABORADOR." }, 400);
    if (!isValidMonth(referenceMonth)) return jsonResponse({ error: "MÊS DE REFERÊNCIA INVÁLIDO." }, 400);

    const database = await getD1();

    const employee = await database
      .prepare("SELECT id FROM hr_employees WHERE id=?1 LIMIT 1")
      .bind(employeeId)
      .first<{ id: string }>();
    if (!employee) return jsonResponse({ error: "COLABORADOR NÃO ENCONTRADO." }, 404);

    const existing = await database
      .prepare("SELECT id FROM hr_schedule_assignments WHERE employee_id=?1 AND reference_month=?2 LIMIT 1")
      .bind(employeeId, referenceMonth)
      .first<{ id: string }>();

    const recordId = existing ? existing.id : crypto.randomUUID();
    if (existing) {
      await database
        .prepare(
          `UPDATE hr_schedule_assignments
           SET employee_name=?1, company_id=?2, company_name=?3, notes=?4,
               updated_by=?5, updated_by_name=?6, updated_at=CURRENT_TIMESTAMP
           WHERE id=?7`,
        )
        .bind(employeeName, companyId, companyName, notes, actor.id, actorName(actor), recordId)
        .run();
    } else {
      await database
        .prepare(
          `INSERT INTO hr_schedule_assignments
            (id, employee_id, employee_name, company_id, company_name, reference_month, notes,
             created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, CURRENT_TIMESTAMP, ?8, ?9, CURRENT_TIMESTAMP)`,
        )
        .bind(recordId, employeeId, employeeName, companyId, companyName, referenceMonth, notes, actor.id, actorName(actor))
        .run();
    }

    return jsonResponse(existing ? { updated: true, id: recordId } : { created: true, id: recordId }, existing ? 200 : 201);
  } catch (error) {
    console.error("Não foi possível salvar a loja fixa do colaborador.", error);
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
      .prepare("SELECT id FROM hr_schedule_assignments WHERE id=?1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "REGISTRO NÃO ENCONTRADO." }, 404);
    await database.prepare("DELETE FROM hr_schedule_assignments WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a loja fixa do colaborador.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O REGISTRO." }, 500);
  }
}
