import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  actorName,
  canManagePayroll,
  centsValue,
  identity,
  jsonResponse,
  loadEmployee,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// DESCONTO RECORRENTE da Folha (03/11/2026, migration 0124): valor mensal por
// funcionário de start_month até end_month ('' = sem fim). Entra no DESCONTO
// da folha de cada mês na leitura (entries/rows.ts), somado ao avulso.
// ENCERRAR para a partir de uma competência (os meses anteriores ficam como
// estavam); EXCLUIR apaga de todos os meses (para lançamento errado).

function addMonths(month: string, count: number) {
  const [year, monthIndex] = month.split("-").map(Number);
  const total = year * 12 + (monthIndex - 1) + count;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

const COLUMNS = `id, employee_id AS employeeId, description, amount_cents AS amountCents,
  start_month AS startMonth, end_month AS endMonth, created_by_name AS createdByName, created_at AS createdAt`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR A FOLHA DE PAGAMENTO." }, 403);
  const employeeId = safeText(new URL(request.url).searchParams.get("employeeId"), 80);
  if (!employeeId) return jsonResponse({ error: "SELECIONE O FUNCIONÁRIO." }, 400);
  try {
    const database = await getD1();
    const rows = await database
      .prepare(`SELECT ${COLUMNS} FROM hr_recurring_deductions WHERE employee_id=?1 ORDER BY start_month DESC, created_at DESC`)
      .bind(employeeId)
      .all();
    return jsonResponse({ deductions: rows.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os descontos recorrentes.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS DESCONTOS RECORRENTES." }, 500);
  }
}

/** Cria: { employeeId, description, amountCents, startMonth, months? (vazio/0 = sem fim) }. */
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR A FOLHA DE PAGAMENTO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const employeeId = safeText(body.employeeId, 80);
    const description = safeText(body.description, 120);
    const amountCents = centsValue(body.amountCents);
    const startMonth = safeText(body.startMonth, 7);
    const months = Number(body.months || 0);
    if (!employeeId) return jsonResponse({ error: "SELECIONE O FUNCIONÁRIO." }, 400);
    if (description.length < 2) return jsonResponse({ error: "INFORME A DESCRIÇÃO DO DESCONTO." }, 400);
    if (!Number.isFinite(amountCents) || amountCents <= 0) return jsonResponse({ error: "INFORME O VALOR MENSAL DO DESCONTO." }, 400);
    if (!MONTH_PATTERN.test(startMonth)) return jsonResponse({ error: "INFORME O MÊS DE INÍCIO (AAAA-MM)." }, 400);
    if (!Number.isInteger(months) || months < 0 || months > 120) return jsonResponse({ error: "QUANTIDADE DE MESES INVÁLIDA (0 A 120)." }, 400);
    const database = await getD1();
    if (!(await loadEmployee(database, employeeId))) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);
    const id = crypto.randomUUID();
    const endMonth = months ? addMonths(startMonth, months - 1) : "";
    await database
      .prepare(
        `INSERT INTO hr_recurring_deductions
          (id, employee_id, description, amount_cents, start_month, end_month, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP, ?7, ?8, CURRENT_TIMESTAMP)`,
      )
      .bind(id, employeeId, description, amountCents, startMonth, endMonth, actor.id, actorName(actor))
      .run();
    return jsonResponse({ created: true, id, endMonth }, 201);
  } catch (error) {
    console.error("Não foi possível gravar o desconto recorrente.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GRAVAR O DESCONTO RECORRENTE." }, 500);
  }
}

/** ENCERRAR: { id, fromMonth } — deixa de descontar a partir de fromMonth. */
export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR A FOLHA DE PAGAMENTO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const fromMonth = safeText(body.fromMonth, 7);
    if (!MONTH_PATTERN.test(fromMonth)) return jsonResponse({ error: "INFORME A COMPETÊNCIA (AAAA-MM)." }, 400);
    const database = await getD1();
    const row = await database
      .prepare("SELECT start_month AS startMonth, end_month AS endMonth FROM hr_recurring_deductions WHERE id=?1")
      .bind(id)
      .first<{ startMonth: string; endMonth: string }>();
    if (!row) return jsonResponse({ error: "DESCONTO NÃO ENCONTRADO." }, 404);
    if (fromMonth <= row.startMonth) {
      return jsonResponse({ error: "O DESCONTO COMEÇA NESTA COMPETÊNCIA — USE EXCLUIR." }, 409);
    }
    const endMonth = addMonths(fromMonth, -1);
    if (row.endMonth && row.endMonth <= endMonth) return jsonResponse({ error: "O DESCONTO JÁ TERMINA ANTES DESTA COMPETÊNCIA." }, 409);
    await database
      .prepare("UPDATE hr_recurring_deductions SET end_month=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4")
      .bind(endMonth, actor.id, actorName(actor), id)
      .run();
    return jsonResponse({ updated: true, id, endMonth });
  } catch (error) {
    console.error("Não foi possível encerrar o desconto recorrente.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ENCERRAR O DESCONTO RECORRENTE." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA LANÇAR A FOLHA DE PAGAMENTO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "DESCONTO INVÁLIDO." }, 400);
  try {
    const database = await getD1();
    await database.prepare("DELETE FROM hr_recurring_deductions WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o desconto recorrente.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O DESCONTO RECORRENTE." }, 500);
  }
}
