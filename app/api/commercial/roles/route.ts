import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { NO_COMPANY_ERROR } from "../../../lib/access-scope";
import { MONTH_PATTERN, isCommercialRole } from "../../../lib/commercial";
import {
  actorName,
  canManageCommercialGoals,
  commercialScope,
  employeeInScope,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  syncHrCommissions,
  type JsonMap,
} from "../shared";

// TIPO do colaborador no mês (aba Vendedores, comercial:goals): troca manual
// do tipo que vem do cargo do RH. role '' = volta a seguir o cargo.
//   PUT {month, employeeId, role: '' | 'vendedor' | 'lider' | 'operacional'}
export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageCommercialGoals(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ATUALIZAR OS VENDEDORES." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  const scope = commercialScope(actor);
  if (!scope) return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  try {
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const month = safeText(body.month, 7);
    const role = safeText(body.role, 20);
    if (!MONTH_PATTERN.test(month) || (role && !isCommercialRole(role))) {
      return jsonResponse({ error: "DADOS INVÁLIDOS." }, 400);
    }
    const database = await getD1();
    const employee = await employeeInScope(database, scope, safeText(body.employeeId, 80));
    if (!employee) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);
    await (role
      ? database
        .prepare(
          `INSERT INTO commercial_roles (id, employee_id, month, role, updated_by, updated_by_name, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT (employee_id, month) DO UPDATE SET role=excluded.role, updated_by=excluded.updated_by,
             updated_by_name=excluded.updated_by_name, updated_at=excluded.updated_at`,
        )
        .bind(crypto.randomUUID(), employee.id, month, role, actor.id, actorName(actor), new Date().toISOString())
      : database.prepare("DELETE FROM commercial_roles WHERE employee_id=?1 AND month=?2").bind(employee.id, month)
    ).run();
    await syncHrCommissions(database, month, actor);
    return jsonResponse({ employeeId: employee.id, month, role });
  } catch (error) {
    console.error("Não foi possível salvar o tipo do colaborador.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O TIPO." }, 500);
  }
}
