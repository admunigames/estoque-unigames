import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { loadCompanyMap } from "../../../lib/hr-dental-plan-auto";
import { canViewDentalPlan, identity, jsonResponse } from "../shared";

// Lista de colaboradores ativos pro seletor do formulário — CPF e data de
// nascimento vêm junto pra auto-preencher o registro ao escolher o
// colaborador (nunca são gravados em hr_dental_plan, só exibidos). Rota
// própria (em vez de reaproveitar app/api/hr-payroll/employees) pra não
// acoplar o Odontológico à permissão do RH Financeiro.

type EmployeeOption = {
  id: string;
  fullName: string;
  cpf: string;
  birthDate: string;
  companyId: string;
  companyName: string;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewDentalPlan(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O PLANO ODONTOLÓGICO." }, 403);
  }

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, full_name AS fullName, cpf, birth_date AS birthDate,
                COALESCE(NULLIF(admission_company_id, ''), company_id) AS companyId,
                COALESCE(NULLIF(admission_company_name, ''), company_name) AS companyName
         FROM hr_employees WHERE status='active' ORDER BY full_name ASC`,
      )
      .all<EmployeeOption>();
    // Loja CADASTRADA e o CNPJ dela: o formulário preenche a unidade sozinho.
    const companies = await loadCompanyMap(database);
    const employees = (result.results ?? []).map((employee) => {
      const company = companies.get(employee.companyId || "");
      return { ...employee, unitName: company?.name || String(employee.companyName || "").toLocaleUpperCase("pt-BR"), cnpj: company?.cnpj || "" };
    });
    return jsonResponse({ employees });
  } catch (error) {
    console.error("Não foi possível carregar os colaboradores.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS COLABORADORES." }, 500);
  }
}
