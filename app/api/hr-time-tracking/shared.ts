import { getD1 } from "../../../db";

// RH > Controle de Horas - Logística — módulo independente de "payroll"
// (Folha/Benefícios/Comissionamento) e de "hr" (Folgas/Escalas): permissão
// própria rh_ponto_logistica:view/:manage (ver MODULE_VIEW_PERMISSIONS em
// worker/index.ts).

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

export function canViewTimeTracking(actor: Identity) {
  return (
    actor.role === "admin" ||
    actor.permissions.includes("rh_ponto_logistica:view") ||
    actor.permissions.includes("rh_ponto_logistica:manage")
  );
}

export function canManageTimeTracking(actor: Identity) {
  return actor.role === "admin" || actor.permissions.includes("rh_ponto_logistica:manage");
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

export const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function uuidIsValid(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

export type EmployeeRow = { id: string; fullName: string; companyName: string; status: string };

/** Colaboradores ativos, pra popular o select — não exige payroll:manage. */
export async function loadActiveEmployees(): Promise<EmployeeRow[]> {
  const database = await getD1();
  const result = await database
    .prepare(
      `SELECT id, full_name AS fullName, company_name AS companyName, status
       FROM hr_employees WHERE status='active' ORDER BY full_name ASC`,
    )
    .all<EmployeeRow>();
  return result.results ?? [];
}

export type TimeTrackingSettingsRow = {
  id: string;
  employeeId: string;
  dailyTargetMinutes: number;
  notes: string;
};

/** Jornada diária contratada vigente do colaborador (480min = 8h se não configurada). */
export async function loadDailyTargetMinutes(employeeId: string): Promise<number> {
  const database = await getD1();
  const row = await database
    .prepare(`SELECT daily_target_minutes AS dailyTargetMinutes FROM hr_time_tracking_settings WHERE employee_id=?1 LIMIT 1`)
    .bind(employeeId)
    .first<{ dailyTargetMinutes: number }>();
  return row ? row.dailyTargetMinutes : 480;
}
