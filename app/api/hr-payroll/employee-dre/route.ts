import { getD1 } from "../../../../db";
import { activeOn } from "../../../lib/hr-rh";
import { loadCompanyList } from "../../finance/shared";
import {
  buildCnpjSummary,
  buildEmployeeDre,
  type DreAso,
  type DreBirthday,
  type DreTermination,
  type DreTraining,
} from "../../../lib/hr-employee-dre";
import { unauthorizedResponse } from "../../../lib/notion";
import { MONTH_PATTERN, canManagePayroll, identity, jsonResponse, loadMonthValues, loadOvertimePayouts, safeText } from "../shared";
import { actingStoresForMonth } from "../../../lib/acting-store";

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

    // Por CNPJ: quem esteve ativo no mês, na loja atuante do mês. FGTS 8% por
    // colaborador sobre a base = salário + comissão + HE + DSR do mês (com
    // folha lançada) ou o salário do cadastro (sem folha); INSS manual.
    const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const [employees, allTerminations, assignments, payroll, commissions, dsr, inss, overtimePayouts] = await Promise.all([
      database
        .prepare(
          `SELECT id, full_name AS fullName, admission_date AS admissionDate, status, company_id AS companyId,
                  salary_cents AS salaryCents FROM hr_employees`,
        )
        .all<{ id: string; fullName: string; admissionDate: string; status: string; companyId: string; salaryCents: number }>(),
      database
        .prepare("SELECT employee_id AS employeeId, termination_date AS terminationDate FROM hr_terminations")
        .all<{ employeeId: string; terminationDate: string }>(),
      // Loja do mês = loja atuante (RH > Funcionários / Escalas), herdando o
      // último mês com registro; sem registro, a loja de admissão.
      actingStoresForMonth(database, month),
      database
        .prepare(
          `SELECT employee_id AS employeeId, base_salary_cents AS baseSalaryCents, overtime_cents AS overtimeCents
           FROM hr_payroll_entries WHERE month=?1`,
        )
        .bind(month)
        .all<{ employeeId: string; baseSalaryCents: number; overtimeCents: number }>(),
      // Comissão bruta (comissão + bônus + premiação + ajustes) — a mesma do
      // CUSTO TOTAL POR FUNCIONÁRIO.
      database
        .prepare(
          `SELECT employee_id AS employeeId,
                  COALESCE(SUM(commission_cents + commercial_premium_cents + bonuses_cents + premiums_cents + adjustments_cents), 0) AS total
           FROM hr_commissions WHERE month=?1 GROUP BY employee_id`,
        )
        .bind(month)
        .all<{ employeeId: string; total: number }>(),
      loadMonthValues(database, month, "dsr"),
      loadMonthValues(database, month, "inss"),
      loadOvertimePayouts(database, month),
    ]);
    const terms = allTerminations.results ?? [];
    const monthStoreOf = new Map([...assignments].map(([employeeId, store]) => [employeeId, store.companyId]));
    const commissionOf = new Map((commissions.results ?? []).map((row) => [row.employeeId, Number(row.total) || 0]));
    const payrollBaseOf = new Map(
      (payroll.results ?? []).map((row) => [
        row.employeeId,
        (Number(row.baseSalaryCents) || 0) + (overtimePayouts.get(row.employeeId) ?? (Number(row.overtimeCents) || 0)) +
          (commissionOf.get(row.employeeId) ?? 0) +
          (dsr.get(row.employeeId) ?? 0),
      ]),
    );
    const staff = (employees.results ?? [])
      .filter((employee) => activeOn(employee, terms, monthEnd) ||
        terms.some((item) => item.employeeId === employee.id && item.terminationDate.slice(0, 7) === month))
      .map((employee) => ({
        employeeId: employee.id,
        personName: employee.fullName,
        companyId: monthStoreOf.get(employee.id) || employee.companyId,
        salaryCents: payrollBaseOf.get(employee.id) ?? (Number(employee.salaryCents) || 0),
        inssCents: inss.get(employee.id) ?? 0,
      }))
      .filter((person) => !companyId || person.companyId === companyId);
    const companies = (await loadCompanyList(database)) as Array<{ id: string; name: string; cnpj?: string }>;
    const byCnpj = buildCnpjSummary(report.stores, staff, [...companies, { id: "assistencia", name: "Assistência" }]);
    return jsonResponse({ ...report, byCnpj } as unknown as Record<string, unknown>);
  } catch (error) {
    console.error("Não foi possível montar o DRE Funcionário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL MONTAR O DRE FUNCIONÁRIO." }, 500);
  }
}
