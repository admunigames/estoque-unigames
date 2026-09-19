import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canViewRecruitment, identity, jsonResponse, safeText, uuidIsValid } from "../shared";

type HistoryRow = {
  id: string;
  candidateId: string;
  fromStatus: string;
  toStatus: string;
  note: string;
  changedBy: string;
  changedByName: string;
  changedAt: string;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RECRUTAMENTO E SELEÇÃO." }, 403);
  }

  const candidateId = safeText(new URL(request.url).searchParams.get("candidateId"), 80);
  if (!uuidIsValid(candidateId)) return jsonResponse({ error: "CANDIDATO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, candidate_id AS candidateId, from_status AS fromStatus, to_status AS toStatus,
                note, changed_by AS changedBy, changed_by_name AS changedByName, changed_at AS changedAt
         FROM hr_recruitment_status_history WHERE candidate_id=?1 ORDER BY changed_at ASC`,
      )
      .bind(candidateId)
      .all<HistoryRow>();
    return jsonResponse({ history: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar o histórico do candidato.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O HISTÓRICO DO CANDIDATO." }, 500);
  }
}
