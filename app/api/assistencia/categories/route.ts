import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { isUniqueViolation, parseCategory } from "../../../lib/assistencia";
import { canManage, FORBIDDEN, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";

// Aba CATEGORIAS: categorias da tabela de valores. A tabela de valores guarda o
// NOME da categoria (texto), então renomear atualiza os defeitos no mesmo
// batch. Orçamentos salvos mantêm a cópia antiga. Sem excluir — só desativar.

type CategoryRow = { id: string; name: string; asksModel: number; active: number; sortOrder: number };

const CATEGORY_SELECT = `
  SELECT id, name, asks_model AS asksModel, active, sort_order AS sortOrder FROM assist_categories`;

function duplicateMessage(name: string) {
  return `JÁ EXISTE A CATEGORIA ${name}.`;
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  if (!canManage(identity(request))) return jsonResponse({ error: FORBIDDEN }, 403);
  try {
    const database = await getD1();
    const result = await database.prepare(`${CATEGORY_SELECT} ORDER BY sort_order, name`).all<CategoryRow>();
    return jsonResponse({
      categories: (result.results ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        asksModel: Number(row.asksModel) === 1,
        active: Number(row.active) === 1,
        sortOrder: Number(row.sortOrder) || 0,
      })),
    });
  } catch (error) {
    console.error("Não foi possível carregar as categorias da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS CATEGORIAS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManage(actor)) return jsonResponse({ error: FORBIDDEN }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  let duplicate = "";
  try {
    const parsed = parseCategory((await request.json()) as JsonMap);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const category = parsed.category;
    duplicate = duplicateMessage(category.name);
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM assist_categories WHERE name=?1 LIMIT 1")
      .bind(category.name)
      .first<{ id: string }>();
    if (existing) return jsonResponse({ error: duplicate }, 409);
    const order = await database
      .prepare("SELECT MAX(sort_order) AS maxOrder FROM assist_categories")
      .first<{ maxOrder: number | string | null }>();
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    await database
      .prepare(
        `INSERT INTO assist_categories
          (id, name, asks_model, active, sort_order, created_by, created_by_name, created_at,
           updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?5, ?6, ?7)`,
      )
      .bind(id, category.name, category.asksModel ? 1 : 0, (Number(order?.maxOrder) || 0) + 1,
        actor.id, actor.displayName, at)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    if (duplicate && isUniqueViolation(error)) return jsonResponse({ error: duplicate }, 409);
    console.error("Não foi possível cadastrar a categoria da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A CATEGORIA." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManage(actor)) return jsonResponse({ error: FORBIDDEN }, 403);
  if (!sameOrigin(request)) return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  let duplicate = "";
  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const database = await getD1();
    const current = id
      ? await database.prepare(`${CATEGORY_SELECT} WHERE id=?1 LIMIT 1`).bind(id).first<CategoryRow>()
      : null;
    if (!current) return jsonResponse({ error: "CATEGORIA NÃO ENCONTRADA." }, 404);
    const parsed = parseCategory(body);
    if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
    const category = parsed.category;
    duplicate = duplicateMessage(category.name);
    const clash = await database
      .prepare("SELECT id FROM assist_categories WHERE name=?1 AND id<>?2 LIMIT 1")
      .bind(category.name, id)
      .first<{ id: string }>();
    if (clash) return jsonResponse({ error: duplicate }, 409);
    const at = new Date().toISOString();
    await database.batch([
      database
        .prepare(
          `UPDATE assist_categories SET name=?1, asks_model=?2, active=?3, updated_by=?4, updated_by_name=?5,
             updated_at=?6 WHERE id=?7`,
        )
        .bind(category.name, category.asksModel ? 1 : 0, category.active ? 1 : 0, actor.id, actor.displayName, at, id),
      database.prepare("UPDATE assist_defects SET category=?1 WHERE category=?2").bind(category.name, current.name),
    ]);
    return jsonResponse({ updated: true });
  } catch (error) {
    if (duplicate && isUniqueViolation(error)) return jsonResponse({ error: duplicate }, 409);
    console.error("Não foi possível editar a categoria da assistência.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR A CATEGORIA." }, 500);
  }
}
