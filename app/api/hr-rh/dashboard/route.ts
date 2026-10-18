import { getD1 } from "../../../../db";
import { roleFromTitle } from "../../../lib/commercial";
import { DATE_RE, peopleIndicators, previousPeriod, recifeToday, recruitmentIndicators } from "../../../lib/hr-rh";
import { unauthorizedResponse } from "../../../lib/notion";
import { identity, jsonResponse, rhCan, safeText } from "../shared";

// RH > Painel do RH > Dashboard — indicadores de Pessoas (admitidos,
// demitidos, turnover) e do Recrutamento (entrevistas, aprovados, status,
// ordem de admissão) no período, comparados com o período anterior de mesmo
// tamanho. Filtros: período, loja e pessoa (o filtro de LÍDER escolhe a loja
// do líder na tela).

type Employee = { id: string; fullName: string; admissionDate: string; status: string; companyId: string; companyName: string; roleTitle: string };
type Termination = { employeeId: string; employeeName: string; terminationDate: string; companyId: string; companyName: string; reason: string };
type Candidate = {
  id: string; fullName: string; status: string; interviewDate: string; interviewResult: string; createdAt: string;
  storeId: string; storeName: string; desiredRole: string; trainingStartDate: string;
};

function normalize(text: string) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!rhCan(identity(request), "rh_dashboard:view")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER O DASHBOARD DO RH." }, 403);
  }
  const url = new URL(request.url);
  const from = safeText(url.searchParams.get("from"), 10);
  const to = safeText(url.searchParams.get("to"), 10);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  const person = normalize(safeText(url.searchParams.get("person"), 120));
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    return jsonResponse({ error: "INFORME UM PERÍODO VÁLIDO." }, 400);
  }

  try {
    const database = await getD1();
    const [employeeResult, terminationResult, candidateResult] = await Promise.all([
      database
        .prepare(
          `SELECT id, full_name AS fullName, admission_date AS admissionDate, status, company_id AS companyId,
                  company_name AS companyName, role_title AS roleTitle FROM hr_employees`,
        )
        .all<Employee>(),
      database
        .prepare(
          `SELECT employee_id AS employeeId, employee_name AS employeeName, termination_date AS terminationDate,
                  company_id AS companyId, company_name AS companyName, reason FROM hr_terminations`,
        )
        .all<Termination>(),
      database
        .prepare(
          `SELECT id, full_name AS fullName, status, interview_date AS interviewDate, interview_result AS interviewResult,
                  created_at AS createdAt, desired_role AS desiredRole, training_start_date AS trainingStartDate,
                  admission_company_id AS admissionCompanyId, admission_company_name AS admissionCompanyName,
                  fixed_unit_id AS fixedUnitId, fixed_unit_name AS fixedUnitName
           FROM hr_recruitment_candidates`,
        )
        .all<Candidate & { admissionCompanyId: string; admissionCompanyName: string; fixedUnitId: string; fixedUnitName: string }>(),
    ]);
    const allEmployees = employeeResult.results ?? [];
    const leaders = allEmployees
      .filter((employee) => employee.status === "active" && roleFromTitle(employee.roleTitle) === "lider")
      .map((employee) => ({ name: employee.fullName, companyId: employee.companyId, companyName: employee.companyName }));
    const matchesPerson = (name: string) => !person || normalize(name).includes(person);
    const employees = allEmployees.filter((employee) =>
      (!companyId || employee.companyId === companyId) && matchesPerson(employee.fullName));
    const terminations = (terminationResult.results ?? []).filter((item) =>
      (!companyId || item.companyId === companyId) && matchesPerson(item.employeeName));
    const candidates = (candidateResult.results ?? [])
      .map((candidate) => ({
        ...candidate,
        storeId: candidate.admissionCompanyId || candidate.fixedUnitId,
        storeName: candidate.admissionCompanyName || candidate.fixedUnitName,
      }))
      .filter((candidate) => (!companyId || candidate.storeId === companyId) && matchesPerson(candidate.fullName));

    const today = recifeToday();
    const previous = previousPeriod(from, to);
    const indicators = (start: string, end: string) => ({
      ...peopleIndicators(employees, terminations, start, end),
      ...recruitmentIndicators(candidates, start, end, today),
    });
    // Ordem de admissão: aprovados na entrevista ainda não contratados, por data.
    const admissionQueue = candidates
      .filter((candidate) => candidate.interviewResult === "aprovado" &&
        !["contratado", "integracao", "cancelado"].includes(candidate.status))
      .sort((a, b) => (a.interviewDate || a.createdAt).localeCompare(b.interviewDate || b.createdAt))
      .map((candidate) => ({
        id: candidate.id, fullName: candidate.fullName, status: candidate.status, desiredRole: candidate.desiredRole,
        interviewDate: candidate.interviewDate, trainingStartDate: candidate.trainingStartDate, storeName: candidate.storeName,
      }));
    const inPeriod = (date: string) => Boolean(date) && date >= from && date <= to;
    return jsonResponse({
      from, to, previous,
      current: indicators(from, to),
      before: indicators(previous.from, previous.to),
      admissionQueue,
      admitted: employees.filter((employee) => inPeriod(employee.admissionDate))
        .map((employee) => ({ fullName: employee.fullName, companyName: employee.companyName, date: employee.admissionDate, roleTitle: employee.roleTitle })),
      dismissed: terminations.filter((item) => inPeriod(item.terminationDate))
        .map((item) => ({ fullName: item.employeeName, companyName: item.companyName, date: item.terminationDate, reason: item.reason })),
      leaders,
    });
  } catch (error) {
    console.error("Não foi possível carregar o dashboard do RH.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O DASHBOARD DO RH." }, 500);
  }
}
