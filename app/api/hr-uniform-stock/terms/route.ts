import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  TERM_COLUMNS,
  actorName,
  canManageUniformStock,
  canViewUniformStock,
  identity,
  isTermStatus,
  jsonResponse,
  safeText,
  sameOrigin,
  uuidIsValid,
  type Identity,
  type JsonMap,
  type TermRow,
} from "../shared";

// Termo de Responsabilidade dos casacos — listagem (aba dedicada dentro de
// Casacos) e atualização de status. O registro em si é criado
// automaticamente pelo POST de app/api/hr-uniform-stock/movements (1 termo
// por saída de casaco); aqui só consultamos e avançamos o status.

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canViewUniformStock(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FARDAMENTO." }, 403);
  }

  try {
    const url = new URL(request.url);
    const status = safeText(url.searchParams.get("status"), 30);
    const employeeId = safeText(url.searchParams.get("employeeId"), 80);

    const conditions: string[] = [];
    const bindings: string[] = [];
    if (status && isTermStatus(status)) {
      bindings.push(status);
      conditions.push(`status=?${bindings.length}`);
    }
    if (employeeId) {
      bindings.push(employeeId);
      conditions.push(`employee_id=?${bindings.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const database = await getD1();
    const query = `SELECT ${TERM_COLUMNS} FROM uniform_coat_terms ${where} ORDER BY created_at DESC LIMIT 500`;
    const result = bindings.length
      ? await database.prepare(query).bind(...bindings).all<TermRow>()
      : await database.prepare(query).all<TermRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os termos de responsabilidade.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS TERMOS." }, 500);
  }
}

export async function PUT(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor: Identity = identity(request);
  if (!canManageUniformStock(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ATUALIZAR O TERMO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const status = safeText(body.status, 30);
    if (!uuidIsValid(id)) return jsonResponse({ error: "TERMO INVÁLIDO." }, 400);
    if (!isTermStatus(status)) return jsonResponse({ error: "SITUAÇÃO INVÁLIDA." }, 400);

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM uniform_coat_terms WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return jsonResponse({ error: "TERMO NÃO ENCONTRADO." }, 404);

    await database
      .prepare(
        `UPDATE uniform_coat_terms
         SET status=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP
         WHERE id=?4`,
      )
      .bind(status, actor.id, actorName(actor), id)
      .run();
    return jsonResponse({ updated: true, id });
  } catch (error) {
    console.error("Não foi possível atualizar o termo de responsabilidade.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR O TERMO." }, 500);
  }
}
