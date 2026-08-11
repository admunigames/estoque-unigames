import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";

type JsonMap = Record<string, unknown>;
type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};
type MovementType = "in" | "out";

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
  return actor.role === "admin" || actor.permissions.includes("supplies");
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

type MovementRow = {
  id: string;
  productId: string;
  productName: string;
  type: MovementType;
  quantity: number;
  reason: string;
  responsibleName: string;
  createdByName: string;
  createdAt: string;
};

const MOVEMENT_SELECT = `
  SELECT sm.id, sm.product_id AS productId, sp.name AS productName, sm.type,
         sm.quantity, sm.reason, sm.responsible_name AS responsibleName,
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
    const database = await getD1();
    const isAdmin = actor.role === "admin";
    const conditions: string[] = [];
    const bindings: string[] = [];
    if (productId) {
      bindings.push(productId);
      conditions.push(`sm.product_id=?${bindings.length}`);
    }
    if (!isAdmin) {
      bindings.push(actor.id);
      conditions.push(`sm.created_by=?${bindings.length}`);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const limit = productId ? 100 : isAdmin ? 50 : 20;
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

    if (actor.role !== "admin" && type === "in") {
      return jsonResponse(
        { error: "SOMENTE O ADMINISTRADOR PODE REGISTRAR ENTRADAS DE ESTOQUE." },
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

    const delta = type === "in" ? quantity : -quantity;
    const id = crypto.randomUUID();
    await database.batch([
      database
        .prepare(
          `INSERT INTO supply_stock_movements
            (id, product_id, type, quantity, reason, responsible_name,
             created_by, created_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CURRENT_TIMESTAMP)`,
        )
        .bind(id, productId, type, quantity, reason, responsibleName, actor.id, actor.displayName),
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
