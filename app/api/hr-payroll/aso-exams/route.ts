import { getD1 } from "../../../../db";
import { isValidCnpj } from "../../../lib/br-documents";
import { ASO_EXAM_TYPES } from "../../../lib/hr-employee-dre";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  DATE_PATTERN,
  MONTH_PATTERN,
  actorName,
  canManagePayroll,
  centsValue,
  identity,
  isOneOf,
  jsonResponse,
  loadEmployee,
  onlyDigits,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Exames ASO de colaboradores já cadastrados (DRE Funcionário) — periódico,
// demissional, retorno ao trabalho, mudança de função e também admissional
// de quem não passou pelo pipeline de Recrutamento. O ASO admissional de
// quem veio do Recrutamento fica no próprio candidato e é lido de lá pelo
// relatório (não lançar de novo aqui).

type AsoRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  examType: string;
  examDate: string;
  clinicName: string;
  clinicCnpj: string;
  amountCents: number;
  notes: string;
  createdByName: string;
  updatedAt: string;
};

const COLUMNS = `id, employee_id AS employeeId, employee_name AS employeeName,
  company_id AS companyId, company_name AS companyName, exam_type AS examType,
  exam_date AS examDate, clinic_name AS clinicName, clinic_cnpj AS clinicCnpj,
  amount_cents AS amountCents, notes, created_by_name AS createdByName, updated_at AS updatedAt`;

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
      conditions.push(`substr(exam_date, 1, 7)=?${params.length}`);
    }
    if (companyId) {
      params.push(companyId);
      conditions.push(`company_id=?${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await database
      .prepare(`SELECT ${COLUMNS} FROM hr_aso_exams ${where} ORDER BY exam_date DESC, employee_name ASC`)
      .bind(...params)
      .all<AsoRow>();
    return jsonResponse({ exams: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os exames ASO.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS EXAMES ASO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR EXAMES ASO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const employeeId = safeText(body.employeeId, 80);
    const examType = safeText(body.examType, 30);
    const examDate = safeText(body.examDate, 10);
    const clinicName = safeText(body.clinicName, 160);
    const clinicCnpj = onlyDigits(safeText(body.clinicCnpj, 30));
    const amountCents = centsValue(body.amountCents ?? 0);
    const notes = safeText(body.notes, 500);

    if (!employeeId) return jsonResponse({ error: "SELECIONE O FUNCIONÁRIO." }, 400);
    if (!isOneOf(ASO_EXAM_TYPES, examType)) {
      return jsonResponse({ error: "SELECIONE UM TIPO DE EXAME VÁLIDO." }, 400);
    }
    if (!DATE_PATTERN.test(examDate)) return jsonResponse({ error: "INFORME A DATA DO EXAME." }, 400);
    if (!clinicName) return jsonResponse({ error: "INFORME A CLÍNICA." }, 400);
    if (clinicCnpj && !isValidCnpj(clinicCnpj)) {
      return jsonResponse({ error: "INFORME UM CNPJ VÁLIDO PARA A CLÍNICA." }, 400);
    }
    if (!Number.isFinite(amountCents) || amountCents < 0) {
      return jsonResponse({ error: "INFORME UM VALOR VÁLIDO." }, 400);
    }

    const database = await getD1();
    const employee = await loadEmployee(database, employeeId);
    if (!employee) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);

    if (editId) {
      const existing = await database
        .prepare("SELECT id, employee_id AS employeeId FROM hr_aso_exams WHERE id=?1 LIMIT 1")
        .bind(editId)
        .first<{ id: string; employeeId: string }>();
      if (!existing) return jsonResponse({ error: "EXAME NÃO ENCONTRADO." }, 404);
      const keepCompany = existing.employeeId === employeeId;
      await database
        .prepare(
          `UPDATE hr_aso_exams
           SET employee_id=?1, employee_name=?2,
               company_id=CASE WHEN ?3 = 1 THEN company_id ELSE ?4 END,
               company_name=CASE WHEN ?3 = 1 THEN company_name ELSE ?5 END,
               exam_type=?6, exam_date=?7, clinic_name=?8, clinic_cnpj=?9, amount_cents=?10,
               notes=?11, updated_by=?12, updated_by_name=?13, updated_at=CURRENT_TIMESTAMP
           WHERE id=?14`,
        )
        .bind(
          employeeId,
          employee.fullName,
          keepCompany ? 1 : 0,
          employee.companyId,
          employee.companyName,
          examType,
          examDate,
          clinicName,
          clinicCnpj,
          amountCents,
          notes,
          actor.id,
          actorName(actor),
          editId,
        )
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO hr_aso_exams
          (id, employee_id, employee_name, company_id, company_name, exam_type, exam_date,
           clinic_name, clinic_cnpj, amount_cents, notes, created_by, created_by_name, created_at,
           updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, CURRENT_TIMESTAMP,
                 ?12, ?13, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        employeeId,
        employee.fullName,
        employee.companyId,
        employee.companyName,
        examType,
        examDate,
        clinicName,
        clinicCnpj,
        amountCents,
        notes,
        actor.id,
        actorName(actor),
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o exame ASO.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O EXAME ASO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR EXAMES ASO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "EXAME INVÁLIDO." }, 400);
  try {
    const database = await getD1();
    await database.prepare("DELETE FROM hr_aso_exams WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o exame ASO.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O EXAME ASO." }, 500);
  }
}
