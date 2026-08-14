import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../lib/access-scope";

type JsonMap = Record<string, unknown>;
type OutputStatus = "requested" | "completed";
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  companyId: string;
  sector: string;
  permissions: string[];
};
type OutputRow = {
  id: string;
  quantity: number;
  productName: string;
  responsibleName: string;
  defect: string;
  companyId: string;
  companyName: string;
  status: OutputStatus;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  completedBy: string;
  completedByName: string;
  completedAt: string;
  updatedAt: string;
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
    sector: safeText(request.headers.get("x-unigames-sector"), 40),
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

function can(actor: Identity, permission: string) {
  return actor.role === "admin" || actor.permissions.includes(permission);
}

function canAccessOutputs(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.some((permission) => permission.startsWith("outputs:"))
  );
}

// Usuários do setor Administrativo não têm loja vinculada (companyId vazio)
// e continuam vendo todas as lojas independente de quais permissões
// granulares tenham — regra histórica mantida como reforço além da regra
// genérica em canSeeAllStores() (que já cobre o caso comum de "sem loja,
// mas com a permissão do módulo").
function isAdministrativeActor(actor: Identity) {
  return actor.sector === "administrative";
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

const OUTPUT_SELECT = `
  SELECT id, quantity, product_name AS productName, responsible_name AS responsibleName, defect,
         company_id AS companyId, company_name AS companyName, status,
         created_by AS createdBy, created_by_name AS createdByName,
         created_at AS createdAt, completed_by AS completedBy,
         completed_by_name AS completedByName, completed_at AS completedAt,
         updated_at AS updatedAt
  FROM defective_outputs`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessOutputs(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO ÀS SAÍDAS." }, 403);
  }

  try {
    const database = await getD1();
    const allStores = canSeeAllStores(actor, "outputs:view") || isAdministrativeActor(actor);
    if (!allStores && !hasCompany(actor.companyId)) {
      return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
    }
    const result = allStores
      ? await database
          .prepare(
            `${OUTPUT_SELECT}
             ORDER BY CASE status WHEN 'requested' THEN 0 ELSE 1 END,
                      CASE WHEN status='requested' THEN created_at END ASC,
                      completed_at DESC`,
          )
          .all<OutputRow>()
      : await database
          .prepare(
            `${OUTPUT_SELECT}
             WHERE company_id=?1
             ORDER BY CASE status WHEN 'requested' THEN 0 ELSE 1 END,
                      CASE WHEN status='requested' THEN created_at END ASC,
                      completed_at DESC`,
          )
          .bind(actor.companyId)
          .all<OutputRow>();
    return jsonResponse({ outputs: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as saídas.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS SAÍDAS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "outputs:create")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA CADASTRAR SAÍDAS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const requestedCompanyId = safeText(body.companyId, 80);
    const canChooseCompany = canSeeAllStores(actor, "outputs:create") || isAdministrativeActor(actor);
    const companyId = canChooseCompany ? requestedCompanyId : actor.companyId;
    if (!hasCompany(companyId)) {
      return jsonResponse(
        { error: canChooseCompany ? "ESCOLHA A LOJA." : NO_COMPANY_ERROR },
        400,
      );
    }
    const quantity = Number(body.quantity);
    const productName = safeText(body.productName, 180);
    const responsibleName = safeText(body.responsibleName, 120);
    const defect = safeText(body.defect, 1200);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      return jsonResponse({ error: "INFORME UMA QUANTIDADE VÁLIDA." }, 400);
    }
    if (productName.length < 2) {
      return jsonResponse({ error: "INFORME O PRODUTO." }, 400);
    }
    if (responsibleName.length < 2) {
      return jsonResponse({ error: "INFORME O RESPONSÁVEL PELA SAÍDA." }, 400);
    }
    if (defect.length < 2) {
      return jsonResponse({ error: "INFORME OS DEFEITOS/OBSERVAÇÕES DA SAÍDA." }, 400);
    }

    const database = await getD1();
    const resolvedCompanyName = await companyName(database, companyId);
    if (!resolvedCompanyName) {
      return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
    }
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO defective_outputs
          (id, quantity, product_name, responsible_name, defect, company_id, company_name,
           status, created_by, created_by_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'requested', ?8, ?9,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        quantity,
        productName,
        responsibleName,
        defect,
        companyId,
        resolvedCompanyName,
        actor.id,
        actor.displayName,
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível registrar a saída.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR A SAÍDA." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "outputs:complete")) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA CONCLUIR UMA SAÍDA." },
      403,
    );
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
      .prepare(`${OUTPUT_SELECT} WHERE id=?1 LIMIT 1`)
      .bind(id)
      .first<OutputRow>();
    if (!existing) {
      return jsonResponse({ error: "SOLICITAÇÃO NÃO ENCONTRADA." }, 404);
    }
    if (existing.status !== "requested") {
      return jsonResponse({ error: "ESTA SAÍDA JÁ FOI EFETUADA." }, 409);
    }

    await database
      .prepare(
        `UPDATE defective_outputs
         SET status='completed', completed_by=?1, completed_by_name=?2,
             completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE id=?3 AND status='requested'`,
      )
      .bind(actor.id, actor.displayName, id)
      .run();
    return jsonResponse({ updated: true, status: "completed" });
  } catch (error) {
    console.error("Não foi possível concluir a saída.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CONCLUIR A SAÍDA." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "outputs:delete")) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR SAÍDAS." },
      403,
    );
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
      .prepare(`${OUTPUT_SELECT} WHERE id=?1 LIMIT 1`)
      .bind(id)
      .first<OutputRow>();
    if (!existing) {
      return jsonResponse({ error: "SOLICITAÇÃO NÃO ENCONTRADA." }, 404);
    }

    await database.prepare("DELETE FROM defective_outputs WHERE id=?1").bind(id).run();
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error("Não foi possível excluir a saída.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A SAÍDA." }, 500);
  }
}
