export type JsonMap = Record<string, unknown>;

export type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};

export function jsonResponse(body: JsonMap, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function safeText(value: unknown, maxLength: number) {
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

export function identity(request: Request): Identity {
  return {
    id: safeText(request.headers.get("x-unigames-user-id"), 80),
    displayName: decodedHeader(request, "x-unigames-display-name").slice(0, 80),
    role: request.headers.get("x-unigames-role") === "admin" ? "admin" : "user",
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((permission) => permission.trim())
      .filter(Boolean),
  };
}

export function canManageFinance(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("finance:manage");
}

// Compras em cartão pela Assistência (itens 8-10). cadastrar != aprovar;
// finance:manage cobre os dois.
export function canRequestCardPurchases(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("cards:request") ||
    actor.permissions.includes("finance:manage")
  );
}

export function canApproveCardPurchases(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("cards:approve") ||
    actor.permissions.includes("finance:manage")
  );
}

export function sameOrigin(request: Request) {
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

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

type CompanyRow = { id: string; name: string };

/**
 * Lê o cadastro de lojas/empresas — persistido em shared_state sob a chave
 * 'companies_list' (o mesmo dado que o front-end lê via storage.get no
 * cliente, ver loadCompanies() em public/estoque.html). Usado no rateio pra
 * nomear cada loja e pra decidir quais lojas existem quando um modelo
 * dinâmico ('faturamento'/'funcionarios') precisa varrer todas.
 */
export async function loadCompanyList(database: D1Database): Promise<CompanyRow[]> {
  const row = await database
    .prepare("SELECT value_json AS value FROM shared_state WHERE state_key='companies_list'")
    .first<{ value: string }>();
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is CompanyRow =>
        Boolean(item) && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string",
    );
  } catch {
    return [];
  }
}
