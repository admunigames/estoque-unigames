import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import {
  canManageFinance,
  identity,
  jsonResponse,
  safeText,
  sameOrigin,
  type JsonMap,
} from "../shared";

type CategoryRow = {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." },
      403,
    );
  }

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, name, parent_id AS parentId, position,
                created_by AS createdBy, created_by_name AS createdByName,
                created_at AS createdAt
         FROM finance_categories
         ORDER BY position ASC, name ASC`,
      )
      .all<CategoryRow>();
    return jsonResponse({ categories: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as categorias financeiras.", error);
    return jsonResponse(
      { error: "NÃO FOI POSSÍVEL CARREGAR AS CATEGORIAS." },
      500,
    );
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR CATEGORIAS." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const name = safeText(body.name, 120);
    const parentId = safeText(body.parentId, 80);
    const editId = safeText(body.id, 80);
    if (name.length < 2) {
      return jsonResponse({ error: "INFORME O NOME DA CATEGORIA." }, 400);
    }

    const database = await getD1();

    // Renomear: só o nome é editável — mover de categoria pra subgrupo (ou
    // vice-versa) depois de criada não é suportado, pra não arriscar violar
    // a regra de 1 nível só de subgrupo; quem precisa disso exclui e
    // recria.
    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM finance_categories WHERE id=?1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "CATEGORIA NÃO ENCONTRADA." }, 404);
      await database
        .prepare("UPDATE finance_categories SET name=?1 WHERE id=?2")
        .bind(name, editId)
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    if (parentId) {
      const parent = await database
        .prepare("SELECT id, parent_id AS parentId FROM finance_categories WHERE id=?1")
        .bind(parentId)
        .first<{ id: string; parentId: string | null }>();
      if (!parent) {
        return jsonResponse({ error: "CATEGORIA SUPERIOR NÃO ENCONTRADA." }, 400);
      }
      if (parent.parentId) {
        return jsonResponse(
          { error: "SÓ É PERMITIDO UM NÍVEL DE SUBGRUPO POR CATEGORIA." },
          400,
        );
      }
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_categories
          (id, name, parent_id, position, created_by, created_by_name, created_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, CURRENT_TIMESTAMP)`,
      )
      .bind(id, name, parentId || null, actor.id, actor.displayName || "Administrador")
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a categoria financeira.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A CATEGORIA." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR CATEGORIAS." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "CATEGORIA INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    const [children, items] = await Promise.all([
      database
        .prepare("SELECT COUNT(*) AS total FROM finance_categories WHERE parent_id=?1")
        .bind(id)
        .first<{ total: number }>(),
      database
        .prepare("SELECT COUNT(*) AS total FROM finance_items WHERE category_id=?1")
        .bind(id)
        .first<{ total: number }>(),
    ]);
    if (Number(children?.total ?? 0) > 0) {
      return jsonResponse(
        { error: "EXCLUA OS SUBGRUPOS DESTA CATEGORIA ANTES DE CONTINUAR." },
        409,
      );
    }
    if (Number(items?.total ?? 0) > 0) {
      return jsonResponse(
        { error: "EXCLUA OS ITENS DESTA CATEGORIA ANTES DE CONTINUAR." },
        409,
      );
    }
    await database.prepare("DELETE FROM finance_categories WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a categoria financeira.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A CATEGORIA." }, 500);
  }
}
