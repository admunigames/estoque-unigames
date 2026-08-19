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

type ItemRow = {
  id: string;
  categoryId: string;
  name: string;
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
        `SELECT id, category_id AS categoryId, name, position,
                created_by AS createdBy, created_by_name AS createdByName,
                created_at AS createdAt
         FROM finance_items
         ORDER BY position ASC, name ASC`,
      )
      .all<ItemRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os itens financeiros.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS ITENS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR ITENS." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const name = safeText(body.name, 120);
    const categoryId = safeText(body.categoryId, 80);
    if (name.length < 2) {
      return jsonResponse({ error: "INFORME O NOME DO ITEM." }, 400);
    }
    if (!categoryId) {
      return jsonResponse({ error: "SELECIONE A CATEGORIA DO ITEM." }, 400);
    }

    const database = await getD1();
    const category = await database
      .prepare("SELECT id FROM finance_categories WHERE id=?1")
      .bind(categoryId)
      .first<{ id: string }>();
    if (!category) {
      return jsonResponse({ error: "CATEGORIA NÃO ENCONTRADA." }, 400);
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_items
          (id, category_id, name, position, created_by, created_by_name, created_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, CURRENT_TIMESTAMP)`,
      )
      .bind(id, categoryId, name, actor.id, actor.displayName || "Administrador")
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar o item financeiro.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR O ITEM." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR ITENS." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "ITEM INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const entries = await database
      .prepare("SELECT COUNT(*) AS total FROM finance_store_entries WHERE item_id=?1")
      .bind(id)
      .first<{ total: number }>();
    if (Number(entries?.total ?? 0) > 0) {
      return jsonResponse(
        {
          error:
            "ESTE ITEM JÁ TEM LANÇAMENTOS REGISTRADOS E NÃO PODE SER EXCLUÍDO (HISTÓRICO É PRESERVADO).",
        },
        409,
      );
    }
    await database.prepare("DELETE FROM finance_items WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o item financeiro.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O ITEM." }, 500);
  }
}
