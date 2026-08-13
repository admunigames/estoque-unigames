import { getD1 } from "../../../db";
import { unauthorizedResponse } from "../../lib/notion";
import { canSeeAllStores, hasCompany, NO_COMPANY_ERROR } from "../../lib/access-scope";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  companyId: string;
  permissions: string[];
};
type SupplyStatus = "pending" | "received";
type SupplyRow = {
  id: string;
  productName: string;
  quantityText: string;
  companyId: string;
  companyName: string;
  status: SupplyStatus;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  receivedBy: string;
  receivedByName: string;
  receivedAt: string;
  updatedAt: string;
  requestCount: number;
  firstRequestedAt: string;
  lastRequestedAt: string;
  lastRequestedByName: string;
};

const COMPANY_PATTERN = /^c[a-z0-9]{6,40}$/i;
const MAX_BULK_ITEMS = 250;

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

function canAccessSupplies(actor: Identity) {
  return can(actor, "supplies:view") || can(actor, "supplies:request") || can(actor, "supplies:receive");
}

// Admin sempre vê todas as lojas. Usuário sem loja vinculada mas com
// qualquer permissão de insumos também — a ausência de loja só bloqueia
// quem também não tem a permissão do módulo.
function canSeeAllSupplyStores(actor: Identity) {
  return actor.role === "admin" || (!hasCompany(actor.companyId) && canAccessSupplies(actor));
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

function recifeDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Recife",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    isMonday: value("weekday") === "Mon",
  };
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

const SUPPLY_SELECT = `
  SELECT si.id, si.product_name AS productName,
         si.quantity_text AS quantityText, si.company_id AS companyId,
         si.company_name AS companyName, si.status,
         si.created_by AS createdBy, si.created_by_name AS createdByName,
         si.created_at AS createdAt, si.received_by AS receivedBy,
         si.received_by_name AS receivedByName, si.received_at AS receivedAt,
         si.updated_at AS updatedAt,
         COUNT(sre.id) AS requestCount,
         COALESCE(MIN(sre.requested_at), '') AS firstRequestedAt,
         COALESCE(MAX(sre.requested_at), '') AS lastRequestedAt,
         COALESCE((
           SELECT latest.requested_by_name
           FROM supply_request_events latest
           WHERE latest.supply_item_id=si.id
           ORDER BY latest.requested_at DESC LIMIT 1
         ), '') AS lastRequestedByName
  FROM supply_items si
  LEFT JOIN supply_request_events sre ON sre.supply_item_id=si.id`;

