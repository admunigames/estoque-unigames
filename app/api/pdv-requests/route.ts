import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { canActOnStore, canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../lib/access-scope";

type JsonMap = Record<string, unknown>;
type PdvRequestType =
  | "observation"
  | "payment"
  | "seller"
  | "customer"
  | "product"
  | "markup"
  | "cancellation";
type PdvRequestStatus = "open" | "done" | "not_done" | "doubt";
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  companyId: string;
  permissions: string[];
};
type PdvRequestRow = {
  id: string;
  companyId: string;
  companyName: string;
  type: PdvRequestType;
  saleId: string;
  requesterName: string;
  detailsJson: string;
  status: PdvRequestStatus;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
};

const TYPES: PdvRequestType[] = [
  "observation",
  "payment",
  "seller",
  "customer",
  "product",
  "markup",
  "cancellation",
];
const STATUSES: PdvRequestStatus[] = ["open", "done", "not_done", "doubt"];
const REQUIRED_DETAIL_FIELDS: Record<PdvRequestType, string[]> = {
  observation: ["note"],
  payment: ["currentAmount", "currentMethod", "newAmount", "newMethod"],
  seller: ["sellerName"],
  customer: ["customerInfo"],
  product: ["currentProduct", "newProduct"],
  markup: ["productName", "markupAmount", "finalAmount"],
  cancellation: ["reason"],
};
const ALLOWED_DETAIL_FIELDS: Record<PdvRequestType, string[]> = {
  observation: ["note"],
  payment: ["currentAmount", "currentMethod", "newAmount", "newMethod"],
  seller: ["sellerName"],
  customer: ["customerInfo"],
  product: ["currentProduct", "newProduct", "note"],
  markup: ["productName", "markupAmount", "finalAmount"],
  cancellation: ["reason"],
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

function canAccessPdvRequests(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.some((permission) => permission.startsWith("pdv_requests:"))
  );
}

const PDV_PERMISSIONS = [
  "pdv_requests:view",
  "pdv_requests:create",
  "pdv_requests:status",
  "pdv_requests:delete",
];

// Escopo por loja (regra única de app/lib/access-scope.ts): login com loja
// vinculada só vê/age nas solicitações da própria loja; sem loja + qualquer
// permissão do módulo (ou admin) → todas as lojas.
function seesAllStores(actor: Identity) {
  return PDV_PERMISSIONS.some((permission) => canSeeAllStores(actor, permission));
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

function isPdvRequestType(value: unknown): value is PdvRequestType {
  return typeof value === "string" && (TYPES as string[]).includes(value);
}

function isPdvRequestStatus(value: unknown): value is PdvRequestStatus {
  return typeof value === "string" && (STATUSES as string[]).includes(value);
}

function sanitizedDetails(type: PdvRequestType, rawDetails: unknown) {
  const source =
    rawDetails && typeof rawDetails === "object" ? (rawDetails as JsonMap) : {};
  const details: Record<string, string> = {};
  for (const field of ALLOWED_DETAIL_FIELDS[type]) {
    details[field] = safeText(source[field], 400);
  }
  return details;
}

function missingRequiredDetailField(type: PdvRequestType, details: Record<string, string>) {
  return REQUIRED_DETAIL_FIELDS[type].find((field) => !details[field]);
}

function toRow(row: PdvRequestRow) {
  let details: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.detailsJson);
    if (parsed && typeof parsed === "object") details = parsed;
  } catch {
    details = {};
  }
  return {
    id: row.id,
    companyId: row.companyId,
    companyName: row.companyName,
    type: row.type,
    saleId: row.saleId,
    requesterName: row.requesterName,
    details,
    status: row.status,
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    updatedBy: row.updatedBy,
    updatedByName: row.updatedByName,
    updatedAt: row.updatedAt,
  };
}

