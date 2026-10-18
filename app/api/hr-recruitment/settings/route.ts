import { getD1 } from "../../../../db";
import { RECRUITMENT_PENDING_DEFAULTS, recruitmentPendingTexts } from "../../../lib/hr-rh";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  actorName,
  canManageRecruitment,
  canViewRecruitment,
  identity,
  jsonResponse,
  loadPendingTexts,
  sameOrigin,
  type JsonMap,
} from "../shared";

// Texto da pendência que vai no aviso (push + tarefa) de cada status do
// Recrutamento. Vazio = só aviso, sem tarefa.

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canViewRecruitment(identity(request))) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O RECRUTAMENTO E SELEÇÃO." }, 403);
  }
  try {
    return jsonResponse({ pendingTexts: await loadPendingTexts(await getD1()), defaults: RECRUITMENT_PENDING_DEFAULTS });
  } catch (error) {
    console.error("Não foi possível carregar os textos das pendências.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS TEXTOS DAS PENDÊNCIAS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRecruitment(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR OS TEXTOS DAS PENDÊNCIAS." }, 403);
  }
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  try {
    const body = (await request.json()) as JsonMap;
    const texts = recruitmentPendingTexts(body.pendingTexts);
    const value = JSON.stringify(Object.fromEntries(Object.entries(texts).map(([status, text]) => [status, text.toLocaleUpperCase("pt-BR")])));
    await (await getD1())
      .prepare(
        `INSERT INTO hr_settings (key, value_json, updated_by, updated_by_name, updated_at)
         VALUES ('recruitment_pending_texts', ?1, ?2, ?3, ?4)
         ON CONFLICT (key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by,
           updated_by_name=excluded.updated_by_name, updated_at=excluded.updated_at`,
      )
      .bind(value, actor.id, actorName(actor), new Date().toISOString())
      .run();
    return jsonResponse({ saved: true, pendingTexts: JSON.parse(value) });
  } catch (error) {
    console.error("Não foi possível salvar os textos das pendências.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR OS TEXTOS DAS PENDÊNCIAS." }, 500);
  }
}
