import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { MONTH_PATTERN } from "../../../lib/commercial";
import {
  actorName,
  canMarkCommercialNewcomer,
  commercialScope,
  identity,
  jsonResponse,
  linkedEmployeeIds,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

// NOVATO no mês (seletor do Dashboard): o vendedor recebe só a % do
// faturamento. Vale só para o mês marcado e fica fora de commercial_monthly
// (a importação apaga e reinsere o mês). comercial:goals ou comercial:rules,
// dentro do escopo de loja do overview; vendedor de outra loja = 404.
// Conta vinculada a um vendedor nunca marca novatos (nem a si mesma), mesmo
// com a permissão.
export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canMarkCommercialNewcomer(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA MARCAR NOVATOS." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scope = commercialScope(actor);
  if (!scope) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const employeeId = safeText(body.employeeId, 80);
    const month = safeText(body.month, 7);
    if (!employeeId || !MONTH_PATTERN.test(month) || typeof body.newcomer !== "boolean") {
      return jsonResponse({ error: "DADOS INVÁLIDOS." }, 400);
    }
    const database = await getD1();
    if ((await linkedEmployeeIds(database, actor.id)).length) {
      return jsonResponse({ error: "CONTA DE VENDEDOR NÃO PODE MARCAR NOVATOS." }, 403);
    }
    const employee = await database
      .prepare("SELECT company_id AS companyId FROM hr_employees WHERE id=?1")
      .bind(employeeId)
      .first<{ companyId: string | null }>();
    if (!employee || (!scope.allStores && employee.companyId !== scope.companyId)) {
      return jsonResponse({ error: "VENDEDOR NÃO ENCONTRADO." }, 404);
    }
    await (body.newcomer
      ? database
        .prepare(
          `INSERT INTO commercial_newcomers (id, employee_id, month, marked_by, marked_by_name, marked_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (employee_id, month) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), employeeId, month, actor.id, actorName(actor), new Date().toISOString())
      : database
        .prepare("DELETE FROM commercial_newcomers WHERE employee_id=?1 AND month=?2")
        .bind(employeeId, month)
    ).run();
    return jsonResponse({ employeeId, month, newcomer: body.newcomer });
  } catch (error) {
    console.error("Não foi possível marcar o novato.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A MARCAÇÃO DE NOVATO." }, 500);
  }
}
