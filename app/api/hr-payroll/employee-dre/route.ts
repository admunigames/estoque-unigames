import { getD1 } from "../../../../db";
import {
  buildEmployeeDre,
  type DreAso,
  type DreBirthday,
  type DreTermination,
  type DreTraining,
} from "../../../lib/hr-employee-dre";
import { unauthorizedResponse } from "../../../lib/notion";
import { MONTH_PATTERN, canManagePayroll, identity, jsonResponse, safeText } from "../shared";

// DRE Funcionário — fechamento do mês (civil), por loja com detalhe por
// colaborador. Tudo calculado ao vivo a partir das fontes; nada é gravado.
// Treinamento e ASO admissional vêm do Recrutamento, aniversariantes do
// cadastro de funcionários (mesma fonte do módulo Aniversariantes) — sem
// duplicar dado. A loja de um candidato é a unidade fixa (ou, sem ela, a
// loja de admissão) cadastrada no Recrutamento.

const CANDIDATE_COMPANY_ID = "COALESCE(NULLIF(c.fixed_unit_id, ''), c.admission_company_id)";
const CANDIDATE_COMPANY_NAME = "COALESCE(NULLIF(c.fixed_unit_name, ''), c.admission_company_name)";

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
  if (!MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }

  try {
    const database = await getD1();
    const [asoExams, candidateAso, trainings, terminations, birthdays] = await Promise.all([
      database
        .prepare(
          `SELECT employee_id AS employeeId, '' AS candidateId, employee_name AS personName,
                  company_id AS companyId, company_name AS companyName, exam_type AS examType,
                  exam_date AS examDate, clinic_name AS clinicName, clinic_cnpj AS clinicCnpj,
                  amount_cents AS amountCents, 'aso' AS source
           FROM hr_aso_exams WHERE substr(exam_date, 1, 7) = ?1`,
        )
        .bind(month)
        .all<DreAso>(),
      database
        .prepare(
          `SELECT c.hr_employee_id AS employeeId, c.id AS candidateId, c.full_name AS personName,
                  ${CANDIDATE_COMPANY_ID} AS companyId, ${CANDIDATE_COMPANY_NAME} AS companyName,
                  'admissional' AS examType, c.aso_date AS examDate, c.aso_clinic AS clinicName,
                  c.aso_clinic_cnpj AS clinicCnpj, c.aso_value_cents AS amountCents,
                  'recrutamento' AS source
           FROM hr_recruitment_candidates c WHERE substr(c.aso_date, 1, 7) = ?1`,
        )
        .bind(month)
        .all<DreAso>(),
      database
        .prepare(
          `SELECT c.hr_employee_id AS employeeId, c.id AS candidateId, c.full_name AS personName,
                  ${CANDIDATE_COMPANY_ID} AS companyId, ${CANDIDATE_COMPANY_NAME} AS companyName,
                  tp.paid_date AS paidDate, tp.amount_cents AS amountCents, tp.note AS note
           FROM hr_recruitment_test_payments tp
           JOIN hr_recruitment_candidates c ON c.id = tp.candidate_id
           WHERE substr(tp.paid_date, 1, 7) = ?1`,
        )
        .bind(month)
        .all<DreTraining>(),
      database
        .prepare(
          `SELECT employee_id AS employeeId, employee_name AS personName, company_id AS companyId,
                  company_name AS companyName, termination_date AS terminationDate,
                  severance_cents AS severanceCents, fgts_cents AS fgtsCents
           FROM hr_terminations WHERE substr(termination_date, 1, 7) = ?1`,
        )
        .bind(month)
        .all<DreTermination>(),
      database
        .prepare(
          `SELECT id AS employeeId, full_name AS personName, company_id AS companyId,
                  company_name AS companyName, birth_date AS birthDate
           FROM hr_employees
           WHERE status = 'active' AND birth_date <> '' AND substr(birth_date, 6, 2) = ?1`,
        )
        .bind(month.slice(5, 7))
        .all<DreBirthday>(),
    ]);

    const byCompany = <T extends { companyId: string }>(rows: T[] | undefined) =>
      (rows ?? []).filter((row) => !companyId || (row.companyId || "") === companyId);

    const report = buildEmployeeDre(month, {
      aso: byCompany([...(asoExams.results ?? []), ...(candidateAso.results ?? [])]),
      trainings: byCompany(trainings.results),
      terminations: byCompany(terminations.results),
      birthdays: byCompany(birthdays.results),
    });
    return jsonResponse(report as unknown as Record<string, unknown>);
  } catch (error) {
    console.error("Não foi possível montar o DRE Funcionário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MONTAR O DRE FUNCIONÁRIO." }, 500);
  }
}
