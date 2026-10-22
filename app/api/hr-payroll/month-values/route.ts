import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  canManagePayroll,
  identity,
  isMonthValueKind,
  jsonResponse,
  MONTH_PATTERN,
  safeText,
  sameOrigin,
  upsertMonthValueStatement,
  type JsonMap,
} from "../shared";

// Valores MANUAIS por funcionário e competência (decisão do usuário,
// 22/10/2026): DSR (Folha e CUSTO TOTAL POR FUNCIONÁRIO) e INSS (DRE
// Funcionário). GET lista o mês; PUT grava em lote (um ou vários, colados da
// planilha) — 0 apaga o valor do funcionário.

const MAX_VALUES = 1000;
const MAX_CENTS = 100_000_000;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canManagePayroll(identity(request))) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RH FINANCEIRO." }, 403);
  const url = new URL(request.url);
  const month = safeText(url.searchParams.get("month"), 7);
  const kind = safeText(url.searchParams.get("kind"), 10);
  if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  if (!isMonthValueKind(kind)) return jsonResponse({ error: "TIPO DE VALOR INVÁLIDO." }, 400);
  try {
    const database = await getD1();
    const rows = await database
      .prepare(
        `SELECT employee_id AS employeeId, employee_name AS employeeName, amount_cents AS amountCents,
                updated_by_name AS updatedByName, updated_at AS updatedAt
         FROM hr_employee_month_values WHERE month=?1 AND kind=?2 ORDER BY employee_name`,
      )
      .bind(month, kind)
      .all();
    return jsonResponse({ month, kind, values: rows.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os valores do mês.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS VALORES DO MÊS." }, 500);
  }
}

export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RH FINANCEIRO." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const month = safeText(body.month, 7);
    const kind = safeText(body.kind, 10);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
    if (!isMonthValueKind(kind)) return jsonResponse({ error: "TIPO DE VALOR INVÁLIDO." }, 400);
    const values = Array.isArray(body.values) ? (body.values as JsonMap[]) : [];
    if (!values.length) return jsonResponse({ error: "NENHUM VALOR PARA GRAVAR." }, 400);
    if (values.length > MAX_VALUES) return jsonResponse({ error: `NO MÁXIMO ${MAX_VALUES} FUNCIONÁRIOS POR VEZ.` }, 400);

    const database = await getD1();
    const employees = await database
      .prepare("SELECT id, full_name AS fullName FROM hr_employees")
      .all<{ id: string; fullName: string }>();
    const names = new Map((employees.results ?? []).map((row) => [row.id, row.fullName]));
    const statements = [];
    for (const [index, entry] of values.entries()) {
      const employeeId = safeText(entry?.employeeId, 80);
      const amountCents = Number(entry?.amountCents);
      if (!names.has(employeeId)) return jsonResponse({ error: `LINHA ${index + 1}: FUNCIONÁRIO NÃO ENCONTRADO.` }, 400);
      if (!Number.isInteger(amountCents) || amountCents < 0 || amountCents > MAX_CENTS) {
        return jsonResponse({ error: `LINHA ${index + 1}: VALOR INVÁLIDO.` }, 400);
      }
      statements.push(
        upsertMonthValueStatement(database, { employeeId, employeeName: names.get(employeeId) ?? "", month, kind, amountCents }, actor),
      );
    }
    await database.batch(statements);
    return jsonResponse({ saved: statements.length, month, kind });
  } catch (error) {
    console.error("Não foi possível gravar os valores do mês.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GRAVAR OS VALORES DO MÊS." }, 500);
  }
}
