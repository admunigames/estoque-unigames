import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";
import { matchParticipant, trackProgress } from "../../../../lib/academy";
import { canAccessCommercial, identity, jsonResponse } from "../../shared";
import {
  ACADEMY_SITE_URL,
  AcademyError,
  academyConfigured,
  canManageAcademyTeam,
  loadAppUser,
  loadCatalog,
  loadLinks,
  loadPeople,
  loadProgress,
} from "../shared";

// Comercial > Treinamento: catálogo da Unigames Academy + o progresso do
// PRÓPRIO login (participante vinculado manualmente ou casado por usuário/
// nome). Qualquer permissão comercial:* entra.
export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessCommercial(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O TREINAMENTO." }, 403);
  }
  if (!academyConfigured()) return jsonResponse({ configured: false, academyUrl: ACADEMY_SITE_URL });
  try {
    const database = await getD1();
    const [catalog, people, links, user, canManageTeam] = await Promise.all([
      loadCatalog(),
      loadPeople(),
      loadLinks(database),
      loadAppUser(database, actor.id),
      canManageAcademyTeam(database, actor),
    ]);
    const participant = user
      ? matchParticipant(people, { id: user.id, username: user.username, displayName: user.displayName }, links)
      : null;
    const progress = participant ? await loadProgress(participant.id) : null;
    return jsonResponse({
      configured: true,
      academyUrl: ACADEMY_SITE_URL,
      canManageTeam,
      catalog,
      participant,
      progress,
      tracks: trackProgress(catalog, progress ? progress.completed.map((row) => row.lessonId) : []),
    });
  } catch (error) {
    if (error instanceof AcademyError) return jsonResponse({ error: error.message }, 502);
    console.error("Não foi possível carregar o treinamento.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O TREINAMENTO." }, 500);
  }
}
