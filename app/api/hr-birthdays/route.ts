import { unauthorizedResponse } from "../../lib/notion";
import {
  BIRTH_DATE_PATTERN,
  EMPLOYEE_BIRTHDAY_COLUMNS,
  canManageBirthdays,
  canViewBirthdays,
  identity,
  jsonResponse,
  resolveBirthdayStatus,
  safeText,
  saoPauloToday,
  sameOrigin,
  type EmployeeBirthdayRow,
  type Identity,
  type JsonMap,
} from "./shared";
import { getD1 } from "../../../db";

// GET lista todos os colaboradores ativos com status de aniversário
// calculado; PATCH atualiza a data de nascimento de um colaborador e/ou
// marca "Feito" (chocolate entregue) para o ano corrente.

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewBirthdays(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR OS ANIVERSARIANTES." }, 403);
  }

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT ${EMPLOYEE_BIRTHDAY_COLUMNS} FROM hr_employees WHERE status='active' ORDER BY full_name ASC`,
      )
      .all<EmployeeBirthdayRow>();

    const today = saoPauloToday();
    const employees = (result.results ?? []).map((employee) => ({
      ...employee,
      birthMonth: BIRTH_DATE_PATTERN.test(employee.birthDate) ? Number(employee.birthDate.slice(5, 7)) : 0,
      status: resolveBirthdayStatus(employee.birthDate, employee.birthdayAcknowledgedYear, today),
    }));

    return jsonResponse({ employees, today });
  } catch (error) {
    console.error("Não foi possível carregar os aniversariantes.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS ANIVERSARIANTES." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor: Identity = identity(request);
  if (!canManageBirthdays(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA GERENCIAR OS ANIVERSARIANTES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const employeeId = safeText(body.employeeId, 80);
    if (!employeeId) return jsonResponse({ error: "COLABORADOR INVÁLIDO." }, 400);

    const database = await getD1();
    const employee = await database
      .prepare("SELECT id FROM hr_employees WHERE id=?1 AND status='active' LIMIT 1")
      .bind(employeeId)
      .first<{ id: string }>();
    if (!employee) return jsonResponse({ error: "COLABORADOR NÃO ENCONTRADO." }, 404);

    const updates: string[] = [];
    const bindings: (string | number)[] = [];

    if (typeof body.birthDate === "string") {
      const birthDate = safeText(body.birthDate, 10);
      if (birthDate && !BIRTH_DATE_PATTERN.test(birthDate)) {
        return jsonResponse({ error: "INFORME UMA DATA DE NASCIMENTO VÁLIDA (AAAA-MM-DD)." }, 400);
      }
      bindings.push(birthDate);
      updates.push(`birth_date=?${bindings.length}`);
    }

    if (body.acknowledge === true) {
      const today = saoPauloToday();
      bindings.push(today.year);
      updates.push(`birthday_acknowledged_year=?${bindings.length}`);
    } else if (body.acknowledge === false) {
      bindings.push(0);
      updates.push(`birthday_acknowledged_year=?${bindings.length}`);
    }

    if (!updates.length) return jsonResponse({ error: "NADA PARA ATUALIZAR." }, 400);

    bindings.push(employeeId);
    await database
      .prepare(`UPDATE hr_employees SET ${updates.join(", ")} WHERE id=?${bindings.length}`)
      .bind(...bindings)
      .run();

    return jsonResponse({ updated: true, id: employeeId });
  } catch (error) {
    console.error("Não foi possível atualizar o aniversariante.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR O ANIVERSARIANTE." }, 500);
  }
}
