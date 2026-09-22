import { unauthorizedResponse } from "../../../lib/notion";
import { canViewSchedules, identity, jsonResponse, loadActiveEmployees } from "../shared";

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewSchedules(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR ESCALAS E FOLGAS." }, 403);
  }

  try {
    const employees = await loadActiveEmployees();
    return jsonResponse({ employees });
  } catch (error) {
    console.error("Não foi possível carregar os colaboradores.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS COLABORADORES." }, 500);
  }
}
