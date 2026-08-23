import { getD1 } from "../../../../../db";
import { unauthorizedResponse } from "../../../../lib/notion";

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

function decodedHeader(request: Request, name: string) {
  const value = request.headers.get(name) || "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function identity(request: Request): Identity {
  return {
    id: safeText(request.headers.get("x-unigames-user-id"), 80),
    displayName: decodedHeader(request, "x-unigames-display-name").slice(0, 80),
    role: request.headers.get("x-unigames-role") === "admin" ? "admin" : "user",
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

function canManageRequests(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("loans:manage_requests");
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

type UpdateRow = {
  id: string;
  requestId: string;
  message: string;
  authorName: string;
  createdAt: string;
};

const UPDATE_SELECT = `
  SELECT id, request_id AS requestId, message, author_name AS authorName, created_at AS createdAt
  FROM loan_request_updates`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRequests(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER ESTAS ATUALIZAÇÕES." }, 403);
  }

  const url = new URL(request.url);
  const requestId = safeText(url.searchParams.get("requestId"), 80);
  if (!requestId) return jsonResponse({ error: "SOLICITAÇÃO INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    const result = await database
      .prepare(`${UPDATE_SELECT} WHERE request_id=?1 ORDER BY created_at ASC`)
      .bind(requestId)
      .all<UpdateRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as atualizações da solicitação.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS ATUALIZAÇÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRequests(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA RESPONDER ESTA SOLICITAÇÃO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const requestId = safeText(body.requestId, 80);
    const message = safeText(body.message, 2000);
    if (!requestId) return jsonResponse({ error: "SOLICITAÇÃO INVÁLIDA." }, 400);
    if (!message) return jsonResponse({ error: "ESCREVA UMA MENSAGEM." }, 400);

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM loan_requests WHERE id=?1 LIMIT 1")
      .bind(requestId)
      .first<{ id: string }>();
    if (!existing) {
      return jsonResponse({ error: "SOLICITAÇÃO NÃO ENCONTRADA." }, 404);
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO loan_request_updates (id, request_id, message, author_id, author_name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)`,
      )
      .bind(id, requestId, message, actor.id, actor.displayName)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível registrar a atualização da solicitação.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR A ATUALIZAÇÃO." }, 500);
  }
}
