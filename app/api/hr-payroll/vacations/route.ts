import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { todayInTimezone } from "../../../lib/finance-status";
import { vacationDays, vacationStatus } from "../../../lib/hr-vacations";
import {
  DATE_PATTERN,
  actorName,
  canManagePayroll,
  centsValue,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// RH > Funcionários > FÉRIAS (31/10/2026): férias gozadas (início, fim,
// valor líquido pago, observações), ligadas ao período aquisitivo, e o
// ACOMPANHAMENTO de cada ativo (próximas férias e vencimento pela CLT —
// app/lib/hr-vacations.ts). Férias NÃO entram na DRE.
//   GET               → { vacations, summary }
//   POST {id?, employeeId, acquisitionStart, startDate, endDate, netCents, notes}
//   DELETE ?id

const COLUMNS = `id, employee_id AS employeeId, employee_name AS employeeName, acquisition_start AS acquisitionStart,
  start_date AS startDate, end_date AS endDate, net_cents AS netCents, notes,
  updated_by_name AS updatedByName, updated_at AS updatedAt`;

type VacationRow = {
  id: string; employeeId: string; employeeName: string; acquisitionStart: string;
  startDate: string; endDate: string; netCents: number; notes: string;
};

function guard(request: Request, write: boolean) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return { error: unauthorized };
  const actor = identity(request);
  if (!canManagePayroll(actor)) return { error: jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA AS FÉRIAS." }, 403) };
  if (write && !sameOrigin(request)) return { error: jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403) };
  return { actor };
}

export async function GET(request: Request) {
  const checked = guard(request, false);
  if ("error" in checked) return checked.error;
  try {
    const database = await getD1();
    const [vacations, employees] = await Promise.all([
      database.prepare(`SELECT ${COLUMNS} FROM hr_vacations ORDER BY start_date DESC`).all<VacationRow>(),
      database
        .prepare(
          `SELECT id, full_name AS fullName, admission_date AS admissionDate, company_id AS companyId,
                  company_name AS companyName, status
           FROM hr_employees ORDER BY full_name ASC`,
        )
        .all<{ id: string; fullName: string; admissionDate: string; companyId: string; companyName: string; status: string }>(),
    ]);
    const list = (vacations.results ?? []).map((row) => ({ ...row, netCents: Number(row.netCents), days: vacationDays(row.startDate, row.endDate) }));
    const today = todayInTimezone();
    const summary = (employees.results ?? []).map((employee) => ({
      employeeId: employee.id,
      fullName: employee.fullName,
      companyId: employee.companyId,
      companyName: employee.companyName,
      admissionDate: employee.admissionDate,
      status: employee.status,
      ...vacationStatus(employee.admissionDate, list.filter((item) => item.employeeId === employee.id), today),
    }));
    return jsonResponse({ today, vacations: list, summary });
  } catch (error) {
    console.error("Não foi possível carregar as férias.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS FÉRIAS." }, 500);
  }
}

export async function POST(request: Request) {
  const checked = guard(request, true);
  if ("error" in checked) return checked.error;
  const { actor } = checked;
  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const employeeId = safeText(body.employeeId, 80);
    const acquisitionStart = safeText(body.acquisitionStart, 10);
    const startDate = safeText(body.startDate, 10);
    const endDate = safeText(body.endDate, 10);
    const netCents = centsValue(body.netCents ?? 0);
    const notes = safeText(body.notes, 500);
    if (!employeeId) return jsonResponse({ error: "SELECIONE O FUNCIONÁRIO." }, 400);
    if (!DATE_PATTERN.test(acquisitionStart)) return jsonResponse({ error: "ESCOLHA O PERÍODO AQUISITIVO." }, 400);
    if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) return jsonResponse({ error: "INFORME O INÍCIO E O FIM DAS FÉRIAS." }, 400);
    if (endDate < startDate) return jsonResponse({ error: "O FIM DAS FÉRIAS NÃO PODE SER ANTES DO INÍCIO." }, 400);
    if (!Number.isFinite(netCents) || netCents < 0) return jsonResponse({ error: "INFORME UM VALOR LÍQUIDO VÁLIDO." }, 400);
    const database = await getD1();
    const employee = await database
      .prepare("SELECT full_name AS fullName FROM hr_employees WHERE id=?1")
      .bind(employeeId)
      .first<{ fullName: string }>();
    if (!employee) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);
    if (id) {
      const row = await database
        .prepare(
          `UPDATE hr_vacations SET employee_id=?1, employee_name=?2, acquisition_start=?3, start_date=?4, end_date=?5,
             net_cents=?6, notes=?7, updated_by=?8, updated_by_name=?9, updated_at=CURRENT_TIMESTAMP
           WHERE id=?10 RETURNING id`,
        )
        .bind(employeeId, employee.fullName, acquisitionStart, startDate, endDate, netCents, notes, actor.id, actorName(actor), id)
        .first<{ id: string }>();
      if (!row) return jsonResponse({ error: "FÉRIAS NÃO ENCONTRADAS." }, 404);
      return jsonResponse({ updated: true, id });
    }
    const newId = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_vacations (id, employee_id, employee_name, acquisition_start, start_date, end_date, net_cents, notes,
           created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CURRENT_TIMESTAMP, ?9, ?10, CURRENT_TIMESTAMP)`,
      )
      .bind(newId, employeeId, employee.fullName, acquisitionStart, startDate, endDate, netCents, notes, actor.id, actorName(actor))
      .run();
    return jsonResponse({ created: true, id: newId }, 201);
  } catch (error) {
    console.error("Não foi possível salvar as férias.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR AS FÉRIAS." }, 500);
  }
}

export async function DELETE(request: Request) {
  const checked = guard(request, true);
  if ("error" in checked) return checked.error;
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "FÉRIAS INVÁLIDAS." }, 400);
  try {
    await (await getD1()).prepare("DELETE FROM hr_vacations WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir as férias.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR AS FÉRIAS." }, 500);
  }
}
