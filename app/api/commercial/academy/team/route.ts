import { trackProgress } from "../../../../lib/academy";
import { jsonResponse, safeText } from "../../shared";
import { AcademyError, loadCatalog, loadProgress, scopedTeam, teamGuard } from "../shared";

// Treinamento da equipe (gestor = comercial:goals, sem ser conta de
// vendedor). Sem participantId: lista da equipe + logins para vincular. Com
// participantId: o progresso daquela pessoa — fora do escopo = mesmo 404.
export async function GET(request: Request) {
  try {
    const ctx = await teamGuard(request);
    if (ctx instanceof Response) return ctx;
    const team = await scopedTeam(ctx.database, ctx.scope);
    const participantId = safeText(new URL(request.url).searchParams.get("participantId"), 120);
    if (participantId) {
      const person = team.people.find((row) => row.id === participantId);
      if (!person) return jsonResponse({ error: "PARTICIPANTE NÃO ENCONTRADO." }, 404);
      const [catalog, progress] = await Promise.all([loadCatalog(), loadProgress(person.id)]);
      return jsonResponse({
        participant: person,
        progress,
        tracks: trackProgress(catalog, progress.completed.map((row) => row.lessonId)),
      });
    }
    return jsonResponse({
      people: team.people.map((person) => {
        const linked = team.userByParticipant.get(person.id);
        return {
          ...person,
          linkedUser: linked ? { id: linked.id, name: linked.displayName || linked.username, manual: linked.manual } : null,
        };
      }),
      users: team.users.map((user) => ({
        id: user.id,
        name: user.displayName || user.username,
        companyName: team.companyNames.get(user.companyId) || "",
      })),
    });
  } catch (error) {
    if (error instanceof AcademyError) return jsonResponse({ error: error.message }, 502);
    console.error("Não foi possível carregar o treinamento da equipe.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O TREINAMENTO DA EQUIPE." }, 500);
  }
}
