import { getD1 } from "../../../db";

// RH > Plano Odontológico — controle de inclusão/exclusão de colaboradores
// no plano. Permissão própria rh_odontologico:view/:manage (ver
// MODULE_VIEW_PERMISSIONS.dentalPlan em worker/index.ts), independente das
// demais permissões de RH — dado sensível (CPF + saúde). CPF e data de
// nascimento nunca são copiados pra hr_dental_plan: são sempre lookup ao
// vivo em hr_employees por employee_id (ver GET em route.ts).

export type JsonMap = Record<string, unknown>;

export type Identity = {
  id: string;
  displayName: string;
  role: "admin" | "user";
  permissions: string[];
};

export type Database = Awaited<ReturnType<typeof getD1>>;

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

export function canViewDentalPlan(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("rh_odontologico:view") ||
    actor.permissions.includes("rh_odontologico:manage")
  );
}

export function canManageDentalPlan(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("rh_odontologico:manage");
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

export function uuidIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

export const DENTAL_PLAN_STATUSES = [
  "incluso",
  "faltando_incluir_excluir",
  "inclusao_exclusao_solicitada",
  "desligado",
] as const;
export type DentalPlanStatus = (typeof DENTAL_PLAN_STATUSES)[number];
export function isDentalPlanStatus(value: string): value is DentalPlanStatus {
  return (DENTAL_PLAN_STATUSES as readonly string[]).includes(value);
}

export const DENTAL_PLAN_REASONS = ["inclusao", "exclusao"] as const;
export type DentalPlanReason = (typeof DENTAL_PLAN_REASONS)[number] | "";
export function isDentalPlanReason(value: string): value is DentalPlanReason {
  return value === "" || (DENTAL_PLAN_REASONS as readonly string[]).includes(value);
}

// Lookup ao vivo de CPF e data de nascimento — colunas de e.* vêm de LEFT
// JOIN com hr_employees, nunca são gravadas em hr_dental_plan (ver comentário
// no topo do arquivo).
export const DENTAL_PLAN_COLUMNS = `
  d.id, d.employee_id AS employeeId, d.employee_name AS employeeName,
  d.unit_name AS unitName, d.cnpj, d.status, d.reason,
  d.process_number AS processNumber, d.notes,
  d.created_by AS createdBy, d.created_by_name AS createdByName, d.created_at AS createdAt,
  d.updated_by AS updatedBy, d.updated_by_name AS updatedByName, d.updated_at AS updatedAt,
  e.cpf AS cpf, e.birth_date AS birthDate
`;

export type DentalPlanRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  unitName: string;
  cnpj: string;
  status: DentalPlanStatus;
  reason: DentalPlanReason;
  processNumber: string;
  notes: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
  cpf: string | null;
  birthDate: string | null;
};
