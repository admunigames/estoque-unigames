import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";
import { canSeeAllStores, NO_COMPANY_ERROR, resolveStoreScope } from "../../../lib/access-scope";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  companyId: string;
  permissions: string[];
};

const COMPANY_PATTERN = /^c[a-z0-9]{6,40}$/i;

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
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

function canAccessLoans(actor: Identity) {
  return actor.role === "admin" || actor.permissions.some((permission) => permission.startsWith("loans:"));
}

function canManageRequests(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("loans:manage_requests");
}

function canRequest(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("loans:request");
}

async function companyName(database: D1Database, companyId: string) {
  try {
    const row = await database
      .prepare("SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'")
      .first<{ value: string }>();
    const parsed = row?.value ? JSON.parse(row.value) : [];
    if (!Array.isArray(parsed)) return "";
    const company = parsed.find(
      (item): item is { id: string; name: string } =>
        Boolean(item) &&
        typeof item === "object" &&
        "id" in item &&
        item.id === companyId &&
        "name" in item &&
        typeof item.name === "string",
    );
    return company?.name?.trim().slice(0, 120) || "";
  } catch {
    return "";
  }
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

type RequestRow = {
  id: string;
  deviceId: string;
  deviceName: string;
  companyId: string;
  companyName: string;
  responsibleName: string;
  reason: string;
  status: string;
  createdByName: string;
  createdAt: string;
  separatedByName: string;
  separatedAt: string;
  returnedByName: string;
  returnedAt: string;
};

const REQUEST_SELECT = `
  SELECT id, device_id AS deviceId, device_name AS deviceName,
         company_id AS companyId, company_name AS companyName,
         responsible_name AS responsibleName, reason, status,
         created_by_name AS createdByName, created_at AS createdAt,
         separated_by_name AS separatedByName, separated_at AS separatedAt,
         returned_by_name AS returnedByName, returned_at AS returnedAt
  FROM loan_requests`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessLoans(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO A APARELHOS DE EMPRÉSTIMO." }, 403);
  }

  try {
    const database = await getD1();

    if (canManageRequests(actor)) {
      const result = await database
        .prepare(`${REQUEST_SELECT} ORDER BY (status='requested') DESC, created_at DESC LIMIT 500`)
        .all<RequestRow>();
      return jsonResponse({ requests: result.results ?? [] });
    }

    const scope = resolveStoreScope(actor, "loans:request");
    if (scope.blocked) {
      return jsonResponse({ error: NO_COMPANY_ERROR }, 400);
    }
    if (scope.allStores) {
      const result = await database
        .prepare(`${REQUEST_SELECT} ORDER BY created_at DESC LIMIT 500`)
        .all<RequestRow>();
      return jsonResponse({ requests: result.results ?? [] });
    }
    const result = await database
      .prepare(`${REQUEST_SELECT} WHERE company_id=?1 ORDER BY created_at DESC LIMIT 200`)
      .bind(actor.companyId)
      .all<RequestRow>();
    return jsonResponse({ requests: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as solicitações de aparelho.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS SOLICITAÇÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canRequest(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA SOLICITAR APARELHOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const deviceId = safeText(body.deviceId, 80);
    const responsibleName = safeText(body.responsibleName, 120);
    const reason = safeText(body.reason, 400);

    if (!deviceId) return jsonResponse({ error: "ESCOLHA O APARELHO." }, 400);
    if (!responsibleName) return jsonResponse({ error: "INFORME O RESPONSÁVEL PELA SOLICITAÇÃO." }, 400);
    if (!reason) return jsonResponse({ error: "INFORME O MOTIVO DA SOLICITAÇÃO." }, 400);

    const requestedCompanyId = safeText(body.companyId, 80);
    const companyId = canSeeAllStores(actor, "loans:request") && COMPANY_PATTERN.test(requestedCompanyId)
      ? requestedCompanyId
      : actor.companyId;
    if (!COMPANY_PATTERN.test(companyId)) {
      return jsonResponse(
        { error: canSeeAllStores(actor, "loans:request") ? "ESCOLHA A LOJA." : NO_COMPANY_ERROR },
        400,
      );
    }
    const database = await getD1();
    const resolvedCompanyName = await companyName(database, companyId);
    const device = await database
      .prepare("SELECT id, name, status FROM loan_devices WHERE id=?1 LIMIT 1")
      .bind(deviceId)
      .first<{ id: string; name: string; status: string }>();
    if (!device) {
      return jsonResponse({ error: "APARELHO NÃO ENCONTRADO." }, 404);
    }
    if (device.status !== "available") {
      return jsonResponse({ error: "ESTE APARELHO NÃO ESTÁ DISPONÍVEL NO MOMENTO." }, 409);
    }

    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO loan_requests
          (id, device_id, device_name, company_id, company_name, responsible_name, reason,
           status, created_by, created_by_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'requested', ?8, ?9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(id, deviceId, device.name, companyId, resolvedCompanyName, responsibleName, reason, actor.id, actor.displayName)
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível criar a solicitação de aparelho.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CRIAR A SOLICITAÇÃO." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRequests(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA GERENCIAR SOLICITAÇÕES DE APARELHO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const action = safeText(body.action, 20);
    if (!id) return jsonResponse({ error: "SOLICITAÇÃO INVÁLIDA." }, 400);
    if (action !== "loan" && action !== "return") {
      return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
    }

    const database = await getD1();
    const existing = await database
      .prepare(
        `SELECT id, device_id AS deviceId, device_name AS deviceName,
                company_id AS companyId, company_name AS companyName, status
         FROM loan_requests WHERE id=?1 LIMIT 1`,
      )
      .bind(id)
      .first<{ id: string; deviceId: string; deviceName: string; companyId: string; companyName: string; status: string }>();
    if (!existing) {
      return jsonResponse({ error: "SOLICITAÇÃO NÃO ENCONTRADA." }, 404);
    }

    if (action === "loan") {
      if (existing.status !== "requested") {
        return jsonResponse({ error: "ESTA SOLICITAÇÃO JÁ FOI MARCADA COMO EMPRESTADA." }, 409);
      }
      await database
        .prepare(
          `UPDATE loan_requests
           SET status='loaned', separated_by=?1, separated_by_name=?2,
               separated_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
           WHERE id=?3`,
        )
        .bind(actor.id, actor.displayName, id)
        .run();
      await database
        .prepare(
          `UPDATE loan_devices
           SET status='loaned', current_company_id=?1, current_company_name=?2,
               loaned_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
           WHERE id=?3`,
        )
        .bind(existing.companyId, existing.companyName, existing.deviceId)
        .run();
      return jsonResponse({ updated: true, deviceName: existing.deviceName, companyName: existing.companyName });
    }

    // action === "return": aparelho volta da loja pro local e fica
    // disponível de novo para um novo empréstimo.
    if (existing.status !== "loaned") {
      return jsonResponse({ error: "ESTA SOLICITAÇÃO NÃO ESTÁ COM O APARELHO EMPRESTADO." }, 409);
    }
    await database
      .prepare(
        `UPDATE loan_requests
         SET status='returned', returned_by=?1, returned_by_name=?2,
             returned_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE id=?3`,
      )
      .bind(actor.id, actor.displayName, id)
      .run();
    await database
      .prepare(
        `UPDATE loan_devices
         SET status='available', current_company_id='', current_company_name='',
             loaned_at='', updated_at=CURRENT_TIMESTAMP
         WHERE id=?1`,
      )
      .bind(existing.deviceId)
      .run();
    return jsonResponse({ updated: true, deviceName: existing.deviceName, companyName: existing.companyName });
  } catch (error) {
    console.error("Não foi possível atualizar a solicitação de aparelho.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR A SOLICITAÇÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canManageRequests(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR SOLICITAÇÕES DE APARELHO." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    if (!id) return jsonResponse({ error: "SOLICITAÇÃO INVÁLIDA." }, 400);
    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM loan_requests WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) {
      return jsonResponse({ error: "SOLICITAÇÃO NÃO ENCONTRADA." }, 404);
    }
    await database.prepare("DELETE FROM loan_request_updates WHERE request_id=?1").bind(id).run();
    await database.prepare("DELETE FROM loan_requests WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true, id });
  } catch (error) {
    console.error("Não foi possível excluir a solicitação de aparelho.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A SOLICITAÇÃO." }, 500);
  }
}
