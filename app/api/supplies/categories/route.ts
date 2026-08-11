import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";

type JsonMap = Record<string, unknown>;
type Identity = { id: string; displayName: string; role: "admin" | "user" };

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
  };
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

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;

  try {
    const database = await getD1();
    const result = await database
      .prepare(
        `SELECT id, name, created_at AS createdAt, updated_at AS updatedAt
         FROM supply_categories ORDER BY name ASC`,
      )
      .all<{ id: string; name: string; createdAt: string; updatedAt: string }>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as categorias de insumos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS CATEGORIAS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (actor.role !== "admin") {
    return jsonResponse({ error: "SOMENTE O ADMINISTRADOR PODE GERENCIAR CATEGORIAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const name = safeText(body.name, 120).toUpperCase();
    if (name.length < 2) {
      return jsonResponse({ error: "INFORME O NOME DA CATEGORIA." }, 400);
    }
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM supply_categories WHERE name=?1 LIMIT 1")
      .bind(name)
      .first<{ id: string }>();
    if (existing) {
      return jsonResponse({ error: "JÁ EXISTE UMA CATEGORIA COM ESSE NOME." }, 409);
    }
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO supply_categories (id, name, created_at, updated_at)
         VALUES (?1, ?2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(id, name)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível criar a categoria de insumo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CRIAR A CATEGORIA." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (actor.role !== "admin") {
    return jsonResponse({ error: "SOMENTE O ADMINISTRADOR PODE GERENCIAR CATEGORIAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const name = safeText(body.name, 120).toUpperCase();
    if (!id) return jsonResponse({ error: "CATEGORIA INVÁLIDA." }, 400);
    if (name.length < 2) {
      return jsonResponse({ error: "INFORME O NOME DA CATEGORIA." }, 400);
    }
    const database = await getD1();
    const duplicate = await database
      .prepare("SELECT id FROM supply_categories WHERE name=?1 AND id<>?2 LIMIT 1")
      .bind(name, id)
      .first<{ id: string }>();
    if (duplicate) {
      return jsonResponse({ error: "JÁ EXISTE UMA CATEGORIA COM ESSE NOME." }, 409);
    }
    await database
      .prepare(
        `UPDATE supply_categories SET name=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2`,
      )
      .bind(name, id)
      .run();
    return jsonResponse({ updated: true });
  } catch (error) {
    console.error("Não foi possível atualizar a categoria de insumo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR A CATEGORIA." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (actor.role !== "admin") {
    return jsonResponse({ error: "SOMENTE O ADMINISTRADOR PODE GERENCIAR CATEGORIAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    if (!id) return jsonResponse({ error: "CATEGORIA INVÁLIDA." }, 400);
    const database = await getD1();
    const inUse = await database
      .prepare("SELECT id FROM supply_products WHERE category_id=?1 LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (inUse) {
      return jsonResponse(
        { error: "EXCLUA OU MOVA OS PRODUTOS DESTA CATEGORIA ANTES DE EXCLUÍ-LA." },
        409,
      );
    }
    await database.prepare("DELETE FROM supply_categories WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true, id });
  } catch (error) {
    console.error("Não foi possível excluir a categoria de insumo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A CATEGORIA." }, 500);
  }
}
