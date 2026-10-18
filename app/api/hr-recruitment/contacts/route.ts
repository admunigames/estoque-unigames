import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  actorName,
  canManageRecruitment,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  uuidIsValid,
  type JsonMap,
} from "../shared";

// Aba CONTATOS do Recrutamento: edita nome e telefone de vários candidatos
// de uma vez (lista NOME - CONTATO dos selecionados para entrevista).

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EDITAR CANDIDATOS." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const items = (Array.isArray(body.items) ? body.items : [])
      .map((item) => (item && typeof item === "object" ? (item as JsonMap) : {}))
      .map((item) => ({
        id: safeText(item.id, 80),
        fullName: safeText(item.fullName, 160).toLocaleUpperCase("pt-BR"),
        phone: safeText(item.phone, 40),
      }))
      .filter((item) => uuidIsValid(item.id))
      .slice(0, 300);
    if (!items.length) return jsonResponse({ error: "NADA PARA SALVAR." }, 400);
    if (items.some((item) => !item.fullName)) return jsonResponse({ error: "INFORME O NOME DE TODOS OS CANDIDATOS." }, 400);
    const database = await getD1();
    await database.batch(items.map((item) =>
      database
        .prepare(
          `UPDATE hr_recruitment_candidates SET full_name=?1, phone=?2, updated_by=?3, updated_by_name=?4,
             updated_at=CURRENT_TIMESTAMP WHERE id=?5`,
        )
        .bind(item.fullName, item.phone, actor.id, actorName(actor), item.id)));
    return jsonResponse({ saved: items.length });
  } catch (error) {
    console.error("Não foi possível salvar os contatos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR OS CONTATOS." }, 500);
  }
}
