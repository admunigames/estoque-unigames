// LOJA ATUANTE do funcionário no mês (ajuste do RH Financeiro, 22/10/2026).
// Cada funcionário tem a loja de ADMISSÃO (onde está registrado) e a loja em
// que ATUA em cada mês — a que vale para a META do Comercial, para a DRE (custo
// de pessoal), para a DRE Funcionário e para a unidade da Folha daquele mês.
//
// Fonte única: hr_schedule_assignments (MÊS → LOJA), a mesma "loja fixa do
// colaborador no mês" das Escalas. Regra:
//   - mês com registro      → a loja registrada;
//   - mês sem registro      → herda o último mês anterior com registro;
//   - mês antes do primeiro registro → a loja de admissão (melhor palpite de
//     onde atuava antes da primeira troca), senão a loja atual do cadastro;
//   - sem NENHUM registro   → a loja atuante do cadastro (company_id). Só ser
//     admitido numa loja não muda o Comercial (usuário, 28/10/2026).
// Por herdar só para frente, trocar a loja do mês corrente nunca muda os
// meses passados.

import type { getD1 } from "../../db";

type Database = Awaited<ReturnType<typeof getD1>>;

export type StoreRef = { companyId: string; companyName: string };
export type MonthAssignment = { referenceMonth: string; companyId: string; companyName: string };

/** Loja do mês pela regra acima (lógica pura). */
export function resolveActingStore(
  assignments: MonthAssignment[],
  month: string,
  fallback: StoreRef,
  current: StoreRef = fallback,
): StoreRef {
  if (!assignments.some((row) => row.companyId)) return current;
  let best: MonthAssignment | null = null;
  for (const row of assignments) {
    if (!row.companyId || row.referenceMonth > month) continue;
    if (!best || row.referenceMonth > best.referenceMonth) best = row;
  }
  return best ? { companyId: best.companyId, companyName: best.companyName } : fallback;
}

type EmployeeStoreRow = {
  id: string;
  companyId: string;
  companyName: string;
  admissionCompanyId: string;
  admissionCompanyName: string;
};

function currentOf(employee: EmployeeStoreRow): StoreRef {
  return employee.companyId ? { companyId: employee.companyId, companyName: employee.companyName } : fallbackOf(employee);
}

function fallbackOf(employee: EmployeeStoreRow): StoreRef {
  return employee.admissionCompanyId
    ? { companyId: employee.admissionCompanyId, companyName: employee.admissionCompanyName }
    : { companyId: employee.companyId, companyName: employee.companyName };
}

/** Loja atuante de TODOS os funcionários no mês (uma ida ao banco por tabela). */
export async function actingStoresForMonth(database: Database, month: string): Promise<Map<string, StoreRef>> {
  const [employees, assignments] = await Promise.all([
    database
      .prepare(
        `SELECT id, company_id AS companyId, company_name AS companyName,
                admission_company_id AS admissionCompanyId, admission_company_name AS admissionCompanyName
         FROM hr_employees`,
      )
      .all<EmployeeStoreRow>(),
    database
      .prepare(
        `SELECT employee_id AS employeeId, reference_month AS referenceMonth, company_id AS companyId, company_name AS companyName
         FROM hr_schedule_assignments WHERE company_id <> ''`,
      )
      .all<MonthAssignment & { employeeId: string }>(),
  ]);
  const byEmployee = new Map<string, MonthAssignment[]>();
  for (const row of assignments.results ?? []) {
    const list = byEmployee.get(row.employeeId) ?? [];
    list.push(row);
    byEmployee.set(row.employeeId, list);
  }
  const result = new Map<string, StoreRef>();
  for (const employee of employees.results ?? []) {
    result.set(employee.id, resolveActingStore(byEmployee.get(employee.id) ?? [], month, fallbackOf(employee), currentOf(employee)));
  }
  return result;
}

/** Loja atuante de UM funcionário no mês (null se o funcionário não existe). */
export async function actingStoreFor(database: Database, employeeId: string, month: string): Promise<StoreRef | null> {
  const employee = await database
    .prepare(
      `SELECT id, company_id AS companyId, company_name AS companyName,
              admission_company_id AS admissionCompanyId, admission_company_name AS admissionCompanyName
       FROM hr_employees WHERE id=?1`,
    )
    .bind(employeeId)
    .first<EmployeeStoreRow>();
  if (!employee) return null;
  const assignments = await database
    .prepare(
      `SELECT reference_month AS referenceMonth, company_id AS companyId, company_name AS companyName
       FROM hr_schedule_assignments WHERE employee_id=?1 AND company_id <> ''`,
    )
    .bind(employeeId)
    .all<MonthAssignment>();
  return resolveActingStore(assignments.results ?? [], month, fallbackOf(employee), currentOf(employee));
}

/**
 * Trabalhou no mês: admitido até o fim do mês e não desligado antes do início
 * dele. lastTermination = último desligamento ('' = nunca); um desligamento
 * anterior à admissão atual (recontratação) não conta.
 */
export function workedInMonth(
  employee: { status: string; admissionDate: string },
  lastTermination: string,
  month: string,
): boolean {
  if (employee.admissionDate && employee.admissionDate > `${month}-31`) return false;
  if (lastTermination && lastTermination >= employee.admissionDate) return lastTermination >= `${month}-01`;
  return employee.status === "active";
}

/**
 * RATEIO POR FUNCIONÁRIOS (04/11/2026): quantos funcionários ATUAM em cada
 * loja no mês (loja atuante acima + workedInMonth) — sem digitar quadro.
 */
export async function actingHeadcountForMonth(
  database: Database,
  month: string,
  actingStores?: Map<string, StoreRef>,
): Promise<Map<string, number>> {
  const [stores, employees, terminations] = await Promise.all([
    actingStores ?? actingStoresForMonth(database, month),
    database
      .prepare("SELECT id, status, admission_date AS admissionDate FROM hr_employees")
      .all<{ id: string; status: string; admissionDate: string }>(),
    database
      .prepare("SELECT employee_id AS employeeId, MAX(termination_date) AS lastDate FROM hr_terminations GROUP BY employee_id")
      .all<{ employeeId: string; lastDate: string }>(),
  ]);
  const lastTermination = new Map((terminations.results ?? []).map((row) => [row.employeeId, String(row.lastDate || "")]));
  const counts = new Map<string, number>();
  for (const employee of employees.results ?? []) {
    if (!workedInMonth(employee, lastTermination.get(employee.id) ?? "", month)) continue;
    const companyId = stores.get(employee.id)?.companyId;
    if (companyId) counts.set(companyId, (counts.get(companyId) ?? 0) + 1);
  }
  return counts;
}
