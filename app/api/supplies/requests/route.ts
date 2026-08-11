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

const COMPANY_PATTERN = /^c[a-z0-9]{6,40}$/i;
const MAX_ITEMS = 300;

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

/** Semana vigente = próxima segunda-feira (ou hoje, se hoje já for segunda). */
function upcomingMondayRecife(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Recife",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  const weekdayMap: Record<string, number> = {
    Mon: 0,
    Tue: 6,
    Wed: 5,
    Thu: 4,
    Fri: 3,
    Sat: 2,
    Sun: 1,
  };
  const daysUntilMonday = weekdayMap[value("weekday")] ?? 0;
  const todayUtc = Date.UTC(
    Number(value("year")),
    Number(value("month")) - 1,
    Number(value("day")),
  );
  return new Date(todayUtc + daysUntilMonday * 86400000).toISOString().slice(0, 10);
}

function scopedCompany(actor: Identity, requestedCompanyId: string) {
  if (actor.role !== "admin") return actor.companyId;
  return COMPANY_PATTERN.test(requestedCompanyId) ? requestedCompanyId : "";
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

type ProductRow = {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  stockQty: number;
  marked: number;
};

type RequestRow = {
  id: string;
  companyId: string;
  companyName: string;
  weekStart: string;
  responsibleName: string;
  note: string;
  status: string;
  createdByName: string;
  createdAt: string;
};

type RequestItemRow = {
  id: string;
  productId: string;
  productName: string;
  categoryName: string;
  quantity: number;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!canAccessSupplies(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM ACESSO AOS INSUMOS." }, 403);
  }

  const url = new URL(request.url);
  const requestedCompanyId = safeText(url.searchParams.get("companyId"), 80);
  const companyId = scopedCompany(actor, requestedCompanyId);
  if (!COMPANY_PATTERN.test(companyId)) {
    return jsonResponse(
      {
        error:
          actor.role === "admin"
            ? "ESCOLHA A LOJA."
            : "SEU USUÁRIO PRECISA ESTAR VINCULADO A UMA LOJA.",
      },
      400,
    );
  }
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("weekStart") || "")
    ? String(url.searchParams.get("weekStart"))
    : upcomingMondayRecife();

  try {
    const database = await getD1();
    const existing = await database
      .prepare(
        `SELECT id, company_id AS companyId, company_name AS companyName,
                week_start AS weekStart, responsible_name AS responsibleName,
                note, status, created_by_name AS createdByName, created_at AS createdAt
         FROM supply_requests WHERE company_id=?1 AND week_start=?2 LIMIT 1`,
      )
      .bind(companyId, weekStart)
      .first<RequestRow>();

    if (existing) {
      const items = await database
        .prepare(
          `SELECT id, product_id AS productId, product_name AS productName,
                  category_name AS categoryName, quantity
           FROM supply_request_items WHERE request_id=?1
           ORDER BY category_name ASC, product_name ASC`,
        )
        .bind(existing.id)
        .all<RequestItemRow>();
      return jsonResponse({
        weekStart,
        companyId,
        submitted: true,
        request: existing,
        items: items.results ?? [],
      });
    }

    const products = await database
      .prepare(
        `SELECT sp.id, sp.category_id AS categoryId, sc.name AS categoryName,
                sp.name, sp.stock_qty AS stockQty,
                CASE WHEN smm.id IS NULL THEN 0 ELSE 1 END AS marked
         FROM supply_products sp
         JOIN supply_categories sc ON sc.id = sp.category_id
         LEFT JOIN supply_missing_marks smm
           ON smm.product_id = sp.id AND smm.company_id=?1 AND smm.week_start=?2
         WHERE sp.active=1
         ORDER BY sc.name ASC, sp.name ASC`,
      )
      .bind(companyId, weekStart)
      .all<ProductRow>();
    return jsonResponse({
      weekStart,
      companyId,
      submitted: false,
      products: products.results ?? [],
    });
  } catch (error) {
    console.error("Não foi possível carregar a solicitação de insumos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR A SOLICITAÇÃO." }, 500);
  }
}

