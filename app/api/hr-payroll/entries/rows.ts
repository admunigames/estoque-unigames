import {
  loadEmployerChargesBps,
  loadMonthBenefits,
  loadMonthCommissions,
  loadMonthValues,
  loadOvertimePayouts,
  type Database,
} from "../shared";
import { computePayrollBreakdown, legacyNetCents, type PayrollManualValues } from "../../../lib/hr-payroll";
import { actingStoresForMonth } from "../../../lib/acting-store";

// Linhas da Folha do mês (uma por funcionário ativo da loja, mais os inativos
// com lançamento) — usadas pela tela da Folha e pelo relatório CUSTO TOTAL
// POR FUNCIONÁRIO (app/api/hr-payroll/cost-report).

export type EntryRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  month: string;
  baseSalaryCents: number;
  bonusCents: number;
  overtimeCents: number;
  additionsCents: number;
  deductionsCents: number;
  otherCents: number;
  notes: string;
  paymentDone: number;
  paymentDate: string;
  attachmentFileName: string;
  attachmentR2Key: string;
  attachmentSizeBytes: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

export type EmployeeBasics = {
  id: string;
  fullName: string;
  companyId: string;
  companyName: string;
  roleTitle: string;
  admissionDate: string;
  salaryCents: number;
  status: string;
};

export const ENTRY_COLUMNS = `id, employee_id AS employeeId, employee_name AS employeeName,
  company_id AS companyId, company_name AS companyName, month,
  base_salary_cents AS baseSalaryCents, bonus_cents AS bonusCents,
  overtime_cents AS overtimeCents, additions_cents AS additionsCents,
  deductions_cents AS deductionsCents, other_cents AS otherCents, notes,
  payment_done AS paymentDone, payment_date AS paymentDate,
  attachment_file_name AS attachmentFileName, attachment_r2_key AS attachmentR2Key,
  attachment_size_bytes AS attachmentSizeBytes, created_by AS createdBy,
  created_by_name AS createdByName, created_at AS createdAt, updated_by AS updatedBy,
  updated_by_name AS updatedByName, updated_at AS updatedAt`;

async function loadEmployeesFor(database: Database, companyId: string) {
  const where = companyId ? "WHERE company_id=?1" : "";
  const result = await database
    .prepare(
      `SELECT id, full_name AS fullName, company_id AS companyId, company_name AS companyName,
              role_title AS roleTitle, admission_date AS admissionDate, salary_cents AS salaryCents, status
       FROM hr_employees ${where} ORDER BY full_name ASC`,
    )
    .bind(...(companyId ? [companyId] : []))
    .all<EmployeeBasics>();
  return result.results ?? [];
}

