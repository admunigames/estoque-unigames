import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { documentsBucket } from "../../documents/shared";
import {
  canManagePayroll,
  centsValue,
  computedBenefitsCentsFor,
  computedCommissionCentsFor,
  DATE_PATTERN,
  MONTH_PATTERN,
  actorName,
  identity,
  jsonResponse,
  loadEmployee,
  safeText,
  sameOrigin,
  type Database,
  type Identity,
  type JsonMap,
} from "../shared";

// Folha de Pagamento mensal.
//
// A listagem NÃO devolve só as linhas já gravadas: ela devolve uma linha por
// funcionário ativo da loja filtrada (mais qualquer funcionário inativo que
// já tenha lançamento no mês), com os valores manuais zerados e o salário
// base pré-preenchido pelo cadastro quando ainda não existe lançamento —
// é o que a tela precisa pra montar a folha do mês inteira de uma vez.
//
// Comissão e Benefícios NUNCA são colunas desta tabela: são recalculados a
// cada leitura a partir de hr_commissions/hr_benefits.

type EntryRow = {
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

type EmployeeBasics = {
  id: string;
  fullName: string;
  companyId: string;
  companyName: string;
  roleTitle: string;
  salaryCents: number;
  status: string;
};

const ENTRY_COLUMNS = `id, employee_id AS employeeId, employee_name AS employeeName,
  company_id AS companyId, company_name AS companyName, month,
  base_salary_cents AS baseSalaryCents, bonus_cents AS bonusCents,
  overtime_cents AS overtimeCents, additions_cents AS additionsCents,
  deductions_cents AS deductionsCents, other_cents AS otherCents, notes,
  payment_done AS paymentDone, payment_date AS paymentDate,
  attachment_file_name AS attachmentFileName, attachment_r2_key AS attachmentR2Key,
  attachment_size_bytes AS attachmentSizeBytes, created_by AS createdBy,
  created_by_name AS createdByName, created_at AS createdAt, updated_by AS updatedBy,
  updated_by_name AS updatedByName, updated_at AS updatedAt`;

const MANUAL_FIELDS = [
  "baseSalaryCents",
  "bonusCents",
  "overtimeCents",
  "additionsCents",
  "deductionsCents",
  "otherCents",
] as const;

type ManualValues = Record<(typeof MANUAL_FIELDS)[number], number>;

function manualValuesFrom(source: JsonMap | EntryRow): ManualValues | null {
  const values = {} as ManualValues;
  for (const field of MANUAL_FIELDS) {
    const parsed = centsValue((source as JsonMap)[field] ?? 0);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    values[field] = parsed;
  }
  return values;
}

function netCentsFor(values: ManualValues, commissionCents: number, benefitsCents: number) {
  return (
    values.baseSalaryCents +
    values.bonusCents +
    values.overtimeCents +
    values.additionsCents +
    values.otherCents +
    commissionCents +
    benefitsCents -
    values.deductionsCents
  );
}

async function loadEmployeesFor(database: Database, companyId: string) {
  const where = companyId ? "WHERE company_id=?1" : "";
  const result = await database
    .prepare(
      `SELECT id, full_name AS fullName, company_id AS companyId, company_name AS companyName,
              role_title AS roleTitle, salary_cents AS salaryCents, status
       FROM hr_employees ${where} ORDER BY full_name ASC`,
    )
    .bind(...(companyId ? [companyId] : []))
    .all<EmployeeBasics>();
  return result.results ?? [];
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR A FOLHA DE PAGAMENTO." }, 403);
  }

  const url = new URL(request.url);
  const month = safeText(url.searchParams.get("month"), 7);
  if (!MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }
  const companyId = safeText(url.searchParams.get("companyId"), 80);

  try {
    const database = await getD1();
    const [employees, entriesResult] = await Promise.all([
      loadEmployeesFor(database, companyId),
      database
        .prepare(`SELECT ${ENTRY_COLUMNS} FROM hr_payroll_entries WHERE month=?1`)
        .bind(month)
        .all<EntryRow>(),
    ]);
    const entriesByEmployee = new Map(
      (entriesResult.results ?? []).map((entry) => [entry.employeeId, entry]),
    );

    const visible = employees.filter(
      (employee) => employee.status === "active" || entriesByEmployee.has(employee.id),
    );

    const rows = await Promise.all(
      visible.map(async (employee) => {
        const entry = entriesByEmployee.get(employee.id) ?? null;
        const values: ManualValues = entry
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
        const [commissionCents, benefitsCents] = await Promise.all([
          computedCommissionCentsFor(database, employee.id, month),
          computedBenefitsCentsFor(database, employee.id, month),
        ]);
        return {
          id: entry?.id ?? "",
          saved: Boolean(entry),
          employeeId: employee.id,
          employeeName: employee.fullName,
          employeeStatus: employee.status,
          roleTitle: employee.roleTitle,
          companyId: employee.companyId,
          companyName: employee.companyName,
          month,
          ...values,
          commissionCents,
          benefitsCents,
          netCents: netCentsFor(values, commissionCents, benefitsCents),
          notes: entry?.notes ?? "",
          paymentDone: Number(entry?.paymentDone ?? 0),
          paymentDate: entry?.paymentDate ?? "",
          attachmentFileName: entry?.attachmentFileName ?? "",
          attachmentSizeBytes: Number(entry?.attachmentSizeBytes ?? 0),
        };
      }),
    );

    return jsonResponse({ month, companyId, entries: rows });
  } catch (error) {
    console.error("Não foi possível carregar a folha de pagamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A FOLHA DE PAGAMENTO." }, 500);
  }
}

