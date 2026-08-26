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

type CostCenterRow = {
  id: string;
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
        `SELECT id, name, position,
                created_by AS createdBy, created_by_name AS createdByName,
                created_at AS createdAt
         FROM finance_cost_centers
         ORDER BY position ASC, name ASC`,
      )
      .all<CostCenterRow>();
    return jsonResponse({ costCenters: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os centros de custo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS CENTROS DE CUSTO." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR CENTROS DE CUSTO." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const name = safeText(body.name, 120);
    const editId = safeText(body.id, 80);
    if (name.length < 2) {
      return jsonResponse({ error: "INFORME O NOME DO CENTRO DE CUSTO." }, 400);
    }

    const database = await getD1();
    const duplicate = await database
      .prepare(
        `SELECT id FROM finance_cost_centers WHERE lower(name)=lower(?1) AND id<>?2`,
      )
      .bind(name, editId || "")
      .first<{ id: string }>();
    if (duplicate) {
      return jsonResponse({ error: "JÁ EXISTE UM CENTRO DE CUSTO COM ESSE NOME." }, 409);
    }

    if (editId) {
      const existing = await database
        .prepare("SELECT id FROM finance_cost_centers WHERE id=?1")
        .bind(editId)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "CENTRO DE CUSTO NÃO ENCONTRADO." }, 404);
      await database
        .prepare("UPDATE finance_cost_centers SET name=?1 WHERE id=?2")
        .bind(name, editId)
        .run();
      return jsonResponse({ updated: true, id: editId });
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_cost_centers
          (id, name, position, created_by, created_by_name, created_at)
         VALUES (?1, ?2, 0, ?3, ?4, CURRENT_TIMESTAMP)`,
      )
      .bind(id, name, actor.id, actor.displayName || "Administrador")
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar o centro de custo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR O CENTRO DE CUSTO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR CENTROS DE CUSTO." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "CENTRO DE CUSTO INVÁLIDO." }, 400);

  try {
    const database = await getD1();
    const [payables, expenses, invoices] = await Promise.all([
      database
        .prepare("SELECT COUNT(*) AS total FROM accounts_payable WHERE cost_center_id=?1")
        .bind(id)
        .first<{ total: number }>(),
      database
        .prepare("SELECT COUNT(*) AS total FROM expenses WHERE cost_center_id=?1")
        .bind(id)
        .first<{ total: number }>(),
      database
        .prepare("SELECT COUNT(*) AS total FROM supplier_invoices WHERE cost_center_id=?1")
        .bind(id)
        .first<{ total: number }>(),
    ]);
    const total =
      Number(payables?.total ?? 0) + Number(expenses?.total ?? 0) + Number(invoices?.total ?? 0);
    if (total > 0) {
      return jsonResponse(
        {
          error:
            "ESTE CENTRO DE CUSTO JÁ TEM LANÇAMENTOS VINCULADOS E NÃO PODE SER EXCLUÍDO (HISTÓRICO É PRESERVADO).",
        },
        409,
      );
    }
    await database.prepare("DELETE FROM finance_cost_centers WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir o centro de custo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O CENTRO DE CUSTO." }, 500);
  }
}
