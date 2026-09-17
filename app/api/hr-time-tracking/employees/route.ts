import { unauthorizedResponse } from "../../../lib/notion";
import { canViewTimeTracking, identity, jsonResponse, loadActiveEmployees } from "../shared";

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewTimeTracking(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O CONTROLE DE HORAS." }, 403);
  }

  try {
    const employees = await loadActiveEmployees();
    return jsonResponse({ employees });
  } catch (error) {
    console.error("Não foi possível carregar os colaboradores.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS COLABORADORES." }, 500);
  }
}
