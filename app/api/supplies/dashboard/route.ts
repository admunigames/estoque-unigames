import { getD1 } from "../../../../db";
import { unauthorizedResponse } from "../../../lib/notion";

type JsonMap = Record<string, unknown>;
type Identity = { role: "admin" | "user"; permissions: string[] };

function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function identity(request: Request): Identity {
  return {
    role: request.headers.get("x-unigames-role") === "admin" ? "admin" : "user",
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

/**
 * O painel mostra dados agregados de todas as lojas (separações
 * pendentes, estoque baixo, solicitações da semana) — qualquer
 * permissão de gestão de Insumos concede esse alcance, não só admin.
 */
function isSuppliesManager(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("supplies:manage_catalog") ||
    actor.permissions.includes("supplies:stock_in") ||
    actor.permissions.includes("supplies:stock_out") ||
    actor.permissions.includes("supplies:delete")
  );
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

type RequestProgressRow = {
  id: string;
  companyName: string;
  totalItems: number;
  separatedItems: number;
  receivedItems: number;
};

type ProductStockRow = {
  id: string;
  name: string;
  categoryName: string;
  stockQty: number;
};

export async function GET(request: Request) {
  const unauthorized = unauthorizedResponse(request);
  if (unauthorized) return unauthorized;
  const actor = identity(request);
  if (!isSuppliesManager(actor)) {
    return jsonResponse({ error: "VOCÊ NÃO TEM PERMISSÃO PARA VER O PAINEL." }, 403);
  }

  const url = new URL(request.url);
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("weekStart") || "")
    ? String(url.searchParams.get("weekStart"))
    : upcomingMondayRecife();

  try {
    const database = await getD1();

    const requestRows = await database
      .prepare(
        `SELECT r.id, r.company_name AS companyName,
                COUNT(i.id) AS totalItems,
                SUM(CASE WHEN i.separated=1 THEN 1 ELSE 0 END) AS separatedItems,
                SUM(CASE WHEN i.separated=1 AND i.received_status IN ('received','not_received') THEN 1 ELSE 0 END) AS receivedItems
         FROM supply_requests r
         LEFT JOIN supply_request_items i ON i.request_id = r.id
         WHERE r.week_start=?1
         GROUP BY r.id, r.company_name
         ORDER BY r.company_name ASC`,
      )
      .bind(weekStart)
      .all<RequestProgressRow>();
    const requests = requestRows.results ?? [];

    const pendingSeparation = requests.filter(
      (row) => Number(row.totalItems) > 0 && Number(row.separatedItems) < Number(row.totalItems),
    );
    const unfinished = requests.filter(
      (row) =>
        Number(row.totalItems) > 0 &&
        (Number(row.separatedItems) < Number(row.totalItems) ||
          Number(row.receivedItems) < Number(row.separatedItems)),
    );

    const zeroStockRows = await database
      .prepare(
        `SELECT sp.id, sp.name, sc.name AS categoryName, sp.stock_qty AS stockQty
         FROM supply_products sp JOIN supply_categories sc ON sc.id = sp.category_id
         WHERE sp.active=1 AND sp.stock_qty <= 0
         ORDER BY sp.name ASC`,
      )
      .all<ProductStockRow>();
    const lowStockRows = await database
      .prepare(
        `SELECT sp.id, sp.name, sc.name AS categoryName, sp.stock_qty AS stockQty
         FROM supply_products sp JOIN supply_categories sc ON sc.id = sp.category_id
         WHERE sp.active=1 AND sp.stock_qty > 0 AND sp.stock_qty < 10
         ORDER BY sp.stock_qty ASC, sp.name ASC`,
      )
      .all<ProductStockRow>();

    return jsonResponse({
      weekStart,
      pendingSeparationCount: pendingSeparation.length,
      pendingSeparationRequests: pendingSeparation.map((row) => ({
        companyName: row.companyName,
        pendingItems: Number(row.totalItems) - Number(row.separatedItems),
        totalItems: Number(row.totalItems),
      })),
      zeroStockCount: (zeroStockRows.results ?? []).length,
      zeroStockProducts: zeroStockRows.results ?? [],
      lowStockCount: (lowStockRows.results ?? []).length,
      lowStockProducts: lowStockRows.results ?? [],
      weekRequestsTotal: requests.length,
      weekRequestsUnfinished: unfinished.length,
    });
  } catch (error) {
    console.error("Não foi possível carregar o painel de insumos.", error);
    return jsonResponse({ error: "NÃO FOI POSSÍVEL CARREGAR O PAINEL." }, 500);
  }
}
