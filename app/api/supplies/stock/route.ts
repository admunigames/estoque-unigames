import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  companyId: string;
  permissions: string[];
};
type MovementType = "in" | "out";

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

function identity(request: Request): Identity {
  return {
    id: safeText(request.headers.get("x-unigames-user-id"), 80),
    displayName: safeText(
      decodeURIComponent(request.headers.get("x-unigames-display-name") || ""),
      80,
    ),
    role: request.headers.get("x-unigames-role") === "admin" ? "admin" : "user",
    companyId: safeText(request.headers.get("x-unigames-company-id"), 80),
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

function canAccessSupplies(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("supplies");
}

function canStockIn(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("supplies_in");
}

function canStockOut(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("supplies_out");
}

function canDeleteSupplies(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("supplies_delete");
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

type MovementRow = {
  id: string;
  productId: string;
  productName: string;
  type: MovementType;
  quantity: number;
  reason: string;
  responsibleName: string;
  companyId: string;
  companyName: string;
  createdByName: string;
  createdAt: string;
};

const MOVEMENT_SELECT = `
  SELECT sm.id, sm.product_id AS productId, sp.name AS productName, sm.type,
         sm.quantity, sm.reason, sm.responsible_name AS responsibleName,
         sm.company_id AS companyId, sm.company_name AS companyName,
         sm.created_by_name AS createdByName, sm.created_at AS createdAt
  FROM supply_stock_movements sm
  JOIN supply_products sp ON sp.id = sm.product_id`;

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessSupplies(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO AOS INSUMOS." }, 403);
  }

  try {
    const url = new URL(request.url);
    const productId = safeText(url.searchParams.get("productId"), 80);
    const isAdmin = actor.role === "admin";
    const requestedCompanyId = safeText(url.searchParams.get("companyId"), 80);
    const type = url.searchParams.get("type") === "in" || url.searchParams.get("type") === "out"
      ? url.searchParams.get("type")
      : "";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") || "")
      ? String(url.searchParams.get("date"))
      : "";

    const database = await getD1();
    const conditions: string[] = [];
    const bindings: string[] = [];
    if (productId) {
      bindings.push(productId);
      conditions.push(`sm.product_id=?${bindings.length}`);
    }
    if (isAdmin && COMPANY_PATTERN.test(requestedCompanyId)) {
      bindings.push(requestedCompanyId);
      conditions.push(`sm.company_id=?${bindings.length}`);
    }
    if (type) {
      bindings.push(type);
      conditions.push(`sm.type=?${bindings.length}`);
    }
    if (date) {
      bindings.push(`${date} 00:00:00`, `${date} 23:59:59.999999`);
      conditions.push(`sm.created_at BETWEEN ?${bindings.length - 1} AND ?${bindings.length}`);
    }
    if (!isAdmin) {
      bindings.push(actor.id);
      conditions.push(`sm.created_by=?${bindings.length}`);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const hasFilters = Boolean(productId || requestedCompanyId || type || date);
    const limit = isAdmin ? (hasFilters ? 300 : 50) : 20;
    const query = `${MOVEMENT_SELECT}${where} ORDER BY sm.created_at DESC LIMIT ${limit}`;
    const result = bindings.length
      ? await database.prepare(query).bind(...bindings).all<MovementRow>()
      : await database.prepare(query).all<MovementRow>();
    return jsonResponse({ items: result.results ?? [] });
  } catch (error) {
    console.error("Não foi possível carregar as movimentações de estoque.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR AS MOVIMENTAÇÕES." }, 500);
  }
}

export async function POST(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessSupplies(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM ACESSO PARA REGISTRAR MOVIMENTAÇÕES DE ESTOQUE." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const productId = safeText(body.productId, 80);
    const type: MovementType = body.type === "out" ? "out" : "in";
    const quantity = Math.trunc(Number(body.quantity));
    const reason = safeText(body.reason, 300);
    const responsibleName = safeText(body.responsibleName, 120);

    if (type === "in" && !canStockIn(actor)) {
      return jsonResponse(
        { error: "VOCÊ NÃO TEM PERMISSÃO PARA REGISTRAR ENTRADAS DE ESTOQUE." },
        403,
      );
    }
    if (type === "out" && !canStockOut(actor)) {
      return jsonResponse(
        { error: "VOCÊ NÃO TEM PERMISSÃO PARA REGISTRAR SAÍDAS DE ESTOQUE." },
        403,
      );
    }
    if (!productId) return jsonResponse({ error: "ESCOLHA O PRODUTO." }, 400);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return jsonResponse({ error: "INFORME UMA QUANTIDADE VÁLIDA." }, 400);
    }
    if (!responsibleName) {
      return jsonResponse({ error: "INFORME O RESPONSÁVEL PELA MOVIMENTAÇÃO." }, 400);
    }

    const database = await getD1();
    const product = await database
      .prepare("SELECT id, stock_qty AS stockQty FROM supply_products WHERE id=?1 LIMIT 1")
      .bind(productId)
      .first<{ id: string; stockQty: number }>();
    if (!product) {
      return jsonResponse({ error: "PRODUTO NÃO ENCONTRADO." }, 404);
    }

    const resolvedCompanyName = COMPANY_PATTERN.test(actor.companyId)
      ? await companyName(database, actor.companyId)
      : "";

    const delta = type === "in" ? quantity : -quantity;
    const id = crypto.randomUUID();
    await database.batch([
      database
        .prepare(
          `INSERT INTO supply_stock_movements
            (id, product_id, type, quantity, reason, responsible_name,
             company_id, company_name, created_by, created_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, CURRENT_TIMESTAMP)`,
        )
        .bind(
          id,
          productId,
          type,
          quantity,
          reason,
          responsibleName,
          actor.companyId,
          resolvedCompanyName,
          actor.id,
          actor.displayName,
        ),
      database
        .prepare(
          `UPDATE supply_products SET stock_qty = stock_qty + ?1, updated_at=CURRENT_TIMESTAMP
           WHERE id=?2`,
        )
        .bind(delta, productId),
    ]);
    return jsonResponse({ created: true, id, newStockQty: product.stockQty + delta }, 201);
  } catch (error) {
    console.error("Não foi possível registrar a movimentação de estoque.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL REGISTRAR A MOVIMENTAÇÃO." }, 500);
  }
}

