import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  try {
    const database = await getD1();
    const rows = await database
      .prepare(
        "SELECT company_id AS companyId, company_name AS companyName, employee_count AS employeeCount, updated_at AS updatedAt FROM finance_store_headcount ORDER BY company_id",
      )
      .all();
    return jsonResponse({ rows: rows.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o quadro de funcionários.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O QUADRO DE FUNCIONÁRIOS." }, 500);
  }
}

// Upsert de uma loja por vez — cadastro manual (não conta app_users, ver
// decisão em [[estoque_modulo_despesas_rateio]]).
export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CONFIGURAR O QUADRO DE FUNCIONÁRIOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const companyId = safeText(body.companyId, 80);
    const companyName = safeText(body.companyName, 160);
    if (!companyId) return jsonResponse({ error: "SELECIONE A LOJA." }, 400);
    const employeeCount = Math.trunc(Number(body.employeeCount));
    if (!Number.isFinite(employeeCount) || employeeCount < 0) {
      return jsonResponse({ error: "INFORME UMA QUANTIDADE DE FUNCIONÁRIOS VÁLIDA." }, 400);
    }

    const database = await getD1();
    const actorName = actor.displayName || "Administrador";
    await database
      .prepare(
        `INSERT INTO finance_store_headcount (id, company_id, company_name, employee_count, updated_by, updated_by_name, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,CURRENT_TIMESTAMP)
         ON CONFLICT (company_id) DO UPDATE SET
           company_name=excluded.company_name, employee_count=excluded.employee_count,
           updated_by=excluded.updated_by, updated_by_name=excluded.updated_by_name, updated_at=CURRENT_TIMESTAMP`,
      )
      .bind(crypto.randomUUID(), companyId, companyName, employeeCount, actor.id, actorName)
      .run();

    return jsonResponse({ saved: true });
  } catch (error) {
    console.error("Não foi possível salvar o quadro de funcionários.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O QUADRO DE FUNCIONÁRIOS." }, 500);
  }
}
