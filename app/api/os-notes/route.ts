import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../lib/access-scope";
import { documentsBucket } from "../documents/shared";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  companyId: string;
  permissions: string[];
};
type OsNoteStatus = "pending" | "attached";
type OsNoteRow = {
  id: string;
  osId: string;
  companyId: string;
  companyName: string;
  requesterName: string;
  status: OsNoteStatus;
  fileName: string;
  r2Key: string;
  sizeBytes: number;
  attachedByName: string;
  attachedAt: string;
  fileRemovedAt: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedByName: string;
  updatedAt: string;
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

function can(actor: Identity, permission: string) {
  return actor.role === "admin" || actor.permissions.includes(permission);
}

function canAccessOsNotes(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.some((permission) => permission.startsWith("os_notes:"))
  );
}

// Admin sempre vê todas as lojas. Usuário sem loja vinculada mas com
// qualquer permissão de notas de O.S. também — a ausência de loja só
// bloqueia quem também não tem permissão do módulo.
function canSeeAllOsNoteStores(actor: Identity) {
  return actor.role === "admin" || (!hasCompany(actor.companyId) && canAccessOsNotes(actor));
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

function scopedCompany(actor: Identity, requestedCompanyId: string) {
  if (!canSeeAllOsNoteStores(actor)) return actor.companyId;
  return COMPANY_PATTERN.test(requestedCompanyId) ? requestedCompanyId : "";
}

function toRow(row: OsNoteRow) {
  return {
    id: row.id,
    osId: row.osId,
    companyId: row.companyId,
    companyName: row.companyName,
    requesterName: row.requesterName,
    status: row.status,
    fileName: row.fileName,
    hasFile: Boolean(row.r2Key),
    sizeBytes: row.sizeBytes,
    attachedByName: row.attachedByName,
    attachedAt: row.attachedAt,
    fileRemovedAt: row.fileRemovedAt,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    viewUrl: row.r2Key ? `/api/os-notes/file?id=${encodeURIComponent(row.id)}` : "",
    downloadUrl: row.r2Key
      ? `/api/os-notes/file?id=${encodeURIComponent(row.id)}&download=1`
      : "",
  };
}

const OS_NOTE_SELECT = `
  SELECT id, os_id AS osId, company_id AS companyId, company_name AS companyName,
         requester_name AS requesterName, status, file_name AS fileName,
         r2_key AS r2Key, size_bytes AS sizeBytes,
         attached_by_name AS attachedByName, attached_at AS attachedAt,
         file_removed_at AS fileRemovedAt,
         created_by AS createdBy, created_by_name AS createdByName,
         created_at AS createdAt, updated_by_name AS updatedByName,
         updated_at AS updatedAt
  FROM os_notes`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessOsNotes(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO ÀS NOTAS DE O.S." }, 403);
  }

  const url = new URL(request.url);
  const requestedCompanyId = safeText(url.searchParams.get("companyId"), 80);
  const companyId = scopedCompany(actor, requestedCompanyId);
  if (!canSeeAllOsNoteStores(actor) && !hasCompany(companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  try {
    const database = await getD1();
    const where: string[] = [];
    const bindings: string[] = [];
    if (companyId) {
      bindings.push(companyId);
      where.push(`company_id=?${bindings.length}`);
    }
    const query = `${OS_NOTE_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`;
    const result = await database
      .prepare(query)
      .bind(...bindings)
      .all<OsNoteRow>();
    return jsonResponse({ notes: (result.results ?? []).map(toRow) });
  } catch (error) {
    console.error("Não foi possível carregar as notas de O.S.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS SOLICITAÇÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "os_notes:create")) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR SOLICITAÇÕES." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const requestedCompanyId = safeText(body.companyId, 80);
    const canChooseCompany = canSeeAllStores(actor, "os_notes:create");
    const companyId = canChooseCompany ? requestedCompanyId : actor.companyId;
    if (!COMPANY_PATTERN.test(companyId)) {
      return jsonResponse(
        { error: canChooseCompany ? "ESCOLHA A LOJA." : NO_COMPANY_ERROR },
        400,
      );
    }
    const osId = safeText(body.osId, 60);
    const requesterName = safeText(body.requesterName, 120);
    if (!osId) {
      return jsonResponse({ error: "INFORME O ID DA O.S." }, 400);
    }
    if (!requesterName) {
      return jsonResponse({ error: "INFORME O RESPONSÁVEL SOLICITANTE." }, 400);
    }

    const database = await getD1();
    const resolvedCompanyName = await companyName(database, companyId);
    if (!resolvedCompanyName) {
      return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
    }
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO os_notes
          (id, os_id, company_id, company_name, requester_name, status,
           created_by, created_by_name, created_at,
           updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, CURRENT_TIMESTAMP, '', '', CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        osId,
        companyId,
        resolvedCompanyName,
        requesterName,
        actor.id,
        actor.displayName || "Usuário",
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a nota de O.S.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A SOLICITAÇÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "os_notes:delete")) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR SOLICITAÇÕES." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }
  const id = safeText(new URL(request.url).searchParams.get("id"), 80);
  if (!id) return jsonResponse({ error: "SOLICITAÇÃO INVÁLIDA." }, 400);

  try {
    const database = await getD1();
    const existing = await database
      .prepare("SELECT r2_key AS r2Key FROM os_notes WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ r2Key: string }>();
    if (!existing) return jsonResponse({ error: "SOLICITAÇÃO NÃO ENCONTRADA." }, 404);

    await database.prepare("DELETE FROM os_notes WHERE id=?1").bind(id).run();
    if (existing.r2Key) {
      const bucket = await documentsBucket();
      await bucket.delete(existing.r2Key).catch((error) => {
        console.error("Solicitação excluída, mas o objeto R2 do anexo ficou órfão.", error);
      });
    }
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a nota de O.S.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A SOLICITAÇÃO." }, 500);
  }
}
