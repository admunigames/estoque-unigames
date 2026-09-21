import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canViewUniformStock, identity, jsonResponse } from "../shared";

// Lista simples de colaboradores ativos para o seletor de saída/devolução.
// Rota própria (em vez de reaproveitar app/api/hr-payroll/employees) para
// não acoplar o Fardamento à permissão do RH Financeiro — quem tem só
// rh_fardamento:view/:manage já pode escolher o colaborador.

type EmployeeOption = { id: string; fullName: string; companyId: string; companyName: string };

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewUniformStock(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FARDAMENTO." }, 403);
  }

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, full_name AS fullName, company_id AS companyId, company_name AS companyName
         FROM hr_employees WHERE status='active' ORDER BY full_name ASC`,
      )
      .all<EmployeeOption>();
    return jsonResponse({ employees: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os colaboradores.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS COLABORADORES." }, 500);
  }
}