export async function POST(request: Request) {
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
    const requestedCompanyId = safeText(body.companyId, 80);
    const companyId =
      actor.role === "admin" ? requestedCompanyId : actor.companyId;
    if (!COMPANY_PATTERN.test(companyId)) {
      return jsonResponse(
        {
          error:
            actor.role === "admin"
              ? "ESCOLHA A LOJA."
              : "SEU USUÁRIO PRECISA ESTAR VINCULADO A UMA LOJA.",
        },
        400,
      );
    }
    const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(String(body.weekStart || ""))
      ? String(body.weekStart)
      : upcomingMondayRecife();
    const responsibleName = safeText(body.responsibleName, 120);
    if (!responsibleName) {
      return jsonResponse({ error: "INFORME O RESPONSÁVEL PELA SOLICITAÇÃO." }, 400);
    }
    const note = safeText(body.note, 600);
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const items = rawItems
      .map((item) => {
        const record = item as JsonMap;
        return {
          productId: safeText(record.productId, 80),
          quantity: Math.trunc(Number(record.quantity)),
        };
      })
      .filter((item) => item.productId && Number.isFinite(item.quantity) && item.quantity > 0)
      .slice(0, MAX_ITEMS);
    if (!items.length && !note) {
      return jsonResponse(
        { error: "MARQUE AO MENOS UM PRODUTO OU DEIXE UMA OBSERVAÇÃO." },
        400,
      );
    }

    const database = await getD1();
    const existing = await database
      .prepare("SELECT id FROM supply_requests WHERE company_id=?1 AND week_start=?2 LIMIT 1")
      .bind(companyId, weekStart)
      .first<{ id: string }>();
    if (existing) {
      return jsonResponse(
        { error: "A SOLICITAÇÃO DESTA SEMANA JÁ FOI ENVIADA." },
        409,
      );
    }

    const resolvedCompanyName = await companyName(database, companyId);
    if (!resolvedCompanyName) {
      return jsonResponse({ error: "LOJA NÃO ENCONTRADA." }, 400);
    }

    let productRows: { id: string; name: string; categoryName: string }[] = [];
    if (items.length) {
      const placeholders = items.map((_, index) => `?${index + 1}`).join(",");
      const productIds = items.map((item) => item.productId);
      const result = await database
        .prepare(
          `SELECT sp.id, sp.name, sc.name AS categoryName
           FROM supply_products sp
           JOIN supply_categories sc ON sc.id = sp.category_id
           WHERE sp.id IN (${placeholders}) AND sp.active=1`,
        )
        .bind(...productIds)
        .all<{ id: string; name: string; categoryName: string }>();
      productRows = result.results ?? [];
    }
    const productById = new Map(productRows.map((row) => [row.id, row]));
    const validItems = items.filter((item) => productById.has(item.productId));
    if (!validItems.length && !note) {
      return jsonResponse(
        { error: "OS PRODUTOS SELECIONADOS NÃO ESTÃO MAIS DISPONÍVEIS." },
        400,
      );
    }

    const requestId = crypto.randomUUID();
    const operations = [
      database
        .prepare(
          `INSERT INTO supply_requests
            (id, company_id, company_name, week_start, responsible_name, note,
             status, created_by, created_by_name, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'submitted', ?7, ?8, CURRENT_TIMESTAMP)`,
        )
        .bind(
          requestId,
          companyId,
          resolvedCompanyName,
          weekStart,
          responsibleName,
          note,
          actor.id,
          actor.displayName,
        ),
      ...validItems.map((item) => {
        const product = productById.get(item.productId)!;
        return database
          .prepare(
            `INSERT INTO supply_request_items
              (id, request_id, product_id, product_name, category_name, quantity, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)`,
          )
          .bind(
            crypto.randomUUID(),
            requestId,
            item.productId,
            product.name,
            product.categoryName,
            item.quantity,
          );
      }),
    ];
    await database.batch(operations);
    return jsonResponse({ created: true, id: requestId }, 201);
  } catch (error) {
    console.error("Não foi possível enviar a solicitação de insumos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ENVIAR A SOLICITAÇÃO." }, 500);
  }
}
