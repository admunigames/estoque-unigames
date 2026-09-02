import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  MONTH_PATTERN,
  canManagePayroll,
  identity,
  jsonResponse,
  loadEmployee,
  safeText,
  workingDaysForEmployee,
} from "../shared";

// Prévia dos dias úteis de um funcionário numa competência — usado pela
// tela de Benefícios para calcular ao vivo o valor de um benefício pago
// por dia trabalhado.

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManagePayroll(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RH FINANCEIRO." }, 403);
  }

  const url = new URL(request.url);
  const employeeId = safeText(url.searchParams.get("employeeId"), 80);
  const month = safeText(url.searchParams.get("month"), 7);
  if (!employeeId) return jsonResponse({ error: "SELECIONE O FUNCIONÁRIO." }, 400);
  if (!MONTH_PATTERN.test(month)) {
    return jsonResponse({ error: "INFORME UM MÊS VÁLIDO (AAAA-MM)." }, 400);
  }

  try {
    const database = await getD1();
    const employee = await loadEmployee(database, employeeId);
    if (!employee) return jsonResponse({ error: "FUNCIONÁRIO NÃO ENCONTRADO." }, 404);
    const workingDays = await workingDaysForEmployee(database, employee, month);
    return jsonResponse({
      employeeId,
      month,
      workSchedule: employee.workSchedule || "5x2",
      workingDays,
    });
  } catch (error) {
    console.error("Não foi possível calcular os dias úteis.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CALCULAR OS DIAS ÚTEIS." }, 500);
  }
}
