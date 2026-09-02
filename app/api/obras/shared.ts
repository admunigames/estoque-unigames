import { getD1 } from "../../../db";

// Módulo Obras (item 14) — reformas/construções em lojas, tratadas como
// investimento (CAPEX). NÃO entram em Despesas nem na DRE.

export type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};

export type Database = Awaited<ReturnType<typeof getD1>>;

export const OBRA_KINDS = ["reforma", "construcao", "manutencao", "outros"] as const;
export const OBRA_STATUSES = ["planejada", "andamento", "concluida", "cancelada"] as const;
export const OBRA_PAYMENT_METHODS = ["pix", "boleto", "cartao", "dinheiro", "transferencia", "outros"] as const;

export const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

export function jsonResponse(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}

export function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function centsValue(value: unknown) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function identity(request: Request): Identity {
  const decoded = (name: string) => {
    const raw = request.headers.get(name) || "";
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };
  return {
    id: safeText(request.headers.get("x-unigames-user-id"), 80),
    displayName: decoded("x-unigames-display-name").slice(0, 80),
    role: request.headers.get("x-unigames-role") === "admin" ? "admin" : "user",
    permissions: (request.headers.get("x-unigames-permissions") || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  };
}

// works:manage é a permissão própria do módulo; finance:manage também
// libera (fallback pedido no detalhamento do módulo).
export function canManageWorks(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("works:manage") ||
    actor.permissions.includes("finance:manage")
  );
}

export function actorName(actor: Identity) {
  return actor.displayName || "Usuário";
}

export function sameOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (fetchSite === "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!origin) return !fetchSite || fetchSite === "none";
  const url = new URL(request.url);
  const allowed = new Set([url.origin]);
  const forwardedHost =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host")?.trim() ||
    "";
  if (forwardedHost) {
    const proto =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (url.protocol === "http:" ? "http" : "https");
    try {
      allowed.add(new URL(`${proto}://${forwardedHost}`).origin);
    } catch {
      return false;
    }
  }
  return allowed.has(origin);
}

export function isOneOf<T extends readonly string[]>(values: T, value: string): value is T[number] {
  return (values as readonly string[]).includes(value);
}

export const OBRA_COLUMNS = `id, company_id AS companyId, company_name AS companyName, title, description,
  kind, responsible, supplier_id AS supplierId, budget_cents AS budgetCents, start_date AS startDate,
  expected_end_date AS expectedEndDate, end_date AS endDate, status, notes,
  created_by AS createdBy, created_by_name AS createdByName, created_at AS createdAt,
  updated_by AS updatedBy, updated_by_name AS updatedByName, updated_at AS updatedAt`;

export const OBRA_ENTRY_COLUMNS = `id, obra_id AS obraId, description, supplier, amount_cents AS amountCents,
  entry_date AS entryDate, payment_method AS paymentMethod, notes, created_by AS createdBy,
  created_by_name AS createdByName, created_at AS createdAt`;
