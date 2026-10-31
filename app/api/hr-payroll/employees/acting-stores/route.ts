import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { actingStoreFor } from "../../../../lib/acting-store";
import { todayInTimezone } from "../../../../lib/finance-status";
import { loadCompanyList } from "../../../finance/shared";
import {
  saveActingStoreMonth,
  canEmployees,
  canSeeEmployees,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../../shared";

// LOJA ATUANTE por mês (RH > Funcionários): tabela MÊS → LOJA gravada em
// hr_schedule_assignments (fonte única com as Escalas). Mês sem registro herda
// o último anterior; sem nenhum, a loja de admissão — app/lib/acting-store.ts.
// Ao gravar/remover um mês: os lançamentos do RH desse mês até o próximo mês
// com registro passam para a loja do mês, e a loja ATUAL do cadastro
// acompanha a loja atuante do mês corrente. Meses anteriores não mudam.

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canSeeEmployees(actor)) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER OS FUNCIONÁRIOS." }, 403);
  const employeeId = safeText(new URL(request.url).searchParams.get("employeeId"), 80);
  if (!employeeId) return jsonResponse({ error: "FUNCIONÁRIO INVÁLIDO." }, 400);
  try {
    const database = await getD1();
    const rows = await database
      .prepare(
        `SELECT reference_month AS month, company_id AS companyId, company_name AS companyName,
                updated_by_name AS updatedByName, updated_at AS updatedAt
         FROM hr_schedule_assignments WHERE employee_id=?1 AND company_id <> '' ORDER BY reference_month DESC`,
      )
      .bind(employeeId)
      .all();
    const currentMonth = todayInTimezone().slice(0, 7);
    return jsonResponse({ months: rows.results ?? [], currentMonth, current: await actingStoreFor(database, employeeId, currentMonth) });
  } catch (error) {
    console.error("Não foi possível carregar a loja atuante.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A LOJA ATUANTE." }, 500);
  }
}

async function applyMonth(request: Request, remove: boolean) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canEmployees(actor, "edit")) return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR FUNCIONÁRIOS." }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const url = new URL(request.url);
    const body = remove ? ({} as JsonMap) : ((await request.json()) as JsonMap);
    const employeeId = safeText(remove ? url.searchParams.get("employeeId") : body.employeeId, 80);
    const month = safeText(remove ? url.searchParams.get("month") : body.month, 7);
    if (!employeeId) return jsonResponse({ error: "FUNCIONÁRIO INVÁLIDO." }, 400);
    if (!MONTH_PATTERN.test(month)) return jsonResponse({ error: "INFORME O MÊS (AAAA-MM)." }, 400);
    const database = await getD1();
    const employee = await database
      .prepare("SELECT id, full_name AS fullName FROM hr_employees WHERE id=?1")
      .bind(employeeId)
      .first<{ id: string; fullName: string }>();
    if (!employee) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);

    let store: { companyId: string; companyName: string } | null = null;
    if (!remove) {
      const companyId = safeText(body.companyId, 80);
      if (!companyId) return jsonResponse({ error: "ESCOLHA A LOJA DO MÊS." }, 400);
      const companies = await loadCompanyList(database);
      const companyName = companyId === "assistencia" ? "Assistência" : companies.find((item) => item.id === companyId)?.name;
      if (!companyName) return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
      store = { companyId, companyName };
    }
    const current = await saveActingStoreMonth(database, actor, { employeeId, employeeName: employee.fullName, month, store });
    return jsonResponse({ saved: true, employeeId, month, current });
  } catch (error) {
    console.error("Não foi possível gravar a loja atuante.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL GRAVAR A LOJA ATUANTE." }, 500);
  }
}

export async function PUT(request: Request) {
  return applyMonth(request, false);
}

export async function DELETE(request: Request) {
  return applyMonth(request, true);
}