export async function DELETE(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canDeleteSupplies(actor)) {
    return jsonResponse(
      { error: "VOCÊ NÃO TEM PERMISSÃO PARA EXCLUIR MOVIMENTAÇÕES DE ESTOQUE." },
      403,
    );
  }
  if (!sameOrigin(request)) {
    return jsonResponse({ error: "ORIGEM NÃO PERMITIDA." }, 403);
  }

  try {
    const body = (await request.json()) as JsonMap;
    const id = safeText(body.id, 80);
    if (!id) return jsonResponse({ error: "MOVIMENTAÇÃO INVÁLIDA." }, 400);

    const database = await getD1();
    const movement = await database
      .prepare(
        `SELECT id, product_id AS productId, type, quantity
         FROM supply_stock_movements WHERE id=?1 LIMIT 1`,
      )
      .bind(id)
      .first<{ id: string; productId: string; type: MovementType; quantity: number }>();
    if (!movement) {
      return jsonResponse({ error: "MOVIMENTAÇÃO NÃO ENCONTRADA." }, 404);
    }

    const reverseDelta = movement.type === "in" ? -movement.quantity : movement.quantity;
    await database.batch([
      database.prepare("DELETE FROM supply_stock_movements WHERE id=?1").bind(id),
      database
        .prepare(
          `UPDATE supply_products SET stock_qty = stock_qty + ?1, updated_at=CURRENT_TIMESTAMP
           WHERE id=?2`,
        )
        .bind(reverseDelta, movement.productId),
    ]);
    return jsonResponse({ deleted: true, id });
  } catch (error) {
    console.error("Não foi possível excluir a movimentação de estoque.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL EXCLUIR A MOVIMENTAÇÃO." }, 500);
  }
}