function scopedCompany(actor: Identity, requestedCompanyId: string) {
  if (!canSeeAllSupplyStores(actor)) return actor.companyId;
  return COMPANY_PATTERN.test(requestedCompanyId) ? requestedCompanyId : "";
}

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessSupplies(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO AOS INSUMOS." }, 403);
  }

  const url = new URL(request.url);
  const view = url.searchParams.get("view") === "history" ? "history" : "active";
  const requestedCompanyId = safeText(url.searchParams.get("companyId"), 80);
  const companyId = scopedCompany(actor, requestedCompanyId);
  if (!canSeeAllSupplyStores(actor) && !hasCompany(companyId)) {
    return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
  }

  try {
    const database = await getD1();
    const where = [
      view === "history" ? "si.status='received'" : "si.status='pending'",
    ];
    const bindings: string[] = [];
    if (companyId) {
      bindings.push(companyId);
      where.push(`si.company_id=?${bindings.length}`);
    }
    const limit = view === "history" ? 300 : 500;
    const query = `${SUPPLY_SELECT}
      WHERE ${where.join(" AND ")}
      GROUP BY si.id
      ORDER BY ${
        view === "history"
          ? "si.received_at DESC"
          : "CASE WHEN COUNT(sre.id)=0 THEN 0 ELSE 1 END, si.created_at ASC"
      }
      LIMIT ${limit}`;
    const result = await database
      .prepare(query)
      .bind(...bindings)
      .all<SupplyRow>();

    const countWhere = companyId ? " WHERE si.company_id=?1" : "";
    const countQuery = `SELECT
      SUM(CASE WHEN si.status='pending' THEN 1 ELSE 0 END) AS pendingCount,
      SUM(CASE WHEN si.status='received' THEN 1 ELSE 0 END) AS receivedCount,
      SUM(CASE WHEN si.status='pending' AND NOT EXISTS (
        SELECT 1 FROM supply_request_events sre
        WHERE sre.supply_item_id=si.id
      ) THEN 1 ELSE 0 END) AS notedCount,
      SUM(CASE WHEN si.status='pending' AND EXISTS (
        SELECT 1 FROM supply_request_events sre
        WHERE sre.supply_item_id=si.id
      ) THEN 1 ELSE 0 END) AS awaitingCount
      FROM supply_items si${countWhere}`;
    const counts = companyId
      ? await database.prepare(countQuery).bind(companyId).first<{
          pendingCount: number;
          receivedCount: number;
          notedCount: number;
          awaitingCount: number;
        }>()
      : await database.prepare(countQuery).first<{
          pendingCount: number;
          receivedCount: number;
          notedCount: number;
          awaitingCount: number;
        }>();
    const recife = recifeDateParts();
    return jsonResponse({
      items: result.results ?? [],
      summary: {
        pending: Number(counts?.pendingCount || 0),
        received: Number(counts?.receivedCount || 0),
        noted: Number(counts?.notedCount || 0),
        awaiting: Number(counts?.awaitingCount || 0),
      },
      today: recife.date,
      isMonday: recife.isMonday,
    });
  } catch (error) {
    console.error("Não foi possível carregar os insumos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS INSUMOS." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "supplies:request")) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA SOLICITAR INSUMOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const requestedCompanyId = safeText(body.companyId, 80);
    const canChooseCompany = canSeeAllStores(actor, "supplies:request");
    const companyId = canChooseCompany ? requestedCompanyId : actor.companyId;
    if (!COMPANY_PATTERN.test(companyId)) {
      return jsonResponse(
        { error: canChooseCompany ? "ESCOLHA A LOJA." : NO_COMPANY_ERROR },
        400,
      );
    }
    const productName = safeText(body.productName, 180);
    const quantityText = safeText(body.quantityText, 100);
    if (productName.length < 2) {
      return jsonResponse({ error: "INFORME O PRODUTO." }, 400);
    }
    if (!quantityText) {
      return jsonResponse({ error: "INFORME A QUANTIDADE." }, 400);
    }

    const database = await getD1();
    const resolvedCompanyName = await companyName(database, companyId);
    if (!resolvedCompanyName) {
      return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
    }
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO supply_items
          (id, product_name, quantity_text, company_id, company_name, status,
           created_by, created_by_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(
        id,
        productName,
        quantityText,
        companyId,
        resolvedCompanyName,
        actor.id,
        actor.displayName,
      )
      .run();
    return jsonResponse({ created: true, id }, 201);
  } catch (error) {
    console.error("Não foi possível registrar o insumo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR O INSUMO." }, 500);
  }
}

