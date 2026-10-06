import { jsonResponse, safeText, sameOrigin, type JsonMap } from "../../shared";
import { AcademyError, saveLinks, scopedTeam, teamGuard } from "../shared";

// Vínculo manual login × participante da Academy (gestor, no escopo dele).
// participantId vazio = desfaz o vínculo manual (volta ao automático). Um
// participante fica em um login só: vincular tira de quem estava antes.
export async function PUT(request: Request) {
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const ctx = await teamGuard(request);
    if (ctx instanceof Response) return ctx;
    const body = (await request.json().catch(() => ({}))) as JsonMap;
    const userId = safeText(body.userId, 80);
    const participantId = safeText(body.participantId, 120);
    const team = await scopedTeam(ctx.database, ctx.scope);
    if (!team.users.some((user) => user.id === userId)) {
      return jsonResponse({ error: "LOGIN NÃO ENCONTRADO." }, 404);
    }
    if (participantId && !team.people.some((person) => person.id === participantId)) {
      return jsonResponse({ error: "PARTICIPANTE NÃO ENCONTRADO." }, 404);
    }
    const links = Object.fromEntries(
      Object.entries(team.links).filter(([linkedUser, linkedParticipant]) => linkedUser !== userId && linkedParticipant !== participantId),
    );
    if (participantId) links[userId] = participantId;
    await saveLinks(ctx.database, links);
    return jsonResponse({ saved: true, userId, participantId });
  } catch (error) {
    if (error instanceof AcademyError) return jsonResponse({ error: error.message }, 502);
    console.error("Não foi possível salvar o vínculo da Academy.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O VÍNCULO." }, 500);
  }
}
