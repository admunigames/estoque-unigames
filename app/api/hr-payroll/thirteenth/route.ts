import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  DATE_PATTERN,
  actorName,
  canManagePayroll,
  centsValue,
  identity,
  isOneOf,
  jsonResponse,
  loadEmployee,
  safeText,
  sameOrigin,
  type Database,
  type Identity,
  type JsonMap,
} from "../shared";

// 13º salário — anual, por funcionário. Parcela: 'adiantamento' | 'final'
// | 'unico'. Independente da folha mensal. Líquido = bruto − descontos.

const INSTALLMENTS = ["adiantamento", "final", "unico"] as const;
const YEAR_PATTERN = /^\d{4}$/;

type Row = {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  year: string;
  installment: string;
  grossCents: number;
  deductionsCents: number;
  paymentDone: number;
  paymentDate: string;
  notes: string;
};

const COLUMNS = `id, employee_id AS employeeId, employee_name AS employeeName,
  company_id AS companyId, company_name AS companyName, year, installment,
  gross_cents AS grossCents, deductions_cents AS deductionsCents,
  payment_done AS paymentDone, payment_date AS paymentDate, notes`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O 13º SALÁRIO." }, 403);
  }

  const url = new URL(request.url);
  const year = safeText(url.searchParams.get("year"), 4);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  if (year && !YEAR_PATTERN.test(year)) {
    return jsonResponse({ error: "INFORME UM ANO VÁLIDO (AAAA)." }, 400);
  }

  try {
    const database = await getD1();
    const conditions: string[] = [];
    const params: string[] = [];
    if (year) {
      params.push(year);
      conditions.push(`year=?${params.length}`);
    }
    if (companyId) {
      params.push(companyId);
      conditions.push(`company_id=?${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await database
      .prepare(`SELECT ${COLUMNS} FROM hr_thirteenth_salary ${where} ORDER BY employee_name ASC, installment ASC`)
      .bind(...params)
      .all<Row>();
    const rows = (result.results ?? []).map((row) => ({
      ...row,
      netCents: Number(row.grossCents || 0) - Number(row.deductionsCents || 0),
    }));
    return jsonResponse({
      year,
      entries: rows,
      totalGrossCents: rows.reduce((sum, row) => sum + Number(row.grossCents || 0), 0),
      totalNetCents: rows.reduce((sum, row) => sum + row.netCents, 0),
    });
  } catch (error) {
    console.error("Não foi possível carregar o 13º salário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O 13º SALÁRIO." }, 500);
  }
}

async function markPaid(database: Database, actor: Identity, body: JsonMap) {
  const id = safeText(body.id, 80);
  if (!id) return jsonResponse({ error: "LANÇAMENTO INVÁLIDO." }, 400);
  const paymentDone = body.paymentDone === false ? 0 : 1;
  const paymentDate = safeText(body.paymentDate, 10);
  if (paymentDone && paymentDate && !DATE_PATTERN.test(paymentDate)) {
    return jsonResponse({ error: "INFORME UMA DATA DE PAGAMENTO VÁLIDA (AAAA-MM-DD)." }, 400);
  }
  const existing = await database
    .prepare("SELECT id FROM hr_thirteenth_salary WHERE id=?1 LIMIT 1")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);
  await database
    .prepare(
      `UPDATE hr_thirteenth_salary
       SET payment_done=?1, payment_date=?2, updated_by=?3, updated_by_name=?4, updated_at=CURRENT_TIMESTAMP
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
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR O 13º SALÁRIO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const database = await getD1();
    if (safeText(body.action, 20) === "mark_paid") return await markPaid(database, actor, body);

    const editId = safeText(body.id, 80);
    const employeeId = safeText(body.employeeId, 80);
    const year = safeText(body.year, 4);
    const installment = safeText(body.installment, 20);
    const notes = safeText(body.notes, 500);
    const grossCents = centsValue(body.grossCents);
    const deductionsCents = body.deductionsCents === undefined || body.deductionsCents === null || body.deductionsCents === ""
      ? 0
      : centsValue(body.deductionsCents);

    if (!employeeId) return jsonResponse({ error: "SELECIONE O FUNCIONÁRIO." }, 400);
    if (!YEAR_PATTERN.test(year)) return jsonResponse({ error: "INFORME UM ANO VÁLIDO (AAAA)." }, 400);
    if (!isOneOf(INSTALLMENTS, installment)) {
      return jsonResponse({ error: "SELECIONE A PARCELA (ADIANTAMENTO, FINAL OU ÚNICO)." }, 400);
    }
    if (!Number.isFinite(grossCents) || grossCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR BRUTO MAIOR QUE ZERO." }, 400);
    }
    if (!Number.isFinite(deductionsCents) || deductionsCents < 0) {
      return jsonResponse({ error: "O DESCONTO NÃO PODE SER NEGATIVO." }, 400);
    }
    if (deductionsCents > grossCents) {
      return jsonResponse({ error: "O DESCONTO NÃO PODE SER MAIOR QUE O VALOR BRUTO." }, 400);
    }

    const employee = await loadEmployee(database, employeeId);
    if (!employee) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);

    const clash = await database
      .prepare(
        "SELECT id FROM hr_thirteenth_salary WHERE employee_id=?1 AND year=?2 AND installment=?3 AND id<>?4 LIMIT 1",
      )
      .bind(employeeId, year, installment, editId || "")
      .first<{ id: string }>();
    if (clash) {
      return jsonResponse({ error: "JÁ EXISTE ESSA PARCELA DE 13º DESSE FUNCIONÁRIO NESSE ANO." }, 409);
    }

    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM hr_thirteenth_salary WHERE id=?1 LIMIT 1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "LANÇAMENTO NÃO ENCONTRADO." }, 404);
      await database
        .prepare(
          `UPDATE hr_thirteenth_salary
           SET employee_id=?1, employee_name=?2, company_id=?3, company_name=?4, year=?5,
               installment=?6, gross_cents=?7, deductions_cents=?8, notes=?9,
               updated_by=?10, updated_by_name=?11, updated_at=CURRENT_TIMESTAMP
           WHERE id=?12`,
        )
        .bind(
          employeeId,
          employee.fullName,
          employee.companyId,
          employee.companyName,
          year,
          installment,
          grossCents,
          deductionsCents,
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
        `INSERT INTO hr_thirteenth_salary
          (id, employee_id, employee_name, company_id, company_name, year, installment,
           gross_cents, deductions_cents, payment_done, payment_date, notes, created_by,
           created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, '', ?10, ?11, ?12, CURRENT_TIMESTAMP,
                 ?11, ?12, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        employeeId,
        employee.fullName,
        employee.companyId,
        employee.companyName,
        year,
        installment,
        grossCents,
        deductionsCents,
        notes,
        actor.id,
        actorName(actor),
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o 13º salário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O 13º SALÁRIO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR O 13º SALÁRIO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "LANÇAMENTO INVÁLIDO." }, 400);
  try {
    const database = await getD1();
    await database.prepare("DELETE FROM hr_thirteenth_salary WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o 13º salário.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O 13º SALÁRIO." }, 500);
  }
}