const PDV_REQUEST_SELECT = `
  SELECT id, company_id AS companyId, company_name AS companyName,
         type, sale_id AS saleId, requester_name AS requesterName,
         details_json AS detailsJson, status,
         created_by AS createdBy, created_by_name AS createdByName,
         created_at AS createdAt, updated_by AS updatedBy,
         updated_by_name AS updatedByName, updated_at AS updatedAt
  FROM pdv_change_requests`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessPdvRequests(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO ÀS ALTERAÇÕES PDV." }, 403);
  }

  try {
    const allStores = seesAllStores(actor);
    if (!allStores && !hasCompany(actor.companyId)) {
      return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
    }
    const database = await getD1();
    const order = "ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC";
    const result = allStores
      ? await database.prepare(`${PDV_REQUEST_SELECT} ${order}`).all<PdvRequestRow>()
      : await database
          .prepare(`${PDV_REQUEST_SELECT} WHERE company_id=?1 ${order}`)
          .bind(actor.companyId)
          .all<PdvRequestRow>();
    return jsonResponse({ requests: (result.results ?? []).map(toRow), allStores });
  } catch (error) {
    console.error("Não foi possível carregar as alterações PDV.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS SOLICITAÇÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "pdv_requests:create")) {
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
    const type = body.type;
    if (!isPdvRequestType(type)) {
      return jsonResponse({ error: "ESCOLHA UM TIPO DE ALTERAÇÃO VÁLIDO." }, 400);
    }
    const saleId = safeText(body.saleId, 60);
    const requesterName = safeText(body.requesterName, 120);
    if (!saleId) {
      return jsonResponse({ error: "INFORME O ID DA VENDA." }, 400);
    }
    if (!requesterName) {
      return jsonResponse({ error: "INFORME O RESPONSÁVEL SOLICITANTE." }, 400);
    }
    const details = sanitizedDetails(type, body.details);
    const missingField = missingRequiredDetailField(type, details);
    if (missingField) {
      return jsonResponse(
        { error: "PREENCHA TODOS OS CAMPOS OBRIGATÓRIOS DO TIPO DE ALTERAÇÃO ESCOLHIDO." },
        400,
      );
    }

    // Login com loja grava sempre na própria loja (ignora o que vier do
    // cliente); sem loja escolhe a loja no formulário.
    const canChooseCompany = canSeeAllStores(actor, "pdv_requests:create");
    const companyId = canChooseCompany ? safeText(body.companyId, 80) : actor.companyId;
    if (!hasCompany(companyId)) {
      return jsonResponse(
        { error: canChooseCompany ? "ESCOLHA A LOJA." : NO_COMPANY_ERROR },
        400,
      );
    }

    const database = await getD1();
    const resolvedCompanyName = await companyName(database, companyId);
    if (!resolvedCompanyName) {
      return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
    }
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO pdv_change_requests
          (id, company_id, company_name, type, sale_id, requester_name, details_json, status,
           created_by, created_by_name, created_at,
           updated_by, updated_by_name, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8, ?9, CURRENT_TIMESTAMP, '', '', CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        companyId,
        resolvedCompanyName,
        type,
        saleId,
        requesterName,
        JSON.stringify(details),
        actor.id,
        actor.displayName || "Usuário",
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível cadastrar a alteração PDV.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CADASTRAR A SOLICITAÇÃO." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "pdv_requests:status")) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA ALTERAR O STATUS DESTA SOLICITAÇÃO." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    const status = body.status;
    if (!id) return jsonResponse({ error: "SOLICITAÇÃO INVÁLIDA." }, 400);
    if (!isPdvRequestStatus(status)) {
      return jsonResponse({ error: "ESCOLHA UM STATUS VÁLIDO." }, 400);
    }

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id, company_id AS companyId FROM pdv_change_requests WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ id: string; companyId: string }>();
    // Solicitação de outra loja responde igual a inexistente.
    if (!existing || !canActOnStore(actor, "pdv_requests:status", existing.companyId)) {
      return jsonResponse({ error: "SOLICITAÇÃO NÃO ENCONTRADA." }, 404);
    }
    await database
      .prepare(
        `UPDATE pdv_change_requests
         SET status=?1, updated_by=?2, updated_by_name=?3, updated_at=CURRENT_TIMESTAMP
         WHERE id=?4`,
      )
      .bind(status, actor.id, actor.displayName || "Usuário", id)
      .run();
    return jsonResponse({ updated: true, status });
  } catch (error) {
    console.error("Não foi possível atualizar o status da alteração PDV.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR O STATUS." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "pdv_requests:delete")) {
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
      .prepare("SELECT id, company_id AS companyId FROM pdv_change_requests WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ id: string; companyId: string }>();
    if (!existing || !canActOnStore(actor, "pdv_requests:delete", existing.companyId)) {
      return jsonResponse({ error: "SOLICITAÇÃO NÃO ENCONTRADA." }, 404);
    }
    await database.prepare("DELETE FROM pdv_change_requests WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a alteração PDV.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A SOLICITAÇÃO." }, 500);
  }
}
