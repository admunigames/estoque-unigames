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

/**
 * Semana vigente = a próxima segunda-feira (ou hoje, se hoje já for
 * segunda) — é o dia em que a marcação da semana vira solicitação.
 */
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
  const monday = new Date(todayUtc + daysUntilMonday * 86400000);
  return monday.toISOString().slice(0, 10);
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
  notes: string;
  stockQty: number;
  marked: number;
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
    const result = await database
      .prepare(
        `SELECT sp.id, sp.category_id AS categoryId, sc.name AS categoryName,
                sp.name, sp.notes, sp.stock_qty AS stockQty,
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
    return jsonResponse({ items: result.results ?? [], weekStart, companyId });
  } catch (error) {
    console.error("Não foi possível carregar a marcação de insumos faltando.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR OS PRODUTOS." }, 500);
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
    const productId = safeText(body.productId, 80);
    if (!productId) return jsonResponse({ error: "PRODUTO INVÁLIDO." }, 400);
    const marked = Boolean(body.marked);
    const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(String(body.weekStart || ""))
      ? String(body.weekStart)
      : upcomingMondayRecife();

    const database = await getD1();
    const product = await database
      .prepare("SELECT id FROM supply_products WHERE id=?1 AND active=1 LIMIT 1")
      .bind(productId)
      .first<{ id: string }>();
    if (!product) {
      return jsonResponse({ error: "PRODUTO NÃO ENCONTRADO OU INATIVO." }, 404);
    }

    if (marked) {
      const resolvedCompanyName = await companyName(database, companyId);
      await database
        .prepare(
          `INSERT INTO supply_missing_marks
            (id, product_id, company_id, company_name, week_start,
             marked_by, marked_by_name, marked_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)
           ON CONFLICT (product_id, company_id, week_start) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          productId,
          companyId,
          resolvedCompanyName,
          weekStart,
          actor.id,
          actor.displayName,
        )
        .run();
    } else {
      await database
        .prepare(
          `DELETE FROM supply_missing_marks
           WHERE product_id=?1 AND company_id=?2 AND week_start=?3`,
        )
        .bind(productId, companyId, weekStart)
        .run();
    }
    return jsonResponse({ updated: true, marked, weekStart });
  } catch (error) {
    console.error("Não foi possível atualizar a marcação de insumo faltando.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL ATUALIZAR A MARCAÇÃO." }, 500);
  }
}
