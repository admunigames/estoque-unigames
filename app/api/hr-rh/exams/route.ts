import { getD1 } from "../../../../db";
import { loadExamStatus } from "../../../lib/hr-alerts";
import { recifeToday } from "../../../lib/hr-rh";
import { unauthorizedResponse } from "../../../lib/notion";
import { identity, jsonResponse, rhCan } from "../shared";

// RH > Painel do RH > Exames a vencer — último ASO de cada funcionário ATIVO
// (vencimento = exame + 12 meses, editável no lançamento do ASO), com a
// situação: SEM EXAME, VENCIDO, 7, 15 ou 30 dias.

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!rhCan(identity(request), "rh_exames:view")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER O VENCIMENTO DOS EXAMES." }, 403);
  }
  try {
    const today = recifeToday();
    return jsonResponse({ today, exams: await loadExamStatus(await getD1(), today) });
  } catch (error) {
    console.error("Não foi possível carregar o vencimento dos exames.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O VENCIMENTO DOS EXAMES." }, 500);
  }
}
