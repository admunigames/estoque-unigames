import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canManageFinance, identity, jsonResponse, safeText, sameOrigin, type JsonMap } from "../shared";

type SupplierRow = {
  id: string;
  name: string;
  document: string;
  notes: string;
  active: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA ACESSAR O FINANCEIRO." }, 403);
  }

  const url = new URL(request.url);
  const includeInactive = url.searchParams.get("includeInactive") === "1";

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, name, document, notes, active,
                created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt
         FROM finance_suppliers
         ${includeInactive ? "" : "WHERE active=1"}
         ORDER BY name ASC`,
      )
      .all<SupplierRow>();
    return jsonResponse({ suppliers: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os fornecedores.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS FORNECEDORES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageFinance(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR FORNECEDORES." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const name = safeText(body.name, 160);
    const document = safeText(body.document, 40);
    const notes = safeText(body.notes, 2000);
    const active = body.active === false ? 0 : 1;
    if (name.length < 2) return jsonResponse({ error: "INFORME O NOME DO FORNECEDOR." }, 400);

    const database = await getD1();

    if (id) {
      const existing = await database
        .prepare("SELECT id FROM finance_suppliers WHERE id=?1")
        .bind(id)
        .first<{ id: string }>();
      if (!existing) return jsonResponse({ error: "FORNECEDOR NÃO ENCONTRADO." }, 404);
      await database
        .prepare(
          `UPDATE finance_suppliers
           SET name=?1, document=?2, notes=?3, active=?4,
               updated_by=?5, updated_by_name=?6, updated_at=CURRENT_TIMESTAMP
           WHERE id=?7`,
        )
        .bind(name, document, notes, active, actor.id, actor.displayName || "Administrador", id)
        .run();
      return jsonResponse({ updated: true, id });
    }

    const newId = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO finance_suppliers
          (id, name, document, notes, active, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP, ?6, ?7, CURRENT_TIMESTAMP)`,
      )
      .bind(newId, name, document, notes, active, actor.id, actor.displayName || "Administrador")
      .run();
    return jsonResponse({ created: true, id: newId }, 201);
  } catch (error) {
    console.error("Não foi possível salvar o fornecedor.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL SALVAR O FORNECEDOR." }, 500);
  }
}
