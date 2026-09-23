import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  DATE_PATTERN,
  MONTH_PATTERN,
  actorName,
  canManagePayroll,
  centsValue,
  identity,
  jsonResponse,
  loadEmployee,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Rescisões (DRE Funcionário) — valor da rescisão e FGTS de cada
// desligamento. Registrar uma rescisão marca o funcionário como INATIVO no
// mesmo batch; excluir a rescisão NÃO o reativa (reativar é decisão
// explícita no cadastro). A loja gravada é a do funcionário na data do
// registro, para o histórico do DRE não mudar se ele for recontratado em
// outra loja.

type TerminationRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  terminationDate: string;
  severanceCents: number;
  fgtsCents: number;
  notes: string;
  createdByName: string;
  updatedAt: string;
};

const COLUMNS = `id, employee_id AS employeeId, employee_name AS employeeName,
  company_id AS companyId, company_name AS companyName, termination_date AS terminationDate,
  severance_cents AS severanceCents, fgts_cents AS fgtsCents, notes,
  created_by_name AS createdByName, updated_at AS updatedAt`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RH FINANCEIRO." }, 403);
  }
  const url = new URL(request.url);
  const month = safeText(url.searchParams.get("month"), 7);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  if (month && !MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }
  try {
    const database = await getD1();
    const conditions: string[] = [];
    const params: string[] = [];
    if (month) {
      params.push(month);
      conditions.push(`substr(termination_date, 1, 7)=?${params.length}`);
    }
    if (companyId) {
      params.push(companyId);
      conditions.push(`company_id=?${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await database
      .prepare(`SELECT ${COLUMNS} FROM hr_terminations ${where} ORDER BY termination_date DESC, employee_name ASC`)
      .bind(...params)
      .all<TerminationRow>();
    return jsonResponse({ terminations: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as rescisões.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS RESCISÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR RESCISÕES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const employeeId = safeText(body.employeeId, 80);
    const terminationDate = safeText(body.terminationDate, 10);
    const severanceCents = centsValue(body.severanceCents ?? 0);
    const fgtsCents = centsValue(body.fgtsCents ?? 0);
    const notes = safeText(body.notes, 500);

    if (!employeeId) return jsonResponse({ error: "SELECIONE O FUNCIONÁRIO." }, 400);
    if (!DATE_PATTERN.test(terminationDate)) {
      return jsonResponse({ error: "INFORME A DATA DO DESLIGAMENTO." }, 400);
    }
    if (!Number.isFinite(severanceCents) || severanceCents < 0) {
      return jsonResponse({ error: "INFORME UM VALOR DE RESCISÃO VÁLIDO." }, 400);
    }
    if (!Number.isFinite(fgtsCents) || fgtsCents < 0) {
      return jsonResponse({ error: "INFORME UM VALOR DE FGTS VÁLIDO." }, 400);
    }

    const database = await getD1();
    const employee = await loadEmployee(database, employeeId);
    if (!employee) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);

    if (editId) {
      const existing = await database
        .prepare("SELECT id, employee_id AS employeeId FROM hr_terminations WHERE id=?1 LIMIT 1")
        .bind(editId)
        .first<{ id: string; employeeId: string }>();
      if (!existing) return jsonResponse({ error: "RESCISÃO NÃO ENCONTRADA." }, 404);
      // Trocar o funcionário numa edição mantém a loja gravada só se for o
      // mesmo; se mudou, passa a valer a loja do novo funcionário.
      const keepCompany = existing.employeeId === employeeId;
      await database
        .prepare(
          `UPDATE hr_terminations
           SET employee_id=?1, employee_name=?2,
               company_id=CASE WHEN ?3 = 1 THEN company_id ELSE ?4 END,
               company_name=CASE WHEN ?3 = 1 THEN company_name ELSE ?5 END,
               termination_date=?6, severance_cents=?7, fgts_cents=?8, notes=?9,
               updated_by=?10, updated_by_name=?11, updated_at=CURRENT_TIMESTAMP
           WHERE id=?12`,
        )
        .bind(
          employeeId,
          employee.fullName,
          keepCompany ? 1 : 0,
          employee.companyId,
          employee.companyName,
          terminationDate,
          severanceCents,
          fgtsCents,
          notes,
          actor.id,
          actorName(actor),
          editId,
        )
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    await database.batch([
      database
        .prepare(
          `INSERT INTO hr_terminations
            (id, employee_id, employee_name, company_id, company_name, termination_date,
             severance_cents, fgts_cents, notes, created_by, created_by_name, created_at,
             updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, CURRENT_TIMESTAMP, ?10, ?11, CURRENT_TIMESTAMP)`,
        )
        .bind(
          id,
          employeeId,
          employee.fullName,
          employee.companyId,
          employee.companyName,
          terminationDate,
          severanceCents,
          fgtsCents,
          notes,
          actor.id,
          actorName(actor),
        ),
      database
        .prepare(
          `UPDATE hr_employees SET status='inactive', updated_by=?1, updated_by_name=?2,
             updated_at=CURRENT_TIMESTAMP WHERE id=?3`,
        )
        .bind(actor.id, actorName(actor), employeeId),
    ]);
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar a rescisão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A RESCISÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR RESCISÕES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "RESCISÃO INVÁLIDA." }, 400);
  try {
    const database = await getD1();
    await database.prepare("DELETE FROM hr_terminations WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a rescisão.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A RESCISÃO." }, 500);
  }
}
