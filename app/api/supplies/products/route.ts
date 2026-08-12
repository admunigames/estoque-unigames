import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};

function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function identity(request: Request): Identity {
  return {
    id: safeText(request.headers.get("x-unigames-user-id"), 80),
    displayName: safeText(
      decodeURIComponent(request.headers.get("x-unigames-display-name") || ""),
      80,
    ),
    role: request.headers.get("x-unigames-role") === "admin" ? "admin" : "user",
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

function canAccessSupplies(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.some((permission) => permission.startsWith("supplies:"))
  );
}

function sameOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (fetchSite === "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!origin) return !fetchSite || fetchSite === "none";
  const url = new URL(request.url);
  const allowedOrigins = new Set([url.origin]);
  const forwardedHost =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host")?.trim() ||
    "";
  if (forwardedHost) {
    const forwardedProtocol =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (url.protocol === "http:" ? "http" : "https");
    try {
      allowedOrigins.add(new URL(`${forwardedProtocol}://${forwardedHost}`).origin);
    } catch {
      return false;
    }
  }
  return allowedOrigins.has(origin);
}

function requireManageCatalog(request: Request) {
  const actor = identity(request);
  if (actor.role !== "admin" && !actor.permissions.includes("supplies:manage_catalog")) {
    return {
      actor,
      error: jsonResponse(
        { error: "VOCÊ NÃO TEM PERMISSÃO PARA GERENCIAR PRODUTOS DE INSUMOS." },
        403,
      ),
    };
  }
  return { actor, error: null };
}

function canDeleteProducts(request: Request) {
  const actor = identity(request);
  if (
    actor.role !== "admin" &&
    !actor.permissions.includes("supplies:delete") &&
    !actor.permissions.includes("supplies:manage_catalog")
  ) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR PRODUTOS DE INSUMOS." },
      403,
    );
  }
  return null;
}

type ProductRow = {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  active: number;
  notes: string;
  stockQty: number;
  createdAt: string;
  updatedAt: string;
};

const PRODUCT_SELECT = `
  SELECT sp.id, sp.category_id AS categoryId, sc.name AS categoryName,
         sp.name, sp.active, sp.notes, sp.stock_qty AS stockQty,
         sp.created_at AS createdAt, sp.updated_at AS updatedAt
  FROM supply_products sp
  JOIN supply_categories sc ON sc.id = sp.category_id`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessSupplies(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO AOS INSUMOS." }, 403);
  }

  try {
    const url = new URL(request.url);
    const includeInactive = actor.role === "admin" && url.searchParams.get("all") === "1";
    const database = await getD1();
    const query = includeInactive
      ? `${PRODUCT_SELECT} ORDER BY sc.name ASC, sp.name ASC`
      : `${PRODUCT_SELECT} WHERE sp.active=1 ORDER BY sc.name ASC, sp.name ASC`;
    const result = await database.prepare(query).all<ProductRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar os produtos de insumos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS PRODUTOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const { error } = requireManageCatalog(request);
  if (error) return error;
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const categoryId = safeText(body.categoryId, 80);
    const name = safeText(body.name, 180).toUpperCase();
    const notes = safeText(body.notes, 400);
    const active = body.active === false ? 0 : 1;
    const stockQty = Number.isFinite(Number(body.stockQty)) ? Math.trunc(Number(body.stockQty)) : NaN;

    if (name.length < 2) {
      return jsonResponse({ error: "INFORME O NOME DO PRODUTO." }, 400);
    }
    if (!categoryId) {
      return jsonResponse({ error: "ESCOLHA A CATEGORIA." }, 400);
    }
    if (!Number.isFinite(stockQty)) {
      return jsonResponse({ error: "INFORME A QUANTIDADE FÍSICA INICIAL EM ESTOQUE." }, 400);
    }

    const database = await getD1();
    const category = await database
      .prepare("SELECT id FROM supply_categories WHERE id=?1 LIMIT 1")
      .bind(categoryId)
      .first<{ id: string }>();
    if (!category) {
      return jsonResponse({ error: "CATEGORIA NÃO ENCONTRADA." }, 400);
    }
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO supply_products
          (id, category_id, name, active, notes, stock_qty, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(id, categoryId, name, active, notes, stockQty)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível criar o produto de insumo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CRIAR O PRODUTO." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const { error } = requireManageCatalog(request);
  if (error) return error;
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    if (!id) return jsonResponse({ error: "PRODUTO INVÁLIDO." }, 400);

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM supply_products WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) {
      return jsonResponse({ error: "PRODUTO NÃO ENCONTRADO." }, 404);
    }

    const sets: string[] = [];
    const bindings: (string | number)[] = [];
    let index = 1;

    if (typeof body.name === "string") {
      const name = safeText(body.name, 180).toUpperCase();
      if (name.length < 2) {
        return jsonResponse({ error: "INFORME O NOME DO PRODUTO." }, 400);
      }
      sets.push(`name=?${index++}`);
      bindings.push(name);
    }
    if (typeof body.categoryId === "string" && body.categoryId) {
      const categoryId = safeText(body.categoryId, 80);
      const category = await database
        .prepare("SELECT id FROM supply_categories WHERE id=?1 LIMIT 1")
        .bind(categoryId)
        .first<{ id: string }>();
      if (!category) {
        return jsonResponse({ error: "CATEGORIA NÃO ENCONTRADA." }, 400);
      }
      sets.push(`category_id=?${index++}`);
      bindings.push(categoryId);
    }
    if (typeof body.active === "boolean") {
      sets.push(`active=?${index++}`);
      bindings.push(body.active ? 1 : 0);
    }
    if (typeof body.notes === "string") {
      sets.push(`notes=?${index++}`);
      bindings.push(safeText(body.notes, 400));
    }

    if (!sets.length) {
      return jsonResponse({ error: "NADA PARA ATUALIZAR." }, 400);
    }
    sets.push(`updated_at=CURRENT_TIMESTAMP`);
    bindings.push(id);

    await database
      .prepare(`UPDATE supply_products SET ${sets.join(", ")} WHERE id=?${index}`)
      .bind(...bindings)
      .run();
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível atualizar o produto de insumo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR O PRODUTO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const forbidden = canDeleteProducts(request);
  if (forbidden) return forbidden;
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    if (!id) return jsonResponse({ error: "PRODUTO INVÁLIDO." }, 400);
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM supply_products WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) {
      return jsonResponse({ error: "PRODUTO NÃO ENCONTRADO." }, 404);
    }
    await database.prepare("DELETE FROM supply_products WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true, id });
  } catch (error) {
    console.error("Não foi possível excluir o produto de insumo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O PRODUTO." }, 500);
  }
}