export async function PATCH(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessSupplies(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO AOS INSUMOS." }, 403);
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const action = safeText(body.action, 30);
    const database = await getD1();
    if (action === "request") {
      if (!can(actor, "supplies:request")) {
        return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA SOLICITAR INSUMOS." }, 403);
      }
      const rawIds = Array.isArray(body.itemIds) ? body.itemIds : [];
      const itemIds = Array.from(
        new Set(
          rawIds
            .map((value) => safeText(value, 80))
            .filter((value) => /^[a-z0-9-]{8,80}$/i.test(value)),
        ),
      ).slice(0, MAX_BULK_ITEMS);
      if (!itemIds.length) {
        return jsonResponse({ error: "SELECIONE AO MENOS UM INSUMO." }, 400);
      }
      const placeholders = itemIds.map((_, index) => `?${index + 1}`).join(",");
      const conditions = [
        `id IN (${placeholders})`,
        "status='pending'",
      ];
      const bindings: string[] = [...itemIds];
      if (!canSeeAllStores(actor, "supplies:request")) {
        if (!hasCompany(actor.companyId)) {
          return jsonResponse({ error: NO_COMPANY_ERROR }, 403);
        }
        bindings.push(actor.companyId);
        conditions.push(`company_id=?${bindings.length}`);
      }
      const rows = await database
        .prepare(
          `SELECT id, company_id AS companyId, company_name AS companyName
           FROM supply_items WHERE ${conditions.join(" AND ")}`,
        )
        .bind(...bindings)
        .all<{ id: string; companyId: string; companyName: string }>();
      const recife = recifeDateParts();
      const operations = (rows.results ?? []).map((item) =>
        database
          .prepare(
            `INSERT INTO supply_request_events
              (id, supply_item_id, company_id, company_name, request_date,
               requested_by, requested_by_name, requested_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)
             ON CONFLICT (supply_item_id, request_date) DO NOTHING`,
          )
          .bind(
            crypto.randomUUID(),
            item.id,
            item.companyId,
            item.companyName,
            recife.date,
            actor.id,
            actor.displayName,
          ),
      );
      if (operations.length) await database.batch(operations);
      return jsonResponse({
        requested: operations.length,
        requestDate: recife.date,
      });
    }

    if (action === "receive") {
      if (!can(actor, "supplies:receive")) {
        return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA RECEBER INSUMOS." }, 403);
      }
      const id = safeText(body.id, 80);
      if (!id) return jsonResponse({ error: "INSUMO INVÁLIDO." }, 400);
      const existing = await database
        .prepare(
          `SELECT si.id, si.company_id AS companyId, si.status,
                  COUNT(sre.id) AS requestCount
           FROM supply_items si
           LEFT JOIN supply_request_events sre ON sre.supply_item_id=si.id
           WHERE si.id=?1 GROUP BY si.id LIMIT 1`,
        )
        .bind(id)
        .first<{
          id: string;
          companyId: string;
          status: SupplyStatus;
          requestCount: number;
        }>();
      if (!existing) {
        return jsonResponse({ error: "INSUMO NÃO ENCONTRADO." }, 404);
      }
      if (!canSeeAllStores(actor, "supplies:receive") && existing.companyId !== actor.companyId) {
        return jsonResponse({ error: "VOCÊ NÃO PODE ALTERAR OUTRA LOJA." }, 403);
      }
      if (existing.status === "received") {
        return jsonResponse({ error: "ESTE INSUMO JÁ FOI RECEBIDO." }, 409);
      }
      if (Number(existing.requestCount || 0) === 0) {
        return jsonResponse(
          { error: "REGISTRE O PEDIDO DESTE INSUMO ANTES DO RECEBIMENTO." },
          409,
        );
      }
      await database
        .prepare(
          `UPDATE supply_items
           SET status='received', received_by=?1, received_by_name=?2,
               received_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
           WHERE id=?3 AND status='pending'`,
        )
        .bind(actor.id, actor.displayName, id)
        .run();
      return jsonResponse({ received: true });
    }

    return jsonResponse({ error: "AÇÃO INVÁLIDA." }, 400);
  } catch (error) {
    console.error("Não foi possível atualizar os insumos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR OS INSUMOS." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!can(actor, "supplies:delete")) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR UMA SOLICITAÇÃO DE INSUMO." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    if (!/^[a-z0-9-]{8,80}$/i.test(id)) {
      return jsonResponse({ error: "INSUMO INVÁLIDO." }, 400);
    }

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM supply_items WHERE id=?1 LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) {
      return jsonResponse({ error: "INSUMO NÃO ENCONTRADO." }, 404);
    }

    await database.batch([
      database
        .prepare("DELETE FROM supply_request_events WHERE supply_item_id=?1")
        .bind(id),
      database.prepare("DELETE FROM supply_items WHERE id=?1").bind(id),
    ]);
    return jsonResponse({ deleted: true, id });
  } catch (error) {
    console.error("Não foi possível excluir o insumo.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR O INSUMO." }, 500);
  }
}
