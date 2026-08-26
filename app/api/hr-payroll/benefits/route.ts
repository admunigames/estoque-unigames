import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  BENEFIT_PAYMENT_METHODS,
  BENEFIT_TYPES,
  canManagePayroll,
  centsValue,
  DATE_PATTERN,
  MONTH_PATTERN,
  actorName,
  identity,
  isOneOf,
  jsonResponse,
  loadEmployee,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Benefícios por competência. Vários lançamentos do mesmo funcionário no
// mesmo mês são permitidos de propósito (alimentação + premiação + ...),
// então não existe restrição de unicidade aqui. O total do mês é o que a
// Folha lê ao vivo (computedBenefitsCentsFor).

type BenefitRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  month: string;
  type: string;
  paymentMethod: string;
  amountCents: number;
  paymentDate: string;
  notes: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

const BENEFIT_COLUMNS = `id, employee_id AS employeeId, employee_name AS employeeName,
  company_id AS companyId, company_name AS companyName, month, type,
  payment_method AS paymentMethod, amount_cents AS amountCents, payment_date AS paymentDate,
  notes, created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR OS BENEFÍCIOS." }, 403);
  }

  const url = new URL(request.url);
  const month = safeText(url.searchParams.get("month"), 7);
  const employeeId = safeText(url.searchParams.get("employeeId"), 80);
  const companyId = safeText(url.searchParams.get("companyId"), 80);
  const type = safeText(url.searchParams.get("type"), 20);
  if (month && !MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }
  if (type && !isOneOf(BENEFIT_TYPES, type)) {
    return jsonResponse({ error: "TIPO DE BENEFÍCIO INVÁLIDO." }, 400);
  }

  try {
    const database = await getD1();
    const conditions: string[] = [];
    const params: string[] = [];
    for (const [column, value] of [
      ["month", month],
      ["employee_id", employeeId],
      ["company_id", companyId],
      ["type", type],
    ] as Array<[string, string]>) {
      if (!value) continue;
      params.push(value);
      conditions.push(`${column}=?${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await database
      .prepare(
        `SELECT ${BENEFIT_COLUMNS} FROM hr_benefits ${where}
         ORDER BY month DESC, employee_name ASC, created_at ASC`,
      )
      .bind(...params)
      .all<BenefitRow>();
    const benefits = result.results ?? [];
    const totalCents = benefits.reduce((sum, row) => sum + Number(row.amountCents || 0), 0);
    return jsonResponse({ benefits, totalCents });
  } catch (error) {
    console.error("Não foi possível carregar os benefícios.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS BENEFÍCIOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR BENEFÍCIOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const editId = safeText(body.id, 80);
    const employeeId = safeText(body.employeeId, 80);
    const month = safeText(body.month, 7);
    const type = safeText(body.type, 20);
    const paymentMethod = safeText(body.paymentMethod, 20);
    const paymentDate = safeText(body.paymentDate, 10);
    const notes = safeText(body.notes, 500);
    const amountCents = centsValue(body.amountCents);

    if (!employeeId) return jsonResponse({ error: "SELECIONE O FUNCIONÁRIO." }, 400);
    if (!MONTH_PATTERN.test(month)) {
      return jsonResponse({ error: "INFORME UMA COMPETÊNCIA VÁLIDA (AAAA-MM)." }, 400);
    }
    if (!isOneOf(BENEFIT_TYPES, type)) {
      return jsonResponse({ error: "SELECIONE UM TIPO DE BENEFÍCIO VÁLIDO." }, 400);
    }
    if (!isOneOf(BENEFIT_PAYMENT_METHODS, paymentMethod)) {
      return jsonResponse({ error: "SELECIONE UMA FORMA DE PAGAMENTO VÁLIDA." }, 400);
    }
    if (paymentDate && !DATE_PATTERN.test(paymentDate)) {
      return jsonResponse({ error: "INFORME UMA DATA DE PAGAMENTO VÁLIDA (AAAA-MM-DD)." }, 400);
    }
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return jsonResponse({ error: "INFORME UM VALOR MAIOR QUE ZERO." }, 400);
    }

    const database = await getD1();
    const employee = await loadEmployee(database, employeeId);
    if (!employee) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);

    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM hr_benefits WHERE id=?1 LIMIT 1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "BENEFÍCIO NÃO ENCONTRADO." }, 404);
      await database
        .prepare(
          `UPDATE hr_benefits
           SET employee_id=?1, employee_name=?2, company_id=?3, company_name=?4, month=?5,
               type=?6, payment_method=?7, amount_cents=?8, payment_date=?9, notes=?10,
               updated_by=?11, updated_by_name=?12, updated_at=CURRENT_TIMESTAMP
           WHERE id=?13`,
        )
        .bind(
          employeeId,
          employee.fullName,
          employee.companyId,
          employee.companyName,
          month,
          type,
          paymentMethod,
          amountCents,
          paymentDate,
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
        `INSERT INTO hr_benefits
          (id, employee_id, employee_name, company_id, company_name, month, type, payment_method,
           amount_cents, payment_date, notes, created_by, created_by_name, created_at,
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
        month,
        type,
        paymentMethod,
        amountCents,
        paymentDate,
        notes,
        actor.id,
        actorName(actor),
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o benefício.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O BENEFÍCIO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR BENEFÍCIOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "BENEFÍCIO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    await database.prepare("DELETE FROM hr_benefits WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o benefício.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O BENEFÍCIO." }, 500);
  }
}