async function saveEntry(database: Database, actor: Identity, body: JsonMap) {
  const editId = safeText(body.id, 80);
  const employeeId = safeText(body.employeeId, 80);
  const month = safeText(body.month, 7);
  const notes = safeText(body.notes, 500);
  const copyFromMonth = safeText(body.copyFromMonth, 7);

  if (!employeeId) return jsonResponse({ error: "SELECIONE O FUNCIONÁRIO." }, 400);
  if (!MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }
  if (copyFromMonth && !MONTH_PATTERN.test(copyFromMonth)) {
    return jsonResponse({ error: "INFORME UM MÊS DE ORIGEM VÁLIDO (AAAA-MM)." }, 400);
  }

  const employee = await loadEmployee(database, employeeId);
  if (!employee) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);

  // "Copiar do mês anterior": os valores manuais vêm da folha daquele mês,
  // não do corpo da requisição (a tela só manda o mês de origem).
  let values: ManualValues | null;
  if (copyFromMonth) {
    const source = await database
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM hr_payroll_entries WHERE employee_id=?1 AND month=?2 LIMIT 1`)
      .bind(employeeId, copyFromMonth)
      .first<EntryRow>();
    if (!source) {
      return jsonResponse({ error: "NÃO EXISTE FOLHA DESSE FUNCIONÁRIO NO MÊS DE ORIGEM." }, 404);
    }
    values = manualValuesFrom(source);
  } else {
    values = manualValuesFrom(body);
  }
  if (!values) {
    return jsonResponse({ error: "INFORME VALORES VÁLIDOS (NÃO NEGATIVOS) NA FOLHA." }, 400);
  }

  const existing = await database
    .prepare("SELECT id FROM hr_payroll_entries WHERE employee_id=?1 AND month=?2 LIMIT 1")
    .bind(employeeId, month)
    .first<{ id: string }>();
  if (existing && editId && existing.id !== editId) {
    return jsonResponse({ error: "JÁ EXISTE UMA FOLHA DESSE FUNCIONÁRIO NESSA COMPETÊNCIA." }, 409);
  }
  const targetId = editId || existing?.id || "";

  if (targetId) {
    await database
      .prepare(
        `UPDATE hr_payroll_entries
         SET employee_name=?1, company_id=?2, company_name=?3, month=?4, base_salary_cents=?5,
             bonus_cents=?6, overtime_cents=?7, additions_cents=?8, deductions_cents=?9,
             other_cents=?10, notes=?11, updated_by=?12, updated_by_name=?13,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=?14`,
      )
      .bind(
        employee.fullName,
        employee.companyId,
        employee.companyName,
        month,
        values.baseSalaryCents,
        values.bonusCents,
        values.overtimeCents,
        values.additionsCents,
        values.deductionsCents,
        values.otherCents,
        notes,
        actor.id,
        actorName(actor),
        targetId,
      )
      .run();
    return jsonResponse({ updated: true, id: targetId });
  }

  const id = crypto.randomUUID();
  await database
    .prepare(
      `INSERT INTO hr_payroll_entries
        (id, employee_id, employee_name, company_id, company_name, month, base_salary_cents,
         bonus_cents, overtime_cents, additions_cents, deductions_cents, other_cents, notes,
         payment_done, payment_date, attachment_file_name, attachment_r2_key,
         attachment_size_bytes, created_by, created_by_name, created_at, updated_by,
         updated_by_name, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, '', '', '', 0,
               ?14, ?15, CURRENT_TIMESTAMP, ?14, ?15, CURRENT_TIMESTAMP)`,
    )
    .bind(
      id,
      employeeId,
      employee.fullName,
      employee.companyId,
      employee.companyName,
      month,
      values.baseSalaryCents,
      values.bonusCents,
      values.overtimeCents,
      values.additionsCents,
      values.deductionsCents,
      values.otherCents,
      notes,
      actor.id,
      actorName(actor),
    )
    .run();
  return jsonResponse({ created: true, id }, 201);
}

/**
 * Copia a folha inteira de um mês para outro (botão "copiar do mês
 * anterior"). Funcionários que já têm lançamento no mês de destino são
 * preservados — nunca sobrescreve valor já digitado.
 */
async function copyPreviousMonth(database: Database, actor: Identity, body: JsonMap) {
  const month = safeText(body.month, 7);
  const fromMonth = safeText(body.fromMonth, 7);
  const companyId = safeText(body.companyId, 80);
  if (!MONTH_PATTERN.test(month) || !MONTH_PATTERN.test(fromMonth)) {
    return jsonResponse({ error: "INFORME MESES VÁLIDOS (AAAA-MM)." }, 400);
  }
  if (month === fromMonth) {
    return jsonResponse({ error: "O MÊS DE ORIGEM E O DE DESTINO SÃO IGUAIS." }, 400);
  }

  const companyCondition = companyId ? "AND company_id=?2" : "";
  const params = companyId ? [fromMonth, companyId] : [fromMonth];
  const sourceResult = await database
    .prepare(`SELECT ${ENTRY_COLUMNS} FROM hr_payroll_entries WHERE month=?1 ${companyCondition}`)
    .bind(...params)
    .all<EntryRow>();
  const sources = sourceResult.results ?? [];
  if (!sources.length) {
    return jsonResponse({ error: "NÃO HÁ FOLHA LANÇADA NO MÊS DE ORIGEM." }, 404);
  }

  const existingResult = await database
    .prepare("SELECT employee_id AS employeeId FROM hr_payroll_entries WHERE month=?1")
    .bind(month)
    .all<{ employeeId: string }>();
  const alreadyThere = new Set((existingResult.results ?? []).map((row) => row.employeeId));

  const pending = sources.filter((source) => !alreadyThere.has(source.employeeId));
  if (!pending.length) {
    return jsonResponse({ copied: 0, skipped: sources.length });
  }

  await database.batch(
    pending.map((source) =>
      database
        .prepare(
          `INSERT INTO hr_payroll_entries
            (id, employee_id, employee_name, company_id, company_name, month, base_salary_cents,
             bonus_cents, overtime_cents, additions_cents, deductions_cents, other_cents, notes,
             payment_done, payment_date, attachment_file_name, attachment_r2_key,
             attachment_size_bytes, created_by, created_by_name, created_at, updated_by,
             updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, '', '', '', 0,
                   ?14, ?15, CURRENT_TIMESTAMP, ?14, ?15, CURRENT_TIMESTAMP)`,
        )
        .bind(
          crypto.randomUUID(),
          source.employeeId,
          source.employeeName,
          source.companyId,
          source.companyName,
          month,
          Number(source.baseSalaryCents || 0),
          Number(source.bonusCents || 0),
          Number(source.overtimeCents || 0),
          Number(source.additionsCents || 0),
          Number(source.deductionsCents || 0),
          Number(source.otherCents || 0),
          source.notes || "",
          actor.id,
          actorName(actor),
        ),
    ),
  );
  return jsonResponse({ copied: pending.length, skipped: sources.length - pending.length });
}

async function markPaid(database: Database, actor: Identity, body: JsonMap) {
  const id = safeText(body.id, 80);
  if (!id) return jsonResponse({ error: "FOLHA INVÁLIDA." }, 400);
  const paymentDone = body.paymentDone === false ? 0 : 1;
  const paymentDate = safeText(body.paymentDate, 10);
  if (paymentDone && paymentDate && !DATE_PATTERN.test(paymentDate)) {
    return jsonResponse({ error: "INFORME UMA DATA DE PAGAMENTO VÁLIDA (AAAA-MM-DD)." }, 400);
  }

  const existing = await database
    .prepare("SELECT id FROM hr_payroll_entries WHERE id=?1 LIMIT 1")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return jsonResponse({ error: "FOLHA NÃO ENCONTRADA." }, 404);

  // Marcar como pago só fecha a folha do funcionário. A integração com a
  // DRE/Contas a Pagar (lançar a folha como despesa) é uma fase futura
  // possível, fora do escopo desta.
  await database
    .prepare(
      `UPDATE hr_payroll_entries
       SET payment_done=?1, payment_date=?2, updated_by=?3, updated_by_name=?4,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=?5`,
    )
    .bind(paymentDone, paymentDone ? paymentDate : "", actor.id, actorName(actor), id)
    .run();
  return jsonResponse({ updated: true, id, paymentDone });
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR A FOLHA DE PAGAMENTO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 30);
    const database = await getD1();
    if (action === "mark_paid") return await markPaid(database, actor, body);
    if (action === "copy_previous_month") return await copyPreviousMonth(database, actor, body);
    if (action && action !== "save") return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    return await saveEntry(database, actor, body);
  } catch (error) {
    console.error("Não foi possível salvar a folha de pagamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A FOLHA DE PAGAMENTO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR LANÇAMENTOS DA FOLHA." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "FOLHA INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT attachment_r2_key AS attachmentR2Key FROM hr_payroll_entries WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ attachmentR2Key: string }>();
    if (!existing) return jsonResponse({ error: "FOLHA NÃO ENCONTRADA." }, 404);
    await database.prepare("DELETE FROM hr_payroll_entries WHERE id=?1").bind(id).run();
    if (existing.attachmentR2Key) {
      const bucket = await documentsBucket();
      await bucket.delete(existing.attachmentR2Key).catch(() => undefined);
    }
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o lançamento da folha.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O LANÇAMENTO DA FOLHA." }, 500);
  }
}