export async function loadPayrollRows(database: Database, month: string, companyId: string) {
  const [allEmployees, entriesResult, employerChargesBps, actingStores, dsrByEmployee, overtimePayouts, recurringResult, commissions, benefits] = await Promise.all([
    loadEmployeesFor(database, ""),
    database
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM hr_payroll_entries WHERE month=?1`)
      .bind(month)
      .all<EntryRow>(),
    loadEmployerChargesBps(database),
    actingStoresForMonth(database, month),
    // DSR MANUAL do mês (hr_employee_month_values) — entra no custo total.
    loadMonthValues(database, month, "dsr"),
    // HE A PAGAR do Controle de Horas (fonte única quando lançada).
    loadOvertimePayouts(database, month),
    // DESCONTO RECORRENTE vigente no mês (migration 0124) — somado ao avulso.
    database
      .prepare(
        `SELECT employee_id AS employeeId, description, amount_cents AS amountCents
         FROM hr_recurring_deductions
         WHERE start_month <= ?1 AND (end_month = '' OR end_month >= ?1)`,
      )
      .bind(month)
      .all<{ employeeId: string; description: string; amountCents: number }>(),
    loadMonthCommissions(database, month),
    loadMonthBenefits(database, month),
  ]);
  const recurringByEmployee = new Map<string, Array<{ description: string; amountCents: number }>>();
  for (const row of recurringResult.results ?? []) {
    const list = recurringByEmployee.get(row.employeeId) ?? [];
    list.push({ description: row.description, amountCents: Number(row.amountCents || 0) });
    recurringByEmployee.set(row.employeeId, list);
  }
  // Unidade do mês = loja atuante (não a loja de hoje do cadastro).
  const employees = allEmployees
    .map((employee) => {
      const store = actingStores.get(employee.id);
      return store ? { ...employee, companyId: store.companyId, companyName: store.companyName } : employee;
    })
    .filter((employee) => !companyId || employee.companyId === companyId);
  const entriesByEmployee = new Map(
    (entriesResult.results ?? []).map((entry) => [entry.employeeId, entry]),
  );

  const visible = employees.filter(
    (employee) => employee.status === "active" || entriesByEmployee.has(employee.id),
  );

  return visible.map((employee) => {
    const entry = entriesByEmployee.get(employee.id) ?? null;
    const values: PayrollManualValues = entry
      ? {
          baseSalaryCents: Number(entry.baseSalaryCents || 0),
          bonusCents: Number(entry.bonusCents || 0),
          overtimeCents: Number(entry.overtimeCents || 0),
          additionsCents: Number(entry.additionsCents || 0),
          deductionsCents: Number(entry.deductionsCents || 0),
          otherCents: Number(entry.otherCents || 0),
        }
      : {
          baseSalaryCents: Number(employee.salaryCents || 0),
          bonusCents: 0,
          overtimeCents: 0,
          additionsCents: 0,
          deductionsCents: 0,
          otherCents: 0,
        };
    const overtimePayoutCents = overtimePayouts.get(employee.id);
    if (overtimePayoutCents !== undefined) values.overtimeCents = overtimePayoutCents;
    const commission = commissions.get(employee.id);
    const benefit = benefits.get(employee.id);
    const commissionCents = commission?.netCents ?? 0;
    const commissionGrossCents = commission?.grossCents ?? 0;
    const benefitsCents = benefit?.netCents ?? 0;
    const benefitsSplit = { grossCents: benefit?.grossCents ?? 0, pixNetCents: benefit?.pixNetCents ?? 0 };
    const inputs = {
      commissionNetCents: commissionCents,
      commissionGrossCents,
      benefitsNetCents: benefitsCents,
      benefitsGrossCents: benefitsSplit.grossCents,
      benefitsPixNetCents: benefitsSplit.pixNetCents,
      employerChargesBps,
      dsrCents: dsrByEmployee.get(employee.id) ?? 0,
    };
    // deductionsCents segue sendo só o AVULSO (o que a tela edita); o
    // recorrente entra no cálculo e vem à parte.
    const recurringDeductions = recurringByEmployee.get(employee.id) ?? [];
    const recurringDeductionsCents = recurringDeductions.reduce((sum, item) => sum + item.amountCents, 0);
    const withRecurring = { ...values, deductionsCents: values.deductionsCents + recurringDeductionsCents };
    const breakdown = computePayrollBreakdown(withRecurring, inputs);
    return {
      id: entry?.id ?? "",
      saved: Boolean(entry),
      employeeId: employee.id,
      employeeName: employee.fullName,
      employeeStatus: employee.status,
      roleTitle: employee.roleTitle,
      admissionDate: employee.admissionDate,
      companyId: employee.companyId,
      companyName: employee.companyName,
      month,
      ...values,
      recurringDeductionsCents,
      recurringDeductions,
      totalDeductionsCents: withRecurring.deductionsCents,
      commissionCents,
      benefitsCents,
      commissionGrossCents,
      benefitsGrossCents: benefitsSplit.grossCents,
      dsrCents: inputs.dsrCents,
      overtimeFromTimeTracking: overtimePayoutCents !== undefined,
      employerChargesBps,
      employerChargesCents: breakdown.employerChargesCents,
      folhaPagaCents: breakdown.folhaPagaCents,
      custoTotalCents: breakdown.custoTotalCents,
      netCents: legacyNetCents(withRecurring, inputs),
      notes: entry?.notes ?? "",
      paymentDone: Number(entry?.paymentDone ?? 0),
      paymentDate: entry?.paymentDate ?? "",
      attachmentFileName: entry?.attachmentFileName ?? "",
      attachmentSizeBytes: Number(entry?.attachmentSizeBytes ?? 0),
    };
  });
}
